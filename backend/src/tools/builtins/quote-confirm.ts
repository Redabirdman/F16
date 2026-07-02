/**
 * Tool: `quote.confirm` — Sales Agent turns a previewed quote into a REAL
 * Maxance devis, emailed to the customer (2026-07-02, Achraf's sales method).
 *
 * Until now nothing in the sales-agent could emit QUOTE.CONFIRM_REQUESTED —
 * the customer said "oui, envoyez le devis" and the LLM had no tool for it
 * (its only quote-ish tool was quote.request, which re-ran the whole preview
 * → the duplicate price messages Achraf saw on 2026-07-02). This closes that
 * gap.
 *
 * What it does:
 *   1. Sanity-check customer + lead exist and belong together.
 *   2. Assemble the Maxance Devis-tab subscriber block: identity fields the
 *      LLM gathered in conversation (civilité, adresse) + phone/email/name
 *      decrypted from the customer row as defaults. Missing required fields
 *      throw a descriptive error so the LLM asks the customer instead.
 *   3. Emit QUOTE.CONFIRM_REQUESTED → maxance-operator drives Valider devis
 *      → Devis form → Courrier staged send (inbox-relay delivery). The
 *      customer gets the PDF via WhatsApp + branded email; the agent gets
 *      QUOTE.READY back.
 *
 * Garanties additionnelles (Achraf's pack): pass `garantiesAdditionnelles`
 * to have the operator tick Assistance Mobilité / Garantie Personnelle du
 * Conducteur on the Garanties tab BEFORE Valider devis — the devis then
 * includes them.
 *
 * ⚠️ Pre-condition: the Maxance tab is still parked on THIS quote's
 * Garanties price preview (the preview flow leaves it there). Confirm right
 * after the customer picks; a new quote.request in between replaces the tab
 * state. For a two-devis comparison (with/without options), run
 * quote.request → quote.confirm TWICE — once per variant.
 *
 * PII boundary: the subscriber block (name/address/phone/email) travels in
 * the intent payload to the operator — same posture as the M8.T6 design
 * (intents/quote.ts documents the shape). Nothing is logged beyond IDs.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { registerTool } from '../registry.js';
import { customers, leads } from '../../db/schema/index.js';
import { decryptPII } from '../../db/crypto.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';

export const quoteConfirmToolName = 'quote.confirm';

const inputSchema = z
  .object({
    /** The previewed quote to confirm — the quoteId returned by quote.request. */
    quoteId: z.string().uuid(),
    customerId: z.string().uuid(),
    leadId: z.string().uuid(),
    /** Civilité — ask the customer ("Monsieur ou Madame ?") if unknown. */
    civilite: z.enum(['monsieur', 'madame']),
    /** Postal address of the subscriber — required on the Maxance Devis tab. */
    addressLine: z.string().min(1),
    addressComplement: z.string().optional(),
    postalCode: z.string().regex(/^\d{5}$/),
    city: z.string().min(1),
    /** Default from the customer row (decrypted) when omitted. */
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phoneMobile: z.string().min(6).optional(),
    profession: z
      .enum(['employe_prive', 'employe_public', 'etudiant', 'retraite', 'sans_profession'])
      .optional(),
    /**
     * Achraf's pack: tick the Garanties-additionnelles checkboxes so the
     * devis includes them. Omit for a bare-formule devis.
     */
    garantiesAdditionnelles: z
      .object({
        assistance: z.boolean().optional(),
        garantiePersonnelle: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

const outputSchema = z.object({
  quoteId: z.string().uuid(),
  queued: z.literal(true),
});

registerTool({
  name: quoteConfirmToolName,
  description:
    'Génère le devis Maxance OFFICIEL (PDF envoyé au client par WhatsApp + email) pour un ' +
    'devis déjà prévisualisé. À utiliser quand le client a choisi sa formule et veut recevoir ' +
    'le devis. Paramètres : quoteId (celui retourné par quote.request), customerId, leadId, ' +
    'civilite (monsieur/madame), addressLine + postalCode + city (adresse du client — la ' +
    'demander si inconnue), et en option garantiesAdditionnelles {assistance, garantiePersonnelle} ' +
    'pour inclure les options du pack sur le devis. Nom/email/téléphone sont repris ' +
    'automatiquement de la fiche client. Pour DEUX devis comparatifs (avec et sans options), ' +
    'enchaîner quote.request puis quote.confirm une fois PAR variante. NE PAS rappeler cet ' +
    "outil pour le même devis tant que la confirmation d'envoi n'est pas arrivée.",
  inputSchema,
  outputSchema,
  handler: async (ctx, input) => {
    // 1. Customer + lead sanity — protects against hallucinated IDs.
    const [customer] = await ctx.db
      .select()
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

    // 2. Assemble the subscriber block — explicit input wins, customer-row
    //    PII (decrypted) is the default. Throw with the LIST of missing
    //    fields so the LLM can ask the customer in one turn.
    const fullName = decryptPII(customer.fullName) ?? '';
    const [rowFirst, ...rowRest] = fullName.split(' ').filter(Boolean);
    const firstName = input.firstName ?? rowFirst ?? '';
    const lastName = input.lastName ?? rowRest.join(' ');
    const email = input.email ?? decryptPII(customer.email) ?? '';
    const phoneMobile = input.phoneMobile ?? decryptPII(customer.phone) ?? '';

    const missing: string[] = [];
    if (!firstName) missing.push('firstName (prénom)');
    if (!lastName) missing.push('lastName (nom)');
    if (!email) missing.push('email');
    if (!phoneMobile) missing.push('phoneMobile (téléphone portable)');
    if (missing.length > 0) {
      throw new Error(
        `Informations souscripteur manquantes pour le devis : ${missing.join(', ')}. ` +
          'Demande-les au client puis rappelle quote.confirm en les passant en paramètres.',
      );
    }

    const subscriber = {
      civilite: input.civilite,
      lastName,
      firstName,
      addressLine: input.addressLine,
      ...(input.addressComplement !== undefined
        ? { addressComplement: input.addressComplement }
        : {}),
      postalCode: input.postalCode,
      city: input.city,
      phoneMobile,
      email,
      ...(input.profession !== undefined ? { profession: input.profession } : {}),
    };

    // 3. Emit QUOTE.CONFIRM_REQUESTED — the maxance-operator drives the
    //    devis creation + courrier staged send from the parked Garanties tab.
    await sendMessage(
      { db: ctx.db },
      {
        fromRole: ctx.agentRole,
        fromInstance: ctx.agentInstance,
        toRole: 'maxance-operator',
        toInstance: 'singleton',
        intent: 'QUOTE.CONFIRM_REQUESTED',
        payload: {
          quoteId: input.quoteId,
          customerId: input.customerId,
          leadId: input.leadId,
          subscriber,
          ...(input.garantiesAdditionnelles !== undefined
            ? { garantiesAdditionnelles: input.garantiesAdditionnelles }
            : {}),
        },
        correlationId: input.quoteId,
      },
    );

    logger.info(
      {
        quoteId: input.quoteId,
        leadId: input.leadId,
        addOns: input.garantiesAdditionnelles ?? null,
      },
      'quote.confirm: QUOTE.CONFIRM_REQUESTED emitted',
    );

    return { quoteId: input.quoteId, queued: true as const };
  },
});
