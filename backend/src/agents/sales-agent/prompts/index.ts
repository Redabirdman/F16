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
import { BRAND_VOICE_FRAGMENT } from './brand.js';
import { PRODUCTS_FRAGMENT } from './products.js';
import { PLAYBOOK_FRAGMENT } from './playbook.js';
import { GUARDRAILS_FRAGMENT } from './guardrails.js';

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
  lines.push(`Le client est joint sur **${ctx.channel}**. Adapte la longueur en conséquence.`);
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
