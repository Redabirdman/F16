/**
 * Realtime LISTEN/NOTIFY wrapper (design §6.3, M3.T8).
 *
 * Two Postgres NOTIFY channels are installed by migration `0004_realtime_triggers.sql`:
 *
 *   - `agent_messages_channel` — fires on INSERT into agent_messages. The
 *     payload is the routing envelope (id, to_role, to_instance, intent,
 *     correlation_id, priority, created_at).
 *
 *   - `human_actions_channel` — fires on INSERT and on `status` changes of
 *     human_actions. The payload carries (id, op, status, severity,
 *     correlation_id). `op` is the trigger op (`INSERT` | `UPDATE`).
 *
 * This module exposes a typed `RealtimeListener` EventEmitter that:
 *
 *   1. Opens a DEDICATED postgres-js connection. `LISTEN` holds the connection
 *      for the lifetime of the subscription — sharing it with the query pool
 *      would deadlock on the first transaction. `max: 1` makes the pool a
 *      single durable socket; `idle_timeout: 0` keeps it open forever.
 *
 *   2. Subscribes to both channels on `start()`.
 *
 *   3. Parses payloads through zod schemas before emitting. Invalid JSON or
 *      shape-mismatched payloads are logged at `warn` and dropped — the
 *      emitter does NOT crash on malformed data. This matters because a
 *      future trigger change should not be able to take down the realtime
 *      fan-out.
 *
 *   4. Emits typed events `'agent_message'` and `'human_action'` for
 *      downstream consumers. The admin WebSocket layer (M14) and the
 *      WhatsApp escalator (M9) subscribe here.
 *
 *   5. Gracefully closes on `stop()`: invokes each `unlisten()` then
 *      `sql.end()` with a 5s timeout. `stop()` is idempotent — calling it
 *      twice is a no-op.
 *
 * OUT OF SCOPE (deferred to M16 hardening):
 *   - reconnect / exponential backoff on dropped connection
 *   - dead-letter for repeatedly malformed payloads
 *   - per-channel filtering / fan-out into separate emitters
 */
import { EventEmitter } from 'node:events';
import postgres from 'postgres';
import { z } from 'zod';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Payload schemas — these MUST stay in lock-step with the trigger functions
// in drizzle/0004_realtime_triggers.sql. The triggers stringify a
// json_build_object, so all fields arrive as JSON primitives.
// ---------------------------------------------------------------------------

export const AgentMessageNotificationSchema = z.object({
  id: z.string().uuid(),
  to_role: z.string(),
  to_instance: z.string().nullable(),
  intent: z.string(),
  correlation_id: z.string().nullable(),
  priority: z.number().int(),
  created_at: z.string(),
});
export type AgentMessageNotification = z.infer<typeof AgentMessageNotificationSchema>;

export const HumanActionNotificationSchema = z.object({
  id: z.string().uuid(),
  op: z.enum(['INSERT', 'UPDATE']),
  status: z.enum(['pending', 'resolved', 'cancelled', 'expired']),
  severity: z.number().int(),
  correlation_id: z.string().nullable(),
});
export type HumanActionNotification = z.infer<typeof HumanActionNotificationSchema>;

// ---------------------------------------------------------------------------
// Event map — keyed by event name, valued by the listener signature.
// ---------------------------------------------------------------------------

export interface RealtimeEvents {
  agent_message: (n: AgentMessageNotification) => void;
  human_action: (n: HumanActionNotification) => void;
  error: (err: Error) => void;
}

export interface RealtimeListenerOptions {
  /** Postgres connection string. */
  databaseUrl: string;
}

/**
 * Typed event emitter wrapping postgres-js LISTEN on the two F16 channels.
 *
 * Lifecycle:
 *   const rt = new RealtimeListener({ databaseUrl });
 *   rt.on('agent_message', (n) => ...);
 *   rt.on('human_action', (n) => ...);
 *   await rt.start();
 *   ...
 *   await rt.stop();
 */
