/**
 * Tool: `subscription.request` — Sales Agent closes the loop after a devis.
 *
 * The Sales Agent calls this during the CLOSING phase of the playbook, once
 * its LLM has reasoned that the customer (a) accepted a previewed/sent quote
 * AND (b) provided their bank details for the prélèvement (IBAN + BIC +
 * titulaire du compte) plus their lieu de naissance. The tool does NOT decide
 * acceptance — the agent does; the tool only validates, persists and emits.
 *
 * Three side effects, in order:
 *
 *   1. Validate the IBAN (ISO 13616 mod-97 — Achraf: "verify the IBAN before
 *      filling") and persist the bank details ENCRYPTED on the customer row
 *      via `saveCustomerBankDetails` (same AES-256-GCM tier as phone/email).
 *      An invalid IBAN throws BEFORE any emit so the agent can re-ask the
 *      customer for the correct number — the error reference is masked.
 *   2. Emit QUOTE.ACCEPTED `{ quoteId }` — the canonical "customer said yes"
 *      transition the rest of the funnel (lead status, HubSpot mirror) keys
 *      off.
 *   3. Emit SUBSCRIPTION.REQUESTED → routed to the 'quote' queue → the Maxance
 *      Operator resumes the devis and drives the souscription. The bank
 *      details are NOT in this payload: it carries `bankRef: 'customer'` and
 *      the operator decrypts them from the DB at drive time (PII discipline,
 *      see intents/subscription.ts).
 *
 * PII boundary: this handler is the encryption boundary for the bank details.
 * The raw IBAN/BIC NEVER appear in logs, errors or the emitted payloads — any
 * IBAN that must surface in a log line goes through `maskIban` first.
 *
 * Failure modes:
 *   - Invalid IBAN / BIC / empty holder → throws a descriptive (masked) error
 *     synchronously; the LLM sees it and re-asks the customer. No emit.
 *   - Customer or quote not found → throws; the LLM apologizes + escalates.
 *   - sendMessage failure (Redis down) → bank details ARE persisted but the
 *     souscription is not queued. A human can replay from the operator UI;
 *     no plaintext leaked.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { registerTool } from '../registry.js';
import { customers, quotes } from '../../db/schema/index.js';
import { saveCustomerBankDetails } from '../../db/repositories/customers.js';
import { validateIban, normalizeIban, maskIban } from '../../lib/iban.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';

export const subscriptionRequestToolName = 'subscription.request';

const FormuleEnum = z.enum(['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents']);
const FractionnementEnum = z.enum(['mensuel', 'annuel']);

const inputSchema = z
  .object({
    /** The quote the customer accepted. FK to the `quotes` row. */
    quoteId: z.string().uuid(),
    /** Owner of the quote — the bank details land encrypted on this customer. */
    customerId: z.string().uuid(),
    /** Maxance devis reference to resume (e.g. "DR0000971882"). */
    devisNumber: z.string().min(1),
    /** IBAN — checksum-validated in-code (mod-97). Spaces/lowercase accepted. */
    iban: z.string().min(1),
    /** BIC / SWIFT — 8 or 11 alphanumerics (validated by the repository). */
    bic: z.string().min(1),
    /** Titulaire du compte. */
    accountHolder: z.string().min(1),
    /** Lieu de naissance — Ville ("Paris" fallback for foreign is decided upstream by the agent). */
    birthPlaceCity: z.string().min(1),
    /** Coverage tier the customer chose. */
    formule: FormuleEnum,
    /** Mensuel (default) or Annuel prélèvement. */
    fractionnement: FractionnementEnum,
  })
  .strict();

const outputSchema = z.object({
  quoteId: z.string().uuid(),
  queued: z.literal(true),
});

/**
 * Pure helper: build the SUBSCRIPTION.REQUESTED payload from the tool input.
 *
 * Extracted so the unit tests can pin the wire shape WITHOUT a DB or Redis,
 * and — critically — assert that NO bank detail (iban/bic/accountHolder) ever
 * leaks into the payload. The operator reads those from the encrypted row;
 * the `bankRef: 'customer'` literal documents that indirection.
 *
 * `leadId` is intentionally omitted (nullish in the schema) — the operator
 * correlates by quoteId/customerId, and the tool isn't handed a leadId.
 */
export function buildSubscriptionRequestedPayload(input: z.infer<typeof inputSchema>): {
  quoteId: string;
  customerId: string;
  devisNumber: string;
  formule: z.infer<typeof FormuleEnum>;
  fractionnement: z.infer<typeof FractionnementEnum>;
  birthPlaceCity: string;
  bankRef: 'customer';
} {
  return {
    quoteId: input.quoteId,
    customerId: input.customerId,
    devisNumber: input.devisNumber,
    formule: input.formule,
    fractionnement: input.fractionnement,
    birthPlaceCity: input.birthPlaceCity,
    bankRef: 'customer',
  };
}

