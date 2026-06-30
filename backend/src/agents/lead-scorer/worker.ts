/**
 * Lead Scorer worker — M5.T3.
 *
 * Consumes `LEAD.NEW` messages addressed to the `lead-scorer` role, runs a
 * Haiku LLM call against the cached French scoring rubric, validates the
 * JSON output, persists score + status on the lead row, and emits a
 * `LEAD.SCORED` agent message addressed to the Sales Agent instance for
 * that lead (`sales-agent` / `lead-<id>`). M5.T4 will spawn that instance;
 * the message will sit in the durable queue until then.
 *
 * Idempotency:
 *   A lead with `leads.score != null` is considered already scored. The
 *   handler short-circuits — no LLM call, no second `LEAD.SCORED` row. This
 *   matches the M5.T2 dual-write worker's `hubspot_deal_id` anchor pattern.
 *
 * Resilience:
 *   - If the LLM returns malformed JSON, we fall back to a deterministic
 *     heuristic (`heuristicScore`) so a single LLM hiccup never strands a
 *     lead. The lead is still scored, just less smartly.
 *   - If the LLM throws (network error, rate limit, …) we return `{ok:false}`
 *     so the dispatcher writes the error to `agent_messages.error` and
 *     BullMQ retries per its policy. We do NOT fall back to the heuristic
 *     for hard errors — those deserve a retry and visibility, not a silent
 *     downgrade.
 *
 * PII discipline:
 *   - The user prompt carries decrypted name/email/phone INTO the LLM, but
 *     we never log those fields at any level. Logs key on leadId + score +
 *     channel + booleans only.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Worker } from 'bullmq';
import type { Database } from '../../db/index.js';
import { customers, leads } from '../../db/schema/index.js';
import { decryptPII } from '../../db/crypto.js';
import {
  consume,
  sendMessage,
  type AgentMessageEnvelope,
  type MessageHandlerResult,
} from '../../messaging/dispatcher.js';
import { callClaude } from '../../llm/claude.js';
import { logger } from '../../logger.js';
import { buildLeadScorerSystemFragments, buildLeadScorerUserPrompt } from './prompt.js';
import { setLeadStatus } from '../../db/repositories/leads.js';

/**
 * Schema for the LLM's JSON output. We VALIDATE before trusting — the
 * worker writes `score` into a NOT NULL integer column, so an out-of-range
 * or wrong-typed value would explode the DB write. The schema is the
 * trust boundary between freeform model output and our durable storage.
 */
const LeadScoreOutputSchema = z.object({
  score: z.number().int().min(0).max(100),
  channel: z.enum(['whatsapp', 'voice', 'email', 'sms']),
  opening: z.string().min(1).max(800),
  rationale: z.string().optional(),
});
export type LeadScoreOutput = z.infer<typeof LeadScoreOutputSchema>;

export interface LeadScorerWorkerOptions {
  db: Database;
  /**
   * Override Claude call for tests. The stub-driven tests pass a function
   * that returns canned JSON; the live test omits this so the real SDK runs.
   */
  callClaudeImpl?: typeof callClaude;
}

/**
 * Start the worker. Returns the BullMQ Worker handle so the caller can close
 * it on shutdown.
 */
