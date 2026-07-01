/**
 * Sales Agent — System prompt composer (M6.T2).
 *
 * Four cached fragments (brand → products → playbook → guardrails) form the
 * stable prefix; one per-turn fragment (customer state, lead state, recent
 * turns, recalled facts, channel hint) follows without `cache_control`.
 *
 * `buildSalesAgentSystemPrompt` is the entry point M6.T3 will call from the
 * `BaseAgent.onMessage` loop. It is intentionally pure — same input, same
 * output — so the prompt cache hits reliably across turns.
 */
import type { SystemFragment } from '../../../llm/cache.js';
import type { Database } from '../../../db/index.js';
import type { QualificationState } from '../qualification.js';
import { registerPrompt, resolvePrompt } from '../../../prompts/registry.js';
import { BRAND_VOICE_FRAGMENT } from './brand.js';
import { PRODUCTS_FRAGMENT } from './products.js';
import { PLAYBOOK_FRAGMENT } from './playbook.js';
import { GUARDRAILS_FRAGMENT } from './guardrails.js';

/** M14.T6 — the editable stable prefix (brand + products + playbook + guardrails). */
const SALES_SYSTEM_KEY = 'sales-agent.system';
function salesStableDefault(): string {
  return [BRAND_VOICE_FRAGMENT, PRODUCTS_FRAGMENT, PLAYBOOK_FRAGMENT, GUARDRAILS_FRAGMENT]
    .map((f) => f.text)
    .join('\n\n');
}
registerPrompt({
  key: SALES_SYSTEM_KEY,
  label: 'Sales Agent — prompt système',
  agentRole: 'sales-agent',
  description:
    'Voix de marque + produits + playbook + garde-fous du Sales Agent (WhatsApp/email/SMS). ' +
    'Le contexte de chaque tour (client, lead, historique, canal) est ajouté automatiquement APRÈS.',
  getDefault: salesStableDefault,
});

/**
 * M14.T6 — resolve the editable stable prefix (override-aware) + append the
 * per-turn context. Use this from the runtime path; `buildSalesAgentSystemPrompt`
 * stays as the pure/default builder.
 */
export async function buildSalesAgentSystemFragments(
  db: Database,
  ctx: SalesAgentTurnContext,
): Promise<SystemFragment[]> {
  const stable = await resolvePrompt(db, SALES_SYSTEM_KEY, salesStableDefault);
  return [{ cache: true, text: stable }, buildTurnContextFragment(ctx)];
}

/** Per-turn context handed to the prompt — DO NOT cache (varies per turn). */
export interface SalesAgentTurnContext {
  customer: {
    id: string;
    fullName: string | null;
    civility: string | null; // e.g. 'Monsieur', 'Madame'
    productLine: 'scooter' | 'car';
    vehicleSummary: string | null; // pre-formatted by caller
    driverSummary: string | null;
  };
  lead: {
    id: string;
    source: 'website' | 'meta' | 'organic' | 'referral' | 'other';
    status: string;
    score: number | null;
    quoteState: 'none' | 'requested' | 'ready' | 'sent' | 'accepted' | 'rejected';
  };
  recentTurns: Array<{
    direction: 'inbound' | 'outbound';
    channel: string;
    content: string;
    at: Date;
  }>;
  /** Optional: facts the memory layer surfaced as relevant ("client a déjà refusé voiture Sept 2024"). */
  recalledFacts?: string[];
  /**
   * Progressive quote qualification (trottinette V1) — the fields collected so
   * far, maintained by the qualification extractor. Rendered as a ✓/✗ checklist
   * so the agent asks only for missing fields and never re-asks.
   */
  qualification?: QualificationState;
  /** Optional: opening suggested by Lead Scorer on LEAD.SCORED (first turn only). */
  suggestedOpening?: string;
  /** Channel of THIS turn (so the model knows whether to write WhatsApp-short or email-long). */
  channel: 'whatsapp' | 'voice' | 'email' | 'sms';
}

