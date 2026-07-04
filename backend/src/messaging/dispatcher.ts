/**
 * Agent message dispatcher (design §6.1).
 *
 * Unifies three lower layers into a single send/consume API:
 *   1. agent_messages (durable inter-agent bus, repo: M2.T6)
 *   2. BullMQ queues  (lightweight delivery + retry, M3.T1)
 *   3. intent registry (zod-typed payloads, M3.T2)
 *
 * Send path:
 *   sendMessage()
 *     -> validateIntentPayload (throws on schema mismatch / unknown intent)
 *     -> agentMessages.enqueue (writes durable row; LISTEN/NOTIFY fires)
 *     -> getQueue(`${intent->queue}.${toRole}`).add({ messageId }) (lightweight job carrying row id)
 *     -> returns row id
 *
 * Consume path:
 *   consume({ queue, role, handler })
 *     -> createWorker(`${queue}.${role}`) — one BullMQ worker per (queue, role)
 *        -> on job: agentMessages.claimSpecific(messageId, role)
 *             - returns null on misrouted/already-consumed row (defensive)
 *        -> hands typed envelope to handler
 *        -> handler.result.ok=true  -> markResult
 *        -> handler.result.ok=false -> markError
 *        -> handler throws         -> markError + rethrow (BullMQ retry policy)
 *
 * Why BullMQ + DB-row claim instead of polling claimNext():
 *   claimNext() would race when N workers all poll for the same role — pulling
 *   distinct rows but reordering wrt BullMQ's fair-queue semantics. By making
 *   BullMQ the source of "next id" and the DB the source of "atomic claim",
 *   we get once-and-only-once delivery with retry policy + priority for free.
 *
 * Routing:
 *   INTENT_TO_QUEUE is the single source of truth mapping intent -> LOGICAL
 *   queue name (intent category). Every registered intent MUST have an entry;
 *   the assertEveryIntentRouted helper at module load makes that a hard error.
 *
 *   The PHYSICAL BullMQ queue is role-scoped: `${category}.${toRole}` (see
 *   physicalQueueName). 2026-07-03 regression fix: when N roles shared one
 *   physical queue (e.g. sales-agent + maxance-operator on 'quote'), a job was
 *   delivered to an arbitrary role's worker and bounced via requeue when the
 *   role didn't match; the same wrong worker could win the re-pickup race
 *   MAX_REROUTES times in a row and the message was DROPPED (live
 *   QUOTE.REQUESTED a9e94c62). Role-scoping the physical queue makes the
 *   wrong-role pickup impossible by construction: a worker only ever sees jobs
 *   addressed to its own role. A message to a role with no consumer now parks
 *   (durable row stays unconsumed + job waits) instead of being dropped, and
 *   is delivered as soon as that role's worker attaches.
 */
import type { Worker } from 'bullmq';
import type { Database } from '../db/index.js';
import { logger } from '../logger.js';
import { validateIntentPayload, listIntents } from '../intents/index.js';
import * as agentMessages from '../db/repositories/agent-messages.js';
import { getQueue, createWorker } from '../queue/index.js';

/**
 * Physical BullMQ queue for a (logical queue, to_role) pair. '.' separator —
 * BullMQ rejects ':' in queue names. Keeping the logical category in the name
 * keeps /metrics + DLQ names readable and preserves the one-worker-per-queue
 * serialization each role already relies on (e.g. maxance-operator's single
 * browser session serializes on 'quote.maxance-operator').
 */
export function physicalQueueName(logicalQueue: string, toRole: string): string {
  return `${logicalQueue}.${toRole}`;
}

/**
 * Every physical queue this process has touched (sent to or consumed from).
 * Feeds the /metrics queue-depth collector — physical names are only known
 * dynamically since they depend on the to_role of live traffic.
 */
const _activePhysicalQueues = new Set<string>();

/** Snapshot of physical queue names seen by this process (for /metrics). */
export function listActivePhysicalQueues(): string[] {
  return [..._activePhysicalQueues];
}

