/**
 * BaseAgent — lifecycle skeleton that every long-running agent class extends
 * (Sales Agent, Maxance Operator, Lead Scorer, etc.).
 *
 * Sub-classes only fill in:
 *   - role / instanceId / model tier
 *   - queue name (from QUEUE_NAMES)
 *   - onMessage(envelope) — what to do when a message arrives
 *   - optional onStart / onStop hooks for setup + teardown
 *   - system prompt + allowedTools (wired in M3.T5 / M3.T6)
 *
 * The base wires four things:
 *   1. BullMQ worker creation via `consume()` from the M3.T3 dispatcher
 *   2. Instance-targeted message filtering (claimSpecific is role-scoped,
 *      not instance-scoped, so we filter here)
 *   3. A typed `send()` helper that auto-fills fromRole / fromInstance
 *   4. A `recall()` stub — real semantic memory arrives in M6 (Mem0)
 *
 * Start / stop are guarded so callers can't double-start or skip cleanup.
 */
import type { Worker } from 'bullmq';
import type { Database } from '../db/index.js';
import { logger } from '../logger.js';
import {
  consume,
  sendMessage,
  type AgentMessageEnvelope,
  type MessageHandlerResult,
  type SendMessageInput,
} from '../messaging/dispatcher.js';

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export interface BaseAgentConfig {
  /** Logical agent role — used by the dispatcher to route messages. e.g. 'sales-agent' */
  role: string;
  /** Per-instance identifier — e.g. 'lead-1234', or 'singleton' for singletons. */
  instanceId: string;
  /** Preferred model tier; wired into the Claude SDK wrapper in M3.T5. */
  model: ModelTier;
  /**
   * BullMQ queue name(s) the agent subscribes to (from QUEUE_NAMES). Most agents
   * pass a single queue here; some (e.g. Sales Agent) listen on multiple — one
   * BullMQ worker is spun up per queue, all dispatching to the same `onMessage`.
   * Either `queue` (single, back-compat) or `queues` (list) MUST be set.
   */
  queues?: readonly string[];
  /** @deprecated single-queue shorthand. Prefer `queues: [name]`. */
  queue?: string;
  /** BullMQ concurrency — defaults to 1 (one message at a time per agent). */
  concurrency?: number;
  db: Database;
  /** Optional list of tool names this agent is allowed to use. Wired in M3.T6. */
  allowedTools?: readonly string[];
  /** Free-form system-prompt fragments — combined later by the Claude SDK wrapper (M3.T5). */
  systemPrompt?: string;
  /** Optional metadata for logging / debug. */
  meta?: Record<string, unknown>;
}

export abstract class BaseAgent {
  readonly role: string;
  readonly instanceId: string;
  readonly model: ModelTier;
  /**
   * Every queue this agent subscribes to. One BullMQ worker is created per
   * entry; all dispatch to the same `onMessage` handler. Always length >= 1.
   */
  readonly queues: readonly string[];
  readonly concurrency: number;
  readonly allowedTools: readonly string[];
  readonly systemPrompt: string;
  readonly meta: Record<string, unknown>;
  protected db: Database;

  private workers: Worker[] = [];
  private started = false;
  private stopped = false;

  constructor(cfg: BaseAgentConfig) {
    this.role = cfg.role;
    this.instanceId = cfg.instanceId;
    this.model = cfg.model;
    // Accept either `queues` (preferred, multi-queue) or `queue` (single,
    // back-compat). Exactly one MUST be set; an empty `queues: []` is invalid.
    const queues = cfg.queues ?? (cfg.queue ? [cfg.queue] : []);
    if (queues.length === 0) {
      throw new Error(
        `Agent ${cfg.role}#${cfg.instanceId}: at least one queue must be configured (set 'queues' or 'queue')`,
      );
    }
    this.queues = queues;
    this.concurrency = cfg.concurrency ?? 1;
    this.allowedTools = cfg.allowedTools ?? [];
    this.systemPrompt = cfg.systemPrompt ?? '';
    this.meta = cfg.meta ?? {};
    this.db = cfg.db;
  }

