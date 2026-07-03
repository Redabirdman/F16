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
import { desc, eq } from 'drizzle-orm';
import { registerTool } from '../registry.js';
import { customers, leads, quotes } from '../../db/schema/index.js';
import { decryptPII } from '../../db/crypto.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';

export const quoteConfirmToolName = 'quote.confirm';

/**
 * Maxance's phone widget only accepts FRENCH national format (0XXXXXXXXX) —
 * E.164 values bounce the Devis OK with the "Format du téléphone incorrect."
 * ALERTE (live 2026-07-03, Ridaa's screenshot: +212603576574 rejected, form
 * re-rendered, no DR). +33 numbers convert exactly; other country codes
 * (sim testers with Moroccan numbers) are coerced to 0 + last 9 digits so
 * the devis can be issued — the real contact stays intact in OUR CRM.
 */
export function normalizeFrPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (/^0\d{9}$/.test(digits)) return digits;
  const m = /^(?:\+|00)33(\d{9})$/.exec(digits);
  if (m?.[1]) return `0${m[1]}`;
  const tail = digits.replace(/\D/g, '').slice(-9);
  return tail.length === 9 ? `0${tail}` : digits;
}

const inputSchema = z
  .object({
    /**
     * The previewed quote to confirm. Accepts the full UUID, the 8-char
     * `(réf #xxxxxxxx)` prefix from the price message, or NOTHING — omitted
     * resolves to the lead's most recent quote, which is exactly the one
     * parked on the Maxance Garanties tab. Live 2026-07-03: the LLM only
     * sees the 8-char ref in rebuilt history (tool results aren't
     * persisted), so a strict-UUID schema made every confirm fail and the
     * model "recovered" by re-running quote.request in a loop.
     */
    quoteId: z.string().min(4).optional(),
    customerId: z.string().uuid(),
    leadId: z.string().uuid(),
    /**
     * Civilité + postal address — required on the Maxance Devis tab, but
     * OPTIONAL here: omitted fields default from the customer profile's
     * stored address (2026-07-03 — conversation history scrolls past the
     * turn where the customer gave them; the profile is the durable copy).
     * Provide them when the customer just said them; otherwise omit.
     */
    civilite: z.enum(['monsieur', 'madame']).optional(),
    addressLine: z.string().min(1).optional(),
    addressComplement: z.string().optional(),
    postalCode: z
      .string()
      .regex(/^\d{5}$/)
      .optional(),
    city: z.string().min(1).optional(),
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
    'le devis. Paramètres : quoteId FACULTATIF (omets-le pour utiliser le dernier devis du ' +
    'lead ; sinon la réf du message de tarifs, ex. "6f305dc4", suffit), customerId, leadId, ' +
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

    // 1b. Resolve the quote. The LLM usually only has the 8-char `(réf #…)`
    //     prefix (or nothing) — match it against the lead's recent quotes,
    //     newest first. The newest quote is also what the Maxance tab is
    //     parked on, so the no-input default is the correct one.
    const recentQuotes = await ctx.db
      .select({ id: quotes.id, customerId: quotes.customerId })
      .from(quotes)
      .where(eq(quotes.leadId, input.leadId))
      .orderBy(desc(quotes.requestedAt))
      .limit(10);
    const needle = (input.quoteId ?? '').replace(/^#/, '').toLowerCase();
    const resolved = needle
      ? recentQuotes.find((q) => q.id.toLowerCase().startsWith(needle))
      : recentQuotes[0];
    if (!resolved) {
      throw new Error(
        needle
          ? `Aucun devis récent de ce lead ne correspond à la référence "${needle}". ` +
              'Omets quoteId pour utiliser le dernier devis prévisualisé.'
          : `Aucun devis prévisualisé trouvé pour ce lead — appelle d'abord quote.request.`,
      );
    }
    if (resolved.customerId !== input.customerId) {
      throw new Error('Le devis résolu appartient à un autre client — vérifie leadId/customerId.');
    }
    const quoteId = resolved.id;

    // 2. Assemble the subscriber block — explicit input wins, customer-row
    //    PII (decrypted) is the default. The stored address is a free-shape
    //    encrypted JSON (customer.update_profile lets the LLM choose keys),
    //    so parse it tolerantly. Throw with the LIST of missing fields so
    //    the LLM can ask the customer in one turn.
    const fullName = decryptPII(customer.fullName) ?? '';
    const [rowFirst, ...rowRest] = fullName.split(' ').filter(Boolean);
    const firstName = input.firstName ?? rowFirst ?? '';
    const lastName = input.lastName ?? rowRest.join(' ');
    const email = input.email ?? decryptPII(customer.email) ?? '';
    const phoneRaw = input.phoneMobile ?? decryptPII(customer.phone) ?? '';
    const phoneMobile = phoneRaw ? normalizeFrPhone(phoneRaw) : '';

    let storedAddr: Record<string, unknown> = {};
    try {
      const plain = decryptPII(customer.address);
      if (plain && plain !== 'null') storedAddr = JSON.parse(plain) as Record<string, unknown>;
    } catch {
      /* tolerate malformed stored address — fields fall through to missing */
    }
    const addrStr = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = storedAddr[k];
        if (typeof v === 'string' && v.trim().length > 0) return v.trim();
      }
      return undefined;
    };
    const civiliteStored = addrStr('civilite', 'civilité');
    const civilite =
      input.civilite ??
      (civiliteStored && /^m(r|onsieur)?\.?$/i.test(civiliteStored)
        ? 'monsieur'
        : civiliteStored && /^m(me|adame)\.?$/i.test(civiliteStored)
          ? 'madame'
          : undefined);
    const addressLine =
      input.addressLine ?? addrStr('line1', 'addressLine', 'street', 'rue', 'adresse');
    const postalCode = input.postalCode ?? addrStr('postalCode', 'codePostal', 'zip', 'cp');
    const city = input.city ?? addrStr('city', 'ville');

    const missing: string[] = [];
    if (!firstName) missing.push('firstName (prénom)');
    if (!lastName) missing.push('lastName (nom)');
    if (!email) missing.push('email');
    if (!phoneMobile) missing.push('phoneMobile (téléphone portable)');
    if (!civilite) missing.push('civilite (monsieur/madame)');
    if (!addressLine) missing.push('addressLine (adresse)');
    if (!postalCode || !/^\d{5}$/.test(postalCode)) missing.push('postalCode (5 chiffres)');
    if (!city) missing.push('city (ville)');
    if (missing.length > 0) {
      throw new Error(
        `Informations souscripteur manquantes pour le devis : ${missing.join(', ')}. ` +
          'Demande-les au client puis rappelle quote.confirm en les passant en paramètres.',
      );
    }

    const subscriber = {
      civilite: civilite as 'monsieur' | 'madame',
      lastName,
      firstName,
      addressLine: addressLine as string,
      ...(input.addressComplement !== undefined
        ? { addressComplement: input.addressComplement }
        : {}),
      postalCode: postalCode as string,
      city: city as string,
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
          quoteId,
          customerId: input.customerId,
          leadId: input.leadId,
          subscriber,
          ...(input.garantiesAdditionnelles !== undefined
            ? { garantiesAdditionnelles: input.garantiesAdditionnelles }
            : {}),
        },
        correlationId: quoteId,
      },
    );

    logger.info(
      {
        quoteId,
        leadId: input.leadId,
        addOns: input.garantiesAdditionnelles ?? null,
      },
      'quote.confirm: QUOTE.CONFIRM_REQUESTED emitted',
    );

    return { quoteId, queued: true as const };
  },
});