/** Build the per-turn fragment — NOT cached, varies every call. */
export function buildTurnContextFragment(ctx: SalesAgentTurnContext): SystemFragment {
  const lines: string[] = [];
  lines.push('# Contexte de cette conversation');
  lines.push('');
  lines.push('## Client');
  if (ctx.customer.civility) lines.push(`- Civilité : ${ctx.customer.civility}`);
  if (ctx.customer.fullName) lines.push(`- Nom : ${ctx.customer.fullName}`);
  lines.push(`- Produit visé : ${ctx.customer.productLine === 'scooter' ? 'trottinette' : 'auto'}`);
  if (ctx.customer.vehicleSummary) lines.push(`- Véhicule : ${ctx.customer.vehicleSummary}`);
  if (ctx.customer.driverSummary) lines.push(`- Conducteur : ${ctx.customer.driverSummary}`);
  lines.push('');
  lines.push('## Lead');
  lines.push(`- Source : ${ctx.lead.source}`);
  lines.push(`- Statut : ${ctx.lead.status}`);
  if (ctx.lead.score !== null) lines.push(`- Score : ${ctx.lead.score}/100`);
  lines.push(`- Devis : ${ctx.lead.quoteState}`);
  lines.push('');
  // Progressive qualification checklist (trottinette V1). The single most
  // reliable guard against re-asking answered questions: the agent sees exactly
  // what's already collected (✓) vs still needed (✗) and asks only for gaps.
  if (ctx.customer.productLine === 'scooter') {
    const q = ctx.qualification ?? {};
    const rows: Array<[string, string | undefined]> = [
      ["Prix d'achat", q.purchasePriceEur !== undefined ? `${q.purchasePriceEur} €` : undefined],
      ["Date d'achat", q.purchaseDate],
      ['Code postal', q.postalCode],
      ['Date de naissance', q.clientDateOfBirth],
      ['Stationnement la nuit', q.stationnement],
    ];
    lines.push('## État de la qualification (devis trottinette)');
    lines.push(
      'Les champs ✓ sont DÉJÀ collectés — ne les redemande JAMAIS. Demande UNIQUEMENT les champs ✗, un seul à la fois. ' +
        'Quand les 5 sont ✓, appelle `quote.request` (les identifiants client/lead sont injectés automatiquement — ne les demande pas).',
    );
    for (const [label, value] of rows) {
      lines.push(value ? `- ✓ ${label} : ${value}` : `- ✗ ${label} : à demander`);
    }
    lines.push('');
  }
  if (ctx.recalledFacts && ctx.recalledFacts.length > 0) {
    lines.push('## Faits mémorisés sur ce client');
    for (const f of ctx.recalledFacts) lines.push(`- ${f}`);
    lines.push('');
  }
  if (ctx.recentTurns.length > 0) {
    lines.push('## Échanges récents');
    for (const t of ctx.recentTurns) {
      const tag = t.direction === 'inbound' ? '[CLIENT]' : '[ASSURYAL]';
      lines.push(`- ${tag} (${t.channel}, ${t.at.toISOString()}): ${t.content}`);
    }
    lines.push('');
  }
  if (ctx.suggestedOpening) {
    lines.push("## Suggestion d'ouverture (du Lead Scorer)");
    lines.push(ctx.suggestedOpening);
    lines.push('');
  }
  lines.push(`## Canal de cette réponse`);
  if (ctx.channel === 'voice') {
    // The caller is on a live phone line waiting in silence; long replies feel
    // slow + robotic and take many seconds to speak. Force a single short,
    // natural spoken sentence with at most one question.
    lines.push(
      'Le client est AU TÉLÉPHONE, en direct (synthèse vocale). Règle ABSOLUE : réponds ' +
        'en UNE phrase TRÈS courte, parlée, de 12 mots MAXIMUM. Pose UNE seule question ' +
        'directe, rien d’autre. PAS de préambule ("Parfait, merci", "D’accord"...), PAS ' +
        'de reformulation de ce que le client vient de dire, PAS de listes. Chaque mot ' +
        'compte : le client attend en silence et toute parole en trop ralentit l’appel. ' +
        'Exemple de bon ton : « Et à quelle date l’avez-vous achetée ? ». Pour un prix, ' +
        'donne juste le chiffre clé.',
    );
  } else {
    lines.push(`Le client est joint sur **${ctx.channel}**. Adapte la longueur en conséquence.`);
  }
  lines.push('');
  lines.push('## Ta tâche pour ce tour');
  lines.push(
    'Rédige ta prochaine réponse au client. UN SEUL message, en français. Ne préfixe pas ta réponse (pas de "Réponse :" / "Voici"). Ne renvoie QUE le texte du message.',
  );
  return { cache: false, text: lines.join('\n') };
}

/**
 * Build the full system prompt fragments for one Sales Agent call.
 * Cache breakpoint lands on the last cached fragment (guardrails) — the four
 * stable fragments are part of the cached prefix; per-turn context follows
 * without cache_control.
 */
export function buildSalesAgentSystemPrompt(ctx: SalesAgentTurnContext): SystemFragment[] {
  return [
    BRAND_VOICE_FRAGMENT,
    PRODUCTS_FRAGMENT,
    PLAYBOOK_FRAGMENT,
    GUARDRAILS_FRAGMENT,
    buildTurnContextFragment(ctx),
  ];
}

export { BRAND_VOICE_FRAGMENT, PRODUCTS_FRAGMENT, PLAYBOOK_FRAGMENT, GUARDRAILS_FRAGMENT };