  /**
   * Back-compat accessor — returns the agent's primary queue (queues[0]).
   * Kept so the agent registry can write a single 'queue' column into
   * agents_state for the admin's visual summary; the agent's real, multi-queue
   * behavior is an implementation detail.
   */
  get queue(): string {
    // Constructor guarantees queues.length >= 1; index access is safe.
    const primary = this.queues[0];
    if (primary === undefined) {
      // Unreachable — constructor rejects empty `queues`. Throwing rather than
      // ! keeps the lint rule honest and surfaces a clear error if the
      // invariant ever breaks (e.g. someone mutates `queues` reflectively).
      throw new Error(`Agent ${this.role}#${this.instanceId} has no queues configured`);
    }
    return primary;
  }

  /**
   * Subclasses MUST implement: handle one inbound message.
   * Return {ok:true} on success (optionally with a result payload),
   * or {ok:false, error} to mark the agent_message row as errored.
   * Throwing also marks errored and triggers BullMQ retry policy.
   */
  protected abstract onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult>;

  /** Convenience: send a typed message to another agent. */
  protected async send(
    input: Omit<SendMessageInput, 'fromRole' | 'fromInstance'>,
  ): Promise<string> {
    return sendMessage(
      { db: this.db },
      {
        ...input,
        fromRole: this.role,
        fromInstance: this.instanceId,
      },
    );
  }

  /**
   * Recall semantic memory for an entity (customer / lead / etc.).
   * Stubbed — real impl arrives in M6 via Mem0. For now just returns [].
   */
  protected async recall(_args: {
    entityId: string;
    entityType: string;
    query: string;
    limit?: number;
  }): Promise<unknown[]> {
    // TODO M6 — wire to memory.recallCustomer / mem0.search
    return [];
  }

  /** Lifecycle: subclasses can override for one-shot init at start. */
  protected async onStart(): Promise<void> {
    // default no-op
  }

  /** Lifecycle: subclasses can override for cleanup at stop. */
  protected async onStop(): Promise<void> {
    // default no-op
  }

  /**
   * Start the agent — runs onStart hook, then spins up the BullMQ worker that
   * dispatches matching messages to `onMessage`.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error(`Agent ${this.role}#${this.instanceId} already started`);
    }
    this.started = true;
    logger.info(
      { role: this.role, instanceId: this.instanceId, queues: this.queues, model: this.model },
      'agent.start',
    );
    await this.onStart();
    // Shared handler — one closure dispatched by every queue's worker. Going
    // through this instead of N closures keeps `onMessage` the single point of
    // truth + lets us filter instance-mismatch identically per queue.
    const handler = async (envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> => {
      if (envelope.toInstance && envelope.toInstance !== this.instanceId) {
        logger.debug(
          {
            role: this.role,
            instanceId: this.instanceId,
            targetInstance: envelope.toInstance,
            messageId: envelope.id,
          },
          'agent.skip.instance-mismatch',
        );
        return { ok: true, result: { skipped: 'instance-mismatch' } };
      }
      logger.debug(
        {
          role: this.role,
          instanceId: this.instanceId,
          intent: envelope.intent,
          messageId: envelope.id,
        },
        'agent.onMessage',
      );
      return this.onMessage(envelope);
    };
    // One worker per queue. They share the same handler — BullMQ guarantees
    // each message is delivered to at most one worker per queue, and our
    // agent_messages.claimSpecific row-level lock guards against any cross-
    // worker dup if the same message id were ever enqueued twice.
    for (const q of this.queues) {
      this.workers.push(
        consume({
          db: this.db,
          queue: q,
          role: this.role,
          concurrency: this.concurrency,
          handler,
        }),
      );
    }
  }

  /** Stop every queue's worker; idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    logger.info({ role: this.role, instanceId: this.instanceId }, 'agent.stop');
    for (const w of this.workers) {
      await w.close().catch((err) => {
        logger.warn(
          { role: this.role, instanceId: this.instanceId, err },
          'agent.stop.worker-close-failed',
        );
      });
    }
    this.workers = [];
    await this.onStop();
  }

  /** For tests / monitoring. */
  isRunning(): boolean {
    return this.started && !this.stopped;
  }
}