/** Routing — which BullMQ queue handles a given intent. */
const INTENT_TO_QUEUE: Record<string, string> = {
  // lead
  'LEAD.NEW': 'lead',
  'LEAD.PROFILE_UPDATED': 'lead',
  'LEAD.SCORED': 'lead',
  'LEAD.STATUS_CHANGED': 'lead',
  // hubspot mirror — dedicated queue so hubspot-sync is the SOLE consumer
  // (no wrong-role race against lead-scorer on the shared 'lead' queue).
  'LEAD.SYNC_HUBSPOT': 'hubspot',
  // Phase 3 activity timeline — same dedicated hubspot queue, same consumer.
  // Gated: the worker no-ops unless F16_HUBSPOT_ACTIVITIES==='true'.
  'HUBSPOT.LOG_ACTIVITY': 'hubspot',
  // customer
  'CUSTOMER.MESSAGE_RECEIVED': 'customer',
  'CUSTOMER.MESSAGE_SENT': 'customer',
  'CUSTOMER.OCR_REQUESTED': 'customer',
  'CUSTOMER.OCR_READY': 'customer',
  'CUSTOMER.FOLLOWUP_DUE': 'customer',
  'CUSTOMER.CHANNEL_SWITCH_REQUESTED': 'customer',
  // quote
  'QUOTE.REQUESTED': 'quote',
  'QUOTE.CONFIRM_REQUESTED': 'quote',
  'QUOTE.READY': 'quote',
  'QUOTE.PREVIEW_READY': 'quote',
  'QUOTE.FAILED': 'quote',
  'QUOTE.DELIVERED': 'quote',
  'QUOTE.ACCEPTED': 'quote',
  'QUOTE.REJECTED': 'quote',
  // 2026-07-02 inbox-relay: devis PDF landed in the Assuryal Workspace inbox;
  // the sales-agent re-delivers it to the customer (WhatsApp + branded email).
  'DEVIS.PDF_RECEIVED': 'quote',
  'PAYMENT.PENDING_HUMAN': 'quote',
  'CONTRACT.PENDING_HUMAN': 'quote',
  'CONTRACT.ISSUED': 'quote',
  // subscription (M8.T7 closing) — same queue as quotes: the Maxance Operator
  // and Sales Agent already consume 'quote', and the souscription is the same
  // single-browser-session resource the quote flows serialize on.
  'SUBSCRIPTION.REQUESTED': 'quote',
  'SUBSCRIPTION.READY': 'quote',
  'SUBSCRIPTION.FAILED': 'quote',
  // voice
  'VOICE.CALL_SCHEDULED': 'voice',
  'VOICE.CALL_STARTED': 'voice',
  'VOICE.CALL_COMPLETED': 'voice',
  'VOICE.CALL_FAILED': 'voice',
  // ads
  'CREATIVE.BRIEF_REQUESTED': 'ads',
  'CREATIVE.PROMPT_READY': 'ads',
  'CREATIVE.GENERATED': 'ads',
  'CAMPAIGN.HUMAN_APPROVAL_REQUESTED': 'human_action',
  'CAMPAIGN.HUMAN_APPROVAL_RESOLVED': 'ads',
  'CAMPAIGN.LAUNCHED': 'ads',
  'CAMPAIGN.FATIGUE_DETECTED': 'ads',
  'AUDIENCE.REFRESH_REQUESTED': 'ads',
  'AUDIENCE.REFRESHED': 'ads',
  // knowledge
  'KNOWLEDGE.REINDEX_REQUESTED': 'knowledge',
  'KNOWLEDGE.REINDEXED': 'knowledge',
  'KNOWLEDGE.DRIFT_DETECTED': 'knowledge',
  // compliance
  'COMPLIANCE.CHECK_REQUESTED': 'compliance',
  'COMPLIANCE.PASSED': 'compliance',
  'COMPLIANCE.BLOCKED': 'compliance',
  // operations
  'HUMAN_ACTION.REQUESTED': 'human_action',
  'HUMAN_ACTION.RESOLVED': 'human_action',
  'SESSION.HEARTBEAT': 'operations',
  'SESSION.LOGGED_OUT': 'operations',
  'ORG.STATE_TICK': 'operations',
  // engagement (M11) — internal tick emitted by the engagement scheduler.
  'ENGAGEMENT.TICK': 'engagement',
};

export interface SendMessageInput {
  fromRole: string;
  fromInstance?: string;
  toRole: string;
  toInstance?: string;
  intent: string;
  payload: unknown;
  correlationId?: string;
  requiresHuman?: boolean;
  /** BullMQ priority — 0 = highest, 9 = lowest. Default 5. */
  priority?: number;
}

export interface AgentMessageEnvelope {
  /** agent_messages.id */
  id: string;
  intent: string;
  toRole: string;
  toInstance: string | null;
  correlationId: string | null;
  /** Already validated against the intent's zod schema. */
  payload: unknown;
  priority: number;
  createdAt: Date;
}

export type MessageHandlerResult =
  | { ok: true; result?: Record<string, unknown> }
  | { ok: false; error: string };

export interface DispatcherOptions {
  db: Database;
}

