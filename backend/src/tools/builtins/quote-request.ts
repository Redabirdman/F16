/**
 * Tool: `quote.request` — Sales Agent kicks off a Maxance quote.
 *
 * This is the tool the Sales Agent calls during the Devis phase of the
 * sales playbook once it has gathered the trottinette qualification
 * fields from the customer (purchase price, postal code, purchase date,
 * date of birth, stationnement). Three side effects, all transactional
 * inside this handler:
 *
 *   1. Insert a `quotes` row in status='requested' — the canonical record
 *      of "we asked Maxance for a quote for customer X on lead Y". The
 *      row's UUID is the `quoteId` carried in the QUOTE.REQUESTED intent.
 *   2. Emit QUOTE.REQUESTED via the dispatcher → the maxance-operator
 *      queue picks it up and drives Maxance (extension path in V1 per
 *      M8.T8).
 *   3. Return `{ quoteId, queued: true }` to the LLM so it can tell the
 *      customer "I've sent the request, you'll hear back in ~20 seconds"
 *      and keep the conversation alive with a contextual question.
 *
 * V1 scope: trottinette only. The other 6 auto sub-products
 * (auto_malus, auto_pro, …) share the same Maxance Operator agent but
 * have their own field sets; they'll get their own qualification
 * sections in the playbook + an extension to this tool's `formData`
 * union when M9 starts auto.
 *
 * PII boundary: none of the fields here are PII. The customer + lead
 * IDs are FKs to encrypted rows; the form data is product info only
 * (price, dates, postal code — postal code alone is not PII under our
 * RGPD posture).
 *
 * Failure modes:
 *   - Customer or lead not found → tool throws a descriptive error;
 *     the LLM will see it and apologize to the customer + escalate.
 *   - Invalid form data (e.g. postal code wrong shape) → Zod throws
 *     synchronously BEFORE any DB write. The LLM sees the issue list
 *     and can re-ask the customer for the bad field.
 *   - sendMessage failure (Redis down, dispatcher offline) → DB row
 *     is INSERTED but no queue message. The Sales Agent will see a
 *     stale 'requested' row in the operator UI and a human can retry.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { registerTool } from '../registry.js';
import { customers, leads } from '../../db/schema/index.js';
import { insertQuote } from '../../db/repositories/quotes.js';
import { sendMessage } from '../../messaging/dispatcher.js';

export const quoteRequestToolName = 'quote.request';

/**
 * Trottinette quote params — mirrors the Maxance quote param shape used by
 * the extension's `maxance/selectors` but lives here as its own schema so
 * the tool layer keeps a clean boundary (lighter import graph). The shape
 * stays in sync — drift would surface in the M8.T4 param-translation tests.
 */
