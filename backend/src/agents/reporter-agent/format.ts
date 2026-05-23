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
  const lines = options.map(
    (o, i) => `${i + 1}. ${o.label}${o.kind === 'custom' ? '' : ` (${o.kind})`}`,
  );
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
  const header = `${sev.glyph} *${sev.label}* — ${action.intent}`;
  const summary = action.summary;
  const optionsBlock = formatOptionsBlock(action.options as readonly HumanActionOption[]);
  const correlation = action.correlationId ? `Réf : ${action.correlationId}` : null;
  const footer = `ID : ${action.id}`;

  return [
    header,
    '',
    summary,
    ...(optionsBlock ? ['', optionsBlock] : []),
    '',
    ...(correlation ? [correlation] : []),
    footer,
  ]
    .filter((s) => s !== null)
    .join('\n');
}

/**
 * Build the closure message posted to the same group when a HUMAN_ACTION
 * is resolved (admin UI or WhatsApp — either source).
 */
export function formatHumanActionResolved(input: {
  humanActionId: string;
  choice: string;
  source: 'admin' | 'whatsapp';
}): string {
  const sourceLabel = input.source === 'admin' ? 'admin' : 'WhatsApp';
  return `✅ Action ${input.humanActionId} clôturée via ${sourceLabel} — choix : *${input.choice}*`;
}
