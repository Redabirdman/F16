/**
 * Sales Agent — pure text helpers.
 *
 * Extracted from `agent.ts` so both the agent and the channel-agnostic reply
 * core (`reply-core.ts`) can import them WITHOUT a circular dependency. Under
 * ESM, `agent.ts → reply-core.ts → agent.ts` would otherwise risk these
 * helpers being `undefined` at call time depending on module load order (which
 * surfaced as a hung BullMQ worker on the second turn of a conversation).
 *
 * Both functions are pure / deterministic and covered by unit tests.
 */

/**
 * Format a plaintext JSONB column (vehicle / driver) into a single-line
 * summary string for the prompt context. Skips null/empty values so the
 * prompt stays terse.
 */
export function summarizeJson(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  if (entries.length === 0) return null;
  return entries
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}

/**
 * Strip common LLM wrapping artifacts from a draft reply so the customer
 * doesn't see them. Handles: fenced code blocks, leading "Réponse :" /
 * "Voici :" labels (French + English), wrapping straight or French guillemet
 * quotes.
 */
export function cleanLLMReply(raw: string): string {
  let s = raw.trim();
  // Strip ```...``` fences (with optional language tag) wrapping the message.
  s = s
    .replace(/^```(?:\w+)?\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  // Strip a leading "Réponse :" / "Voici :" / "Message :" label (FR + EN).
  s = s.replace(/^(R[ée]ponse|Voici|Message|Reply|Response)\s*[:.]\s*/i, '').trim();
  // Strip wrapping straight quotes or French guillemets when both ends match.
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith('«') && s.endsWith('»')) ||
    (s.startsWith('“') && s.endsWith('”'))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}