registerTool({
  name: subscriptionRequestToolName,
  description:
    'Lance la souscription Maxance APRÈS que le client a accepté un devis ET ' +
    'fourni ses coordonnées bancaires de prélèvement. À utiliser SEULEMENT quand : ' +
    'le client a dit oui au devis, et a donné son IBAN, son BIC, le titulaire du ' +
    'compte et son lieu de naissance (ville). Paramètres : quoteId, customerId, ' +
    'devisNumber (réf du devis Maxance, ex. "DR0000971882"), iban, bic, accountHolder, ' +
    'birthPlaceCity, formule (tiers_illimite / vol_incendie / dommages_tous_accidents), ' +
    "fractionnement (mensuel / annuel). L'IBAN est vérifié (clé de contrôle) — un IBAN " +
    'invalide est refusé, redemandez-le alors au client. Le lien de paiement arrive ' +
    'ensuite par message SUBSCRIPTION.READY. NE communiquez JAMAIS au client le détail ' +
    'des frais de dossier brutalement — utilisez une reformulation conforme.',
  inputSchema,
  outputSchema,
  handler: async (ctx, input) => {
    // 1. Sanity-check customer + quote exist + the quote belongs to the
    //    customer. Protects against an LLM stitching together stale IDs.
    const [customer] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    if (!customer) throw new Error(`Customer ${input.customerId} not found`);

    const [quote] = await ctx.db
      .select({ id: quotes.id, customerId: quotes.customerId })
      .from(quotes)
      .where(eq(quotes.id, input.quoteId))
      .limit(1);
    if (!quote) throw new Error(`Quote ${input.quoteId} not found`);
    if (quote.customerId && quote.customerId !== input.customerId) {
      throw new Error(`Quote ${input.quoteId} belongs to a different customer than the one passed`);
    }

    // 2. Validate the IBAN at the boundary (mod-97). We do this here too (the
    //    repository re-checks) so the agent gets a clear, EARLY rejection it
    //    can act on — before any DB write or emit. Masked reference only.
    const normalizedIban = normalizeIban(input.iban);
    if (!validateIban(normalizedIban)) {
      throw new Error(
        `IBAN invalide (${maskIban(normalizedIban)}) — la clé de contrôle ne correspond pas. ` +
          'Veuillez redemander l’IBAN au client.',
      );
    }

    // 3. Persist the bank details ENCRYPTED on the customer row. The repository
    //    normalizes + re-validates IBAN/BIC and encrypts; plaintext never
    //    leaves this call. Throws (masked) on a bad BIC / empty holder.
    await saveCustomerBankDetails(ctx.db, input.customerId, {
      iban: normalizedIban,
      bic: input.bic,
      accountHolder: input.accountHolder,
      birthPlaceCity: input.birthPlaceCity,
    });

    // 4. Emit QUOTE.ACCEPTED — the canonical "customer said yes" transition.
    await sendMessage(
      { db: ctx.db },
      {
        fromRole: ctx.agentRole,
        fromInstance: ctx.agentInstance,
        toRole: 'maxance-operator',
        toInstance: 'singleton',
        intent: 'QUOTE.ACCEPTED',
        payload: { quoteId: input.quoteId },
        correlationId: ctx.correlationId ?? input.quoteId,
      },
    );

    // 5. Emit SUBSCRIPTION.REQUESTED → 'quote' queue → Maxance Operator. The
    //    payload carries bankRef:'customer' and NO bank detail; the operator
    //    decrypts the IBAN/BIC from the DB at drive time.
    const payload = buildSubscriptionRequestedPayload(input);
    await sendMessage(
      { db: ctx.db },
      {
        fromRole: ctx.agentRole,
        fromInstance: ctx.agentInstance,
        toRole: 'maxance-operator',
        toInstance: 'singleton',
        intent: 'SUBSCRIPTION.REQUESTED',
        payload,
        correlationId: ctx.correlationId ?? input.quoteId,
      },
    );

    // Audit log — MASKED IBAN only, never the raw value.
    logger.info(
      {
        quoteId: input.quoteId,
        customerId: input.customerId,
        devisNumber: input.devisNumber,
        formule: input.formule,
        fractionnement: input.fractionnement,
        ibanMasked: maskIban(normalizedIban),
        agentInstance: ctx.agentInstance,
      },
      'subscription.request: bank details persisted + QUOTE.ACCEPTED + SUBSCRIPTION.REQUESTED emitted',
    );

    return { quoteId: input.quoteId, queued: true as const };
  },
});
