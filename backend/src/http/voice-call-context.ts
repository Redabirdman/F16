/**
 * Per-call context block for the OpenAI Realtime voice session (2026-07-10).
 *
 * The persona (voice-persona.ts / admin key `voice.persona`) is generic and
 * inbound-flavored ("en quoi puis-je vous aider ?"). But every IDENTIFIED call
 * is one WE placed — a form-callback lead or an in-conversation "rappelez-moi".
 * Live 2026-07-10: the bot greeted a form lead as a cold inbound caller and
 * re-asked everything the form already answered.
 *
 * This module builds a French context block APPENDED to whatever instructions
 * resolve (so it composes with admin-edited personas): who the customer is,
 * what they asked for, the form facts they already gave, and the outbound
 * framing for the opening line.
 *
 * Contract: NEVER throws, never blocks the accept — any lookup failure returns
 * '' and the call proceeds on the generic persona. PII goes into the prompt
 * (that is its purpose) but is never logged.
 */
import { eq, desc } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { leads } from '../db/schema/index.js';
import { getCustomerById } from '../db/repositories/customers.js';
import { listTurns } from '../db/repositories/conversation-turns.js';
import { logger } from '../logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRODUCT_LABELS_FR: Record<string, string> = {
  scooter: 'trottinette électrique',
  car: 'auto',
};

const TIME_LABELS_FR: Record<string, string> = {
  maintenant: 'maintenant',
  matin: 'le matin',
  apres_midi: "l'après-midi",
  soir: 'le soir',
};

/** Form-answer keys we surface (leads.raw_payload merges the sim/Meta form). */
const FORM_FACTS: Array<{ key: string; label: string; suffix?: string }> = [
  { key: 'purchasePriceEur', label: "prix d'achat", suffix: ' €' },
  { key: 'purchaseDate', label: 'achetée le' },
  { key: 'postalCode', label: 'code postal' },
  { key: 'city', label: 'ville' },
  { key: 'stationnement', label: 'stationnement la nuit' },
  { key: 'dateOfBirth', label: 'date de naissance' },
];

export interface VoiceCallIdentity {
  customerId: string;
  leadId?: string | undefined;
}

/**
 * Build the per-call context block, or '' when nothing useful resolves.
 * Appended verbatim to the session instructions by the openai-sip accept path.
 */
export async function buildVoiceCallContext(db: Database, ids: VoiceCallIdentity): Promise<string> {
  try {
    const customer = await getCustomerById(db, ids.customerId);
    if (!customer) return '';

    // Lead: prefer the session's leadId (the callback scheduler correlates on
    // it); fall back to the customer's newest lead (voice-operator falls back
    // to customerId when no correlation rode the envelope).
    let lead =
      ids.leadId && UUID_RE.test(ids.leadId)
        ? (await db.select().from(leads).where(eq(leads.id, ids.leadId)).limit(1))[0]
        : undefined;
    if (!lead) {
      lead = (
        await db
          .select()
          .from(leads)
          .where(eq(leads.customerId, ids.customerId))
          .orderBy(desc(leads.createdAt))
          .limit(1)
      )[0];
    }

    const lines: string[] = [];
    const fullName = customer.fullName?.trim();
    const firstName = fullName ? (fullName.split(' ')[0] ?? '') : '';
    const product = lead?.productLine ? (PRODUCT_LABELS_FR[lead.productLine] ?? null) : null;

    lines.push('');
    lines.push('');
    lines.push('# CONTEXTE DE CET APPEL (données réelles — utilise-les, ne les redemande pas)');
    lines.push(
      "C'EST TOI QUI APPELLES : ce client a demandé à être rappelé par Assuryal " +
        "(formulaire ou conversation). Ce n'est PAS lui qui appelle — ne dis pas " +
        '« en quoi puis-je vous aider ? » comme à un appel entrant. Ouvre plutôt ainsi : ' +
        `« Bonjour${firstName ? `, ${firstName}` : ''} ? C'est Assuryal — cet appel peut être ` +
        'enregistré pour la qualité. Vous avez demandé à être rappelé' +
        (product ? ` au sujet d'une assurance ${product}` : '') +
        ', je vous appelle pour ça. » Puis enchaîne directement sur la qualification.',
    );
    if (fullName) {
      const civ = customer.civility ? `${customer.civility} ` : '';
      lines.push(`- Client : ${civ}${fullName}`);
    }
    if (product) lines.push(`- Produit demandé : ${product}`);
    const time = lead?.preferredTime ? TIME_LABELS_FR[lead.preferredTime] : undefined;
    if (time) lines.push(`- Créneau souhaité : ${time}`);

    // Form facts already provided — the qualification must not re-ask them.
    const raw = (lead?.rawPayload ?? null) as Record<string, unknown> | null;
    if (raw) {
      const facts = FORM_FACTS.filter(
        (f) => raw[f.key] !== undefined && raw[f.key] !== null && raw[f.key] !== '',
      ).map((f) => `${f.label} ${String(raw[f.key])}${f.suffix ?? ''}`);
      if (facts.length > 0) {
        lines.push(
          `- Infos déjà données au formulaire : ${facts.join(', ')} — considère-les comme ` +
            'acquises pour demander_devis, ne les redemande pas (confirme-les au plus).',
        );
      }
    }

    // Prior conversation: a lead we've already chatted with should not be
    // greeted as a stranger.
    try {
      const turns = await listTurns(db, { customerId: ids.customerId, limit: 6 });
      const lastInbound = turns.find((t) => t.direction === 'inbound');
      if (lastInbound?.content) {
        lines.push(
          '- Vous avez déjà échangé avec ce client (WhatsApp/email). Son dernier message : ' +
            `« ${lastInbound.content.slice(0, 160)} »`,
        );
      }
    } catch {
      // history is a bonus — never block the block
    }

    return lines.join('\n');
  } catch (err) {
    logger.warn(
      { customerId: ids.customerId, err: err instanceof Error ? err.message : String(err) },
      'voice-call-context: build failed — proceeding with the generic persona',
    );
    return '';
  }
}