/**
 * Send a typed message. Validates payload, persists row, enqueues lightweight
 * BullMQ job carrying just the row id (workers re-fetch the row from DB so
 * they always work against the source of truth).
 *
 * Returns the inserted row id (also the BullMQ job payload).
 *
 * Throws when:
 *   - intent is unknown to the registry
 *   - payload fails zod validation
 *   - intent has no queue routing in INTENT_TO_QUEUE
 *   - DB insert fails
 */
export async function sendMessage(
  opts: DispatcherOptions,
  input: SendMessageInput,
): Promise<string> {
  // 1. Validate payload via the intent registry. Throws synchronously on
  //    unknown intent or schema mismatch — caller sees the error BEFORE any
  //    side effect.
  const parsed = validateIntentPayload(input.intent, input.payload) as Record<string, unknown>;

  // 2. Resolve queue routing BEFORE persisting — we'd rather throw here than
  //    leave an orphan row that nothing ever consumes.
  const queueName = INTENT_TO_QUEUE[input.intent];
  if (!queueName) {
    throw new Error(
      `No queue routing defined for intent ${input.intent}. Add it to INTENT_TO_QUEUE.`,
    );
  }

  // 3. Persist the durable row. The INSERT trigger fires NOTIFY on
  //    agent_messages_channel — realtime fan-out for free.
  const row = await agentMessages.enqueue(opts.db, {
    fromRole: input.fromRole,
    fromInstance: input.fromInstance ?? null,
    toRole: input.toRole,
    toInstance: input.toInstance ?? null,
    intent: input.intent,
    payload: parsed,
    correlationId: input.correlationId ?? null,
    requiresHuman: input.requiresHuman ?? false,
    priority: input.priority ?? 5,
  });

  // 4. Enqueue the lightweight BullMQ job on the ROLE-SCOPED physical queue,
  //    so only the addressed role's worker can ever pick it up. The job's
  //    `name` is the intent, so worker traces are readable; the `data` is
  //    just the row id.
  const physical = physicalQueueName(queueName, input.toRole);
  _activePhysicalQueues.add(physical);
  const queue = getQueue(physical);
  await queue.add(
    input.intent,
    { messageId: row.id },
    {
      priority: input.priority ?? 5,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  );

  logger.debug(
    {
      messageId: row.id,
      intent: input.intent,
      toRole: input.toRole,
      queue: physical,
    },
    'agent_message dispatched',
  );

  return row.id;
}

/**
 * Subscribe a handler to a queue + role pair. Spins up a BullMQ Worker that:
 *   1. claims the row from agent_messages (atomic UPDATE; rejects misroutes)
 *   2. hands the typed envelope to the handler
 *   3. writes markResult / markError based on the handler outcome
 *   4. rethrows on handler exception so BullMQ retries per its policy
 *
 * Caller OWNS the returned Worker lifecycle — close it on shutdown.
 */
export function consume(
  opts: DispatcherOptions & {
    queue: string;
    role: string;
    handler: (envelope: AgentMessageEnvelope) => Promise<MessageHandlerResult>;
    concurrency?: number;
  },
): Worker {
  const physical = physicalQueueName(opts.queue, opts.role);
  _activePhysicalQueues.add(physical);
  return createWorker(
    physical,
    async (jobName, data: unknown) => {
      const { messageId } = data as { messageId: string };

      // Atomically claim the specific row. Returns null when:
      //   - the row was already consumed (duplicate BullMQ delivery)
      //   - the row's to_role doesn't match (impossible via sendMessage on a
      //     role-scoped queue; only a manually-enqueued job can get here)
      //   - the row doesn't exist (race against TRUNCATE / GDPR purge)
      const claimed = await agentMessages.claimSpecific(opts.db, messageId, opts.role);
      if (!claimed) {
        // Defensive: a wrong-role row on a role-scoped queue means someone
        // enqueued a raw BullMQ job on the wrong physical queue (or a legacy
        // pre-role-scoping job survived the boot drain). Forward it to the
        // correct role's queue instead of dropping — the durable row is the
        // source of truth for the addressee.
        const row = await agentMessages.getById(opts.db, messageId);
        if (row && row.consumedAt === null && row.toRole !== opts.role) {
          const category = INTENT_TO_QUEUE[row.intent] ?? opts.queue;
          const correct = physicalQueueName(category, row.toRole);
          logger.warn(
            { messageId, jobName, role: opts.role, toRole: row.toRole, queue: physical, correct },
            'agent_message wrong-role job on role-scoped queue — forwarding to correct role queue',
          );
          _activePhysicalQueues.add(correct);
          await getQueue(correct).add(
            row.intent,
            { messageId: row.id },
            {
              priority: row.priority,
              removeOnComplete: { count: 1000 },
              removeOnFail: { count: 5000 },
            },
          );
          return;
        }
        logger.debug(
          { messageId, jobName, role: opts.role },
          'agent_message not claimable (already consumed or missing)',
        );
        return;
      }

      const envelope: AgentMessageEnvelope = {
        id: claimed.id,
        intent: claimed.intent,
        toRole: claimed.toRole,
        toInstance: claimed.toInstance,
        correlationId: claimed.correlationId,
        payload: claimed.payload,
        priority: claimed.priority,
        createdAt: claimed.createdAt,
      };

      try {
        const result = await opts.handler(envelope);
        if (result.ok) {
          // markResult requires a Record — wrap empty results to satisfy the
          // jsonb column type. null result still writes {} so callers can
          // tell "consumed + succeeded with no payload" apart from "errored".
          await agentMessages.markResult(opts.db, claimed.id, result.result ?? {});
        } else {
          await agentMessages.markError(opts.db, claimed.id, result.error);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, messageId: claimed.id, intent: claimed.intent },
          'agent_message handler threw',
        );
        await agentMessages.markError(opts.db, claimed.id, errMsg);
        // Rethrow so BullMQ counts it as a failure and applies retry policy.
        throw err;
      }
    },
    { concurrency: opts.concurrency ?? 1 },
  );
}

