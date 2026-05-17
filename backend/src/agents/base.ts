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
  /** BullMQ queue name (from QUEUE_NAMES). */
  queue: string;
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
  readonly queue: string;
  readonly concurrency: number;
  readonly allowedTools: readonly string[];
  readonly systemPrompt: string;
  readonly meta: Record<string, unknown>;
  protected db: Database;

  private worker?: Worker;
  private started = false;
  private stopped = false;

  constructor(cfg: BaseAgentConfig) {
    this.role = cfg.role;
    this.instanceId = cfg.instanceId;
    this.model = cfg.model;
    this.queue = cfg.queue;
    this.concurrency = cfg.concurrency ?? 1;
    this.allowedTools = cfg.allowedTools ?? [];
    this.systemPrompt = cfg.systemPrompt ?? '';
    this.meta = cfg.meta ?? {};
    this.db = cfg.db;
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
      { role: this.role, instanceId: this.instanceId, queue: this.queue, model: this.model },
      'agent.start',
    );
    await this.onStart();
    this.worker = consume({
      db: this.db,
      queue: this.queue,
      role: this.role,
      concurrency: this.concurrency,
      handler: async (envelope) => {
        // Only handle messages directed at this role and (optionally) this instance.
        // The dispatcher.claimSpecific already filters by role; we additionally
        // ignore messages targeted at a *different* instance. Note that by the
        // time we get here the row is already claimed (consumed_at set) — we
        // still return ok:true so the row is marked with a skipped result and
        // the queue moves on. Sub-class onMessage is NOT invoked.
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
      },
    });
  }

  /** Stop the worker; idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    logger.info({ role: this.role, instanceId: this.instanceId }, 'agent.stop');
    if (this.worker) {
      await this.worker.close();
    }
    await this.onStop();
  }

  /** For tests / monitoring. */
  isRunning(): boolean {
    return this.started && !this.stopped;
  }
}
