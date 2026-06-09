/**
 * Reporter Agent — pure message formatters for the WhatsApp group thread
 * (option G).
 *
 * Separated from `agent.ts` so the message shape can be unit-tested without
 * spinning up a WAHA client or DB. The agent class composes these strings
 * and hands them to WahaClient.sendText.
 *
 * Style notes (per project_human_action_channel.md):
 *   - All messages in French — Ridaa + Achraf operate in French.
 *   - Numbered-options pattern as the always-on fallback for WAHA clients
 *     that don't render interactive buttons (e.g. WhatsApp Web from a
 *     phone). Reply "1" / "2" resolves.
 *   - Action ID always included so a parsing pass (follow-up) can route
 *     the reply back even if the message threading breaks.
 *   - Severity emoji at the front for quick triage: 🔴 critical / 🟡
 *     standard / 🟢 info.
 */
import type { HumanAction, HumanActionOption } from '../../db/schema/agent-runtime.js';

/**
 * Human-readable French labels for the machine intent codes. The operator
 * group should never see raw enum strings like `LEAD_DORMANT`. Unknown intents
 * fall back to the raw code (so a new intent is still shown, just less pretty —
 * add it here when you introduce one).
 */
const INTENT_LABELS_FR: Record<string, string> = {
  LEAD_DORMANT: 'Lead en sommeil',
  CAMPAIGN_LAUNCH_FAILED: 'Lancement de campagne échoué',
  CAMPAIGN_DRAFT: 'Brouillon de campagne à valider',
  CAMPAIGN_FATIGUE: 'Fatigue créative détectée',
  COMPLIANCE_BLOCKED: 'Message bloqué (conformité)',
  QUOTE_FAILED: 'Échec du devis',
  CONFIG_CHANGE_PROPOSED: 'Changement de configuration proposé',
  AGENT_LOOP_DETECTED: 'Boucle d’agents détectée',
};

/** Map a machine intent code to its French label (falls back to the raw code). */
export function intentLabel(intent: string): string {
  return INTENT_LABELS_FR[intent] ?? intent;
}

/** One-char severity glyph + label for the message header. */
export function severityBadge(severity: 1 | 2 | 3): { glyph: string; label: string } {
  switch (severity) {
    case 1:
      return { glyph: '🔴', label: 'CRITIQUE' };
    case 2:
      return { glyph: '🟡', label: 'À VALIDER' };
    case 3:
      return { glyph: '🟢', label: 'INFO' };
  }
}

/**
 * Render the numbered options block. Options are 1-indexed for the human;
 * the agent stores the original id in the row so resolution can map the
 * numeric reply back to the canonical option.
 *
 * Returns null when there are no options (info-only messages — severity 3
 * sometimes ships without any actionable choices).
 */
export function formatOptionsBlock(options: readonly HumanActionOption[]): string | null {
  if (options.length === 0) return null;
  // Render ONLY the human label — never the internal `kind` (e.g. "(approve)").
  // The kind is a routing detail; showing it confused operators (a list could
  // even show "(approve)" twice). The reply is matched by number / by the
  // option label, so the kind never needs to be visible.
  const lines = options.map((o, i) => `${i + 1}. ${o.label}`);
  return `Réponds avec le numéro :\n${lines.join('\n')}`;
}

/**
 * Build the WhatsApp message body for a HUMAN_ACTION.REQUESTED event.
 *
 * Two-section layout (badge header + summary + options + footer with the
 * action id). All in one text block — WAHA's sendText takes a single
 * string. Multi-line uses `\n` which WhatsApp renders as soft line breaks.
 */
export function formatHumanActionRequest(action: HumanAction): string {
  const sev = severityBadge(action.severity as 1 | 2 | 3);
  const header = `${sev.glyph} *${sev.label}* — ${intentLabel(action.intent)}`;
  const summary = action.summary;
  const optionsBlock = formatOptionsBlock(action.options as readonly HumanActionOption[]);
  // ONE technical reference at the very bottom: the action id. It's needed so a
  // reply can be routed to the right action when several are pending (the
  // inbound parser matches a UUID in the reply). We deliberately DROP the
  // former "Réf : <correlationId>" (the lead/campaign id) line — it was a
  // second, confusing UUID AND a routing hazard: the parser grabs the FIRST
  // UUID in a quoted reply, so the lead id would shadow the action id.
  const footer = `ID : ${action.id}`;

  return [header, '', summary, ...(optionsBlock ? ['', optionsBlock] : []), '', footer].join('\n');
}

/**
 * Build the closure message posted to the same group when a HUMAN_ACTION
 * is resolved (admin UI or WhatsApp — either source).
 *
 * Human-readable: the French intent label + the chosen option's LABEL + the
 * source. No UUID, no raw `kind` ("approve") — the operator sees "Validé via
 * l'admin : Reprendre contact manuellement", not "Action <uuid> … choix:
 * approve".
 */
export function formatHumanActionResolved(input: {
  intent: string;
  optionLabel: string;
  kind: HumanActionOption['kind'];
  source: 'admin' | 'whatsapp';
}): string {
  const sourceLabel = input.source === 'admin' ? "l'admin" : 'WhatsApp';
  const verb =
    input.kind === 'reject' ? 'Refusé' : input.kind === 'revise' ? 'À réviser' : 'Validé';
  return `✅ ${intentLabel(input.intent)} — ${verb} via ${sourceLabel} : *${input.optionLabel}*`;
}