/**
 * Re-enqueue an unconsumed message by id — useful for tests + manual
 * re-drives. Throws when the row is missing, already consumed, or has no
 * queue routing.
 */
export async function requeue(opts: DispatcherOptions, messageId: string): Promise<void> {
  const row = await agentMessages.getById(opts.db, messageId);
  if (!row) throw new Error(`No agent_message ${messageId}`);
  if (row.consumedAt) throw new Error(`agent_message ${messageId} already consumed`);
  const queueName = INTENT_TO_QUEUE[row.intent];
  if (!queueName) throw new Error(`No queue route for ${row.intent}`);
  const physical = physicalQueueName(queueName, row.toRole);
  _activePhysicalQueues.add(physical);
  await getQueue(physical).add(row.intent, { messageId: row.id }, { priority: row.priority });
}

/**
 * One-shot boot migration (2026-07-03 role-scoped queues): move any job still
 * parked on a LEGACY shared category queue (pre-role-scoping physical name,
 * e.g. 'quote') onto the role-scoped queue its durable row addresses. Jobs
 * whose row is already consumed or gone are simply removed. Idempotent —
 * legacy queues are empty after the first run and nothing enqueues to them
 * anymore.
 */
export async function drainLegacySharedQueues(
  opts: DispatcherOptions,
  legacyQueues: readonly string[],
): Promise<number> {
  let moved = 0;
  for (const legacy of legacyQueues) {
    const q = getQueue(legacy);
    const jobs = await q.getJobs(['wait', 'prioritized', 'delayed', 'paused']);
    for (const job of jobs) {
      const { messageId } = (job.data ?? {}) as { messageId?: string };
      if (messageId) {
        const row = await agentMessages.getById(opts.db, messageId);
        if (row && row.consumedAt === null) {
          const category = INTENT_TO_QUEUE[row.intent] ?? legacy;
          const physical = physicalQueueName(category, row.toRole);
          _activePhysicalQueues.add(physical);
          await getQueue(physical).add(
            row.intent,
            { messageId: row.id },
            {
              priority: row.priority,
              removeOnComplete: { count: 1000 },
              removeOnFail: { count: 5000 },
            },
          );
          moved += 1;
        }
      }
      await job.remove().catch(() => {
        /* best-effort — a locked/active job will be handled by its owner */
      });
    }
  }
  if (moved > 0) {
    logger.info({ moved }, 'drained legacy shared queues onto role-scoped queues');
  }
  return moved;
}

/**
 * Defensive check — every registered intent must have a queue mapping.
 * Called at module load so a missing entry surfaces at boot, not when the
 * first message of that intent is sent in production.
 */
function assertEveryIntentRouted(): void {
  const unrouted = listIntents().filter((name) => !INTENT_TO_QUEUE[name]);
  if (unrouted.length > 0) {
    throw new Error(
      `INTENT_TO_QUEUE is missing routes for: ${unrouted.join(', ')}. ` +
        `Add them to src/messaging/dispatcher.ts.`,
    );
  }
}

assertEveryIntentRouted();

export { INTENT_TO_QUEUE };