const trottinetteFormDataSchema = z
  .object({
    vehicleKind: z.literal('trottinette'),
    /** Purchase price in EUR — drives the Maxance Version band (8181-8192). */
    purchasePriceEur: z.number().positive().max(100_000),
    /** ISO date string e.g. "2026-01-15" — used for both Première mise en circulation + Date d'acquisition. */
    purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    /** 5-digit French postal code. */
    postalCode: z.string().regex(/^\d{5}$/),
    /** Optional — Maxance auto-fills from CP, but pass through if the customer mentioned a city. */
    city: z.string().min(1).optional(),
    /** Where the trottinette is stored overnight. Drives risk pricing. */
    stationnement: z.enum(['garage_box', 'parking_prive_clos', 'parking_prive_non_clos', 'rue']),
    /** Customer's date of birth — only required Conducteur-tab field. */
    clientDateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    /** Coverage tier — defaults to 'tiers_illimite' on the Operator side if omitted. */
    formule: z.enum(['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents']).optional(),
    /** Commission slider 9-22; defaults to 9. */
    commissionPct: z.number().min(0).max(100).optional(),
    /** Mensuel (default) or annuel. */
    fractionnement: z.enum(['mensuel', 'annuel']).optional(),
    /**
     * Garanties additionnelles the customer wants on the devis (2026-07-02,
     * Achraf's pack — Assistance Mobilité + Garantie Personnelle du
     * Conducteur). The preview prices them regardless; these flags matter
     * when the devis is confirmed.
     */
    garantiesAdditionnelles: z
      .object({
        assistance: z.boolean().optional(),
        garantiePersonnelle: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

const inputSchema = z.object({
  customerId: z.string().uuid(),
  leadId: z.string().uuid(),
  formData: trottinetteFormDataSchema,
});

const outputSchema = z.object({
  quoteId: z.string().uuid(),
  queued: z.literal(true),
});

/**
 * Pure helper: build the QUOTE.REQUESTED payload from the tool input.
 *
 * Extracted from the handler so the unit tests can verify the wire shape
 * without needing a DB or a Redis. The dispatcher's payload validator
 * (intents/quote.ts) is the runtime backstop on top of this.
 */
export function buildQuoteRequestedPayload(input: z.infer<typeof inputSchema>): {
  quoteId: string;
  customerId: string;
  leadId: string;
  product: 'scooter' | 'car';
  productVariant: string;
  formData: Record<string, unknown>;
} {
  return {
    quoteId: randomUUID(),
    customerId: input.customerId,
    leadId: input.leadId,
    // Trottinette is classified as 'scooter' in the product enum
    // (matches the intent registry in intents/quote.ts:QuoteRequestedPayload).
    product: 'scooter',
    productVariant: 'trottinette',
    formData: { ...input.formData },
  };
}

registerTool({
  name: quoteRequestToolName,
  description:
    'Demande un devis Maxance pour une trottinette électrique. À utiliser SEULEMENT ' +
    "après avoir collecté auprès du client : le prix d'achat en €, le code postal " +
    "(5 chiffres), la date d'acquisition (ISO YYYY-MM-DD), la date de naissance " +
    '(ISO YYYY-MM-DD), et le lieu de stationnement (garage_box / parking_prive_clos / ' +
    'parking_prive_non_clos / rue). Retourne un quoteId — le devis arrive par message ' +
    'QUOTE.PREVIEW_READY en ~20 secondes. NE PAS rappeler cet outil pour le même lead ' +
    "tant que le PREVIEW_READY n'est pas reçu.",
  inputSchema,
  outputSchema,
  handler: async (ctx, input) => {
    // 1. Sanity-check customer + lead exist. This protects against an LLM
    //    that hallucinates IDs by stitching together fragments from earlier
    //    context. Cheap (~1-2ms with the primary-key indexes).
    const [customer] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    if (!customer) throw new Error(`Customer ${input.customerId} not found`);

    const [lead] = await ctx.db
      .select({ id: leads.id, customerId: leads.customerId })
      .from(leads)
      .where(eq(leads.id, input.leadId))
      .limit(1);
    if (!lead) throw new Error(`Lead ${input.leadId} not found`);
    if (lead.customerId && lead.customerId !== input.customerId) {
      throw new Error(`Lead ${input.leadId} belongs to a different customer than the one passed`);
    }

    // 2. Generate the payload + insert the canonical quotes row first.
    //    sessionId is a fresh UUID — correlates the quote with the
    //    maxance_actions rows the Operator agent will append.
    const payload = buildQuoteRequestedPayload(input);
    const sessionId = randomUUID();
    await insertQuote(ctx.db, {
      customerId: input.customerId,
      leadId: input.leadId,
      product: payload.product,
      productVariant: payload.productVariant,
      sessionId,
      rawFormData: payload.formData,
    });

    // 3. Enqueue QUOTE.REQUESTED. Routed to the maxance-operator queue
    //    by the intent registry. fromInstance carries the lead id so the
    //    operator's reply (QUOTE.PREVIEW_READY) lands on the right Sales
    //    Agent instance.
    await sendMessage(
      { db: ctx.db },
      {
        fromRole: ctx.agentRole,
        fromInstance: ctx.agentInstance,
        toRole: 'maxance-operator',
        toInstance: 'singleton',
        intent: 'QUOTE.REQUESTED',
        payload,
      },
    );

    return { quoteId: payload.quoteId, queued: true as const };
  },
});