export class RealtimeListener extends EventEmitter {
  private sql: postgres.Sql<Record<string, never>> | undefined;
  private unlistens: Array<() => Promise<void>> = [];
  private started = false;
  private stopped = false;

  constructor(private readonly opts: RealtimeListenerOptions) {
    super();
  }

  // -------------------------------------------------------------------------
  // Typed event override surface — Node's EventEmitter is `any`-typed, so we
  // narrow the public API to the event map above. The implementation
  // delegates to the parent.
  // -------------------------------------------------------------------------

  override on<K extends keyof RealtimeEvents>(event: K, listener: RealtimeEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override off<K extends keyof RealtimeEvents>(event: K, listener: RealtimeEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
  override once<K extends keyof RealtimeEvents>(event: K, listener: RealtimeEvents[K]): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof RealtimeEvents>(
    event: K,
    ...args: Parameters<RealtimeEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Open the dedicated connection and subscribe to both channels.
   *
   * Throws if called twice. After a successful `stop()`, this instance is
   * spent — instantiate a fresh `RealtimeListener` rather than restarting.
   */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('RealtimeListener was stopped; create a new instance');
    if (this.started) throw new Error('RealtimeListener already started');
    this.started = true;

    this.sql = postgres(this.opts.databaseUrl, {
      max: 1, // dedicated single connection — LISTEN holds it
      idle_timeout: 0, // never close
      connect_timeout: 10,
      // Silence the default notice logger; we don't want pg notices spammed
      // into the realtime path's logger context.
      onnotice: () => {
        /* swallow */
      },
    });

    const agentMeta = await this.sql.listen('agent_messages_channel', (payloadStr) => {
      this.handlePayload('agent_messages_channel', payloadStr);
    });
    const humanMeta = await this.sql.listen('human_actions_channel', (payloadStr) => {
      this.handlePayload('human_actions_channel', payloadStr);
    });

    this.unlistens = [agentMeta.unlisten, humanMeta.unlisten];
    logger.info('realtime: listening on agent_messages_channel + human_actions_channel');
  }

  /**
   * Idempotent shutdown: unlisten both channels, end the connection, drop
   * listeners. Safe to call from a signal handler.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    for (const fn of this.unlistens) {
      try {
        await fn();
      } catch (err) {
        logger.warn({ err }, 'realtime: unlisten failed');
      }
    }
    this.unlistens = [];

    if (this.sql) {
      try {
        await this.sql.end({ timeout: 5 });
      } catch (err) {
        logger.warn({ err }, 'realtime: sql.end failed');
      }
      this.sql = undefined;
    }

    this.removeAllListeners();
    logger.info('realtime: stopped');
  }

  /**
   * Parse and dispatch a raw NOTIFY payload. Malformed payloads are logged
   * and dropped so the listener never crashes on a bad trigger change.
   */
  private handlePayload(channel: string, payloadStr: string): void {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(payloadStr);
    } catch (err) {
      logger.warn({ err, channel, payloadStr }, 'realtime: payload is not valid JSON');
      return;
    }

    if (channel === 'agent_messages_channel') {
      const result = AgentMessageNotificationSchema.safeParse(parsedJson);
      if (!result.success) {
        logger.warn(
          { issues: result.error.issues, channel, payloadStr },
          'realtime: agent_messages_channel payload failed schema validation',
        );
        return;
      }
      this.emit('agent_message', result.data);
      return;
    }

    if (channel === 'human_actions_channel') {
      const result = HumanActionNotificationSchema.safeParse(parsedJson);
      if (!result.success) {
        logger.warn(
          { issues: result.error.issues, channel, payloadStr },
          'realtime: human_actions_channel payload failed schema validation',
        );
        return;
      }
      this.emit('human_action', result.data);
      return;
    }

    // Defensive — should never happen since we only subscribe to two channels.
    logger.warn({ channel, payloadStr }, 'realtime: payload from unknown channel');
  }
}