export function startLeadScorerWorker(opts: LeadScorerWorkerOptions): Worker {
  return consume({
    db: opts.db,
    queue: 'lead',
    role: 'lead-scorer',
    handler: async (envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> =>
      handleLeadNew(opts, envelope),
  });
}

/**
 * Exported for direct testing (no BullMQ in the path). The integration tests
 * exercise this through the worker; unit-style tests can call it directly.
 */
export async function handleLeadNew(
  opts: LeadScorerWorkerOptions,
  env: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  if (env.intent !== 'LEAD.NEW') {
    return { ok: true, result: { skipped: 'wrong-intent' } };
  }
  const payload = env.payload as {
    leadId: string;
    source: 'website' | 'meta' | 'organic' | 'referral' | 'other';
    productLine: 'scooter' | 'car';
    preferredChannel?: 'whatsapp' | 'call';
  };

  // M12: when a paid lead stated a contact preference, it overrides the LLM's
  // channel guess ('call' → the voice leg; 'whatsapp' → WhatsApp). The customer
  // asked for this explicitly — we honor it.
  const channelOverride: 'whatsapp' | 'voice' | undefined =
    payload.preferredChannel === 'call'
      ? 'voice'
      : payload.preferredChannel === 'whatsapp'
        ? 'whatsapp'
        : undefined;

  // 1. Load the lead. Defensive: a stale BullMQ job might race a deletion.
  const [lead] = await opts.db.select().from(leads).where(eq(leads.id, payload.leadId)).limit(1);
  if (!lead) {
    return { ok: false, error: `Lead ${payload.leadId} not found` };
  }

  // 2. Idempotency guard — already scored.
  if (lead.score !== null) {
    logger.debug({ leadId: lead.id, score: lead.score }, 'lead-scorer: already scored, skipping');
    return { ok: true, result: { skipped: 'already-scored', score: lead.score } };
  }

  // 3. Enrich from customer when we have one. Decrypt PII once, here.
  //    NEVER log the decrypted values.
  let customerSnapshot: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    vehicle: unknown;
    driver: unknown;
  } = { fullName: null, email: null, phone: null, vehicle: null, driver: null };
  if (lead.customerId) {
    const [c] = await opts.db
      .select()
      .from(customers)
      .where(eq(customers.id, lead.customerId))
      .limit(1);
    if (c) {
      customerSnapshot = {
        fullName: decryptPII(c.fullName),
        email: decryptPII(c.email),
        phone: decryptPII(c.phone),
        vehicle: c.vehicle,
        driver: c.driver,
      };
    }
  }

  // 4. Build the user prompt + call Haiku.
  const userPrompt = buildLeadScorerUserPrompt({
    source: payload.source,
    productLine: payload.productLine,
    fullName: customerSnapshot.fullName,
    email: customerSnapshot.email,
    phone: customerSnapshot.phone,
    vehicle: customerSnapshot.vehicle,
    driver: customerSnapshot.driver,
    formAnswers: (lead.rawPayload as Record<string, unknown> | null) ?? null,
  });

  const call = opts.callClaudeImpl ?? callClaude;
  let raw: string;
  try {
    const out = await call({
      tier: 'haiku',
      systemFragments: await buildLeadScorerSystemFragments(opts.db),
      userPrompt,
      maxTokens: 300,
      structured: false,
    });
    raw = typeof out === 'string' ? out : out.text;
  } catch (err) {
    logger.error({ err, leadId: lead.id }, 'lead-scorer: Claude call failed');
    return {
      ok: false,
      error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 5. Parse + validate the LLM output. Tolerate ```json fences and stray
  //    preamble/postamble — the rubric forbids them but small models drift.
  const parsed = tryParseScoreJson(raw);
  if (!parsed.ok) {
    logger.warn(
      { leadId: lead.id, parseError: parsed.error },
      'lead-scorer: invalid JSON, falling back to heuristic',
    );
    const fallback = heuristicScore(customerSnapshot, payload.source);
    return persistAndEmit(opts.db, lead.id, fallback, channelOverride);
  }

  return persistAndEmit(opts.db, lead.id, parsed.value, channelOverride);
}

async function persistAndEmit(
  db: Database,
  leadId: string,
  score: LeadScoreOutput,
  channelOverride?: 'whatsapp' | 'voice' | 'email' | 'sms',
): Promise<MessageHandlerResult> {
  const channel = channelOverride ?? score.channel;
  // Persist the score + timestamp first; then flip status via setLeadStatus
  // so the CRM mirror fires on every scored transition (HubSpot Phase 2).
  // updatedAt is intentionally left to setLeadStatus, which stamps it on the
  // status flip — writing it here too would be immediately overwritten.
  await db
    .update(leads)
    .set({ score: score.score, scoredAt: new Date() })
    .where(eq(leads.id, leadId));
  await setLeadStatus(db, leadId, 'scored');

  // Emit LEAD.SCORED to the Sales Agent SINGLETON (role-only, no instance
  // targeting). One sales-agent handles every lead, resolving conversation
  // context from the DB by leadId/correlationId. This replaced the earlier
  // fan-out (sales-spawn-orchestrator + a per-lead `sales-agent/lead-<id>`
  // instance): per-lead instances each spun a worker on the shared lead/
  // customer/quote queues and were never reaped, so they accumulated and —
  // because claimSpecific is role-scoped — raced to claim (and drop) each
  // other's instance-targeted messages, starving LEAD.NEW/LEAD.SCORED.
  const basePayload = {
    leadId,
    score: score.score,
    opening: score.opening,
    channel,
  };

  await sendMessage(
    { db },
    {
      fromRole: 'lead-scorer',
      toRole: 'sales-agent',
      intent: 'LEAD.SCORED',
      payload: basePayload,
      correlationId: leadId,
      priority: 4,
    },
  );

  logger.info({ leadId, score: score.score, channel }, 'lead-scorer: lead scored');

  return { ok: true, result: { score: score.score, channel: score.channel } };
}

/**
 * Best-effort JSON parser:
 *   - strip a leading ```json / ``` fence,
 *   - strip a trailing ``` fence,
 *   - slice from the first `{` to the last `}` (preamble/postamble safety),
 *   - JSON.parse,
 *   - zod-validate against `LeadScoreOutputSchema`.
 *
 * Returns a discriminated result so the caller can branch on `ok` cleanly.
 */
function tryParseScoreJson(
  raw: string,
): { ok: true; value: LeadScoreOutput } | { ok: false; error: string } {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON object found' };
  const slice = cleaned.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(slice);
  } catch (err) {
    return {
      ok: false,
      error: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = LeadScoreOutputSchema.safeParse(obj);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, value: result.data };
}

/**
 * Deterministic fallback when the LLM output is unusable. Scoring is
 * intentionally conservative — we'd rather a real lead land at ~50-65 with
 * a generic opening than 0 with nothing.
 *
 * Phone-bearing leads default to whatsapp (France-first norm); email-only
 * leads route to email; the no-info edge case still defaults to whatsapp
 * so the Sales Agent has a sane starting channel.
 */
function heuristicScore(
  snap: { fullName: string | null; email: string | null; phone: string | null },
  source: string,
): LeadScoreOutput {
  let score = 30;
  if (snap.phone) score += 20;
  if (snap.email) score += 15;
  if (snap.fullName) score += 10;
  if (source === 'meta') score += 5;
  score = Math.min(100, score);

  const channel: LeadScoreOutput['channel'] = snap.phone
    ? 'whatsapp'
    : snap.email
      ? 'email'
      : 'whatsapp';

  const firstName = snap.fullName?.trim().split(/\s+/)[0];
  const opening = firstName
    ? `Bonjour ${firstName}, c'est Assuryal. Pouvez-vous me confirmer votre demande ?`
    : "Bonjour, c'est Assuryal. Pouvez-vous me confirmer votre demande ?";

  return {
    score,
    channel,
    opening,
    rationale: 'fallback heuristic (LLM output invalid)',
  };
}
