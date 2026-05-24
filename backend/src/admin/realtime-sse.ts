/**
 * Admin realtime SSE endpoint (M14.T2).
 *
 *   GET /v1/admin/events
 *     Server-Sent Events stream. The admin UI opens an EventSource and
 *     uses incoming events to invalidate React Query caches so the lead
 *     board, queue, and audit views update within sub-second of the
 *     underlying row change.
 *
 * SSE over WebSocket because:
 *   - One-way (server → client) is exactly the shape we need.
 *   - SSE auto-reconnects in the browser via EventSource without any
 *     custom reconnect logic on either side.
 *   - Hono ships a `streamSSE` helper natively; WS on @hono/node-server
 *     needs additional plumbing.
 *
 * Event taxonomy:
 *   - `human_action`     { id, op, status, severity, correlationId }
 *   - `agent_message`    { id, intent, toRole, correlationId, priority }
 *   - `heartbeat`        empty data — sent every 25s to keep the connection
 *                        warm through proxy idle timeouts (Cloudflare's
 *                        default is 100s; 25s gives ample headroom).
 *
 * Listener lifecycle: the RealtimeListener singleton is started ONCE by
 * `start()` in `src/index.ts` and passed in here. We register per-request
 * event listeners on it and remove them when the stream aborts so a
 * disconnected client doesn't leak handlers.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { RealtimeListener } from '../realtime/notify.js';
import { logger } from '../logger.js';

export interface AdminRealtimeRouterOptions {
  /** Shared listener — owned by the start() bootstrap, never started here. */
  realtime: RealtimeListener;
  /** Heartbeat cadence in ms. Default 25 000. Tests pass a small value. */
  heartbeatMs?: number;
}

export function buildAdminRealtimeRouter(opts: AdminRealtimeRouterOptions): Hono {
  const app = new Hono();
  const heartbeatMs = opts.heartbeatMs ?? 25_000;

  app.get('/v1/admin/events', (c) => {
    return streamSSE(c, async (stream) => {
      let nextId = 0;
      const writeEvent = async (event: string, data: unknown): Promise<void> => {
        nextId += 1;
        await stream.writeSSE({
          event,
          data: JSON.stringify(data),
          id: String(nextId),
        });
      };

      // Per-request handlers. We capture refs so we can detach on close.
      const onAgentMessage = (n: {
        id: string;
        intent: string;
        to_role: string;
        correlation_id: string | null;
        priority: number;
      }): void => {
        void writeEvent('agent_message', {
          id: n.id,
          intent: n.intent,
          toRole: n.to_role,
          correlationId: n.correlation_id,
          priority: n.priority,
        }).catch((err: unknown) => {
          logger.debug({ err }, 'admin/sse: writeEvent agent_message failed (client gone?)');
        });
      };
      const onHumanAction = (n: {
        id: string;
        op: 'INSERT' | 'UPDATE';
        status: string;
        severity: number;
        correlation_id: string | null;
      }): void => {
        void writeEvent('human_action', {
          id: n.id,
          op: n.op,
          status: n.status,
          severity: n.severity,
          correlationId: n.correlation_id,
        }).catch((err: unknown) => {
          logger.debug({ err }, 'admin/sse: writeEvent human_action failed (client gone?)');
        });
      };

      opts.realtime.on('agent_message', onAgentMessage);
      opts.realtime.on('human_action', onHumanAction);

      // Send an immediate hello so the client knows the stream is live.
      await writeEvent('hello', { ts: new Date().toISOString() });

      // Heartbeats keep proxies from killing the connection. Using
      // `setInterval` directly + clearing on abort is simpler than racing
      // a promise loop.
      const heartbeat = setInterval(() => {
        void writeEvent('heartbeat', { ts: Date.now() }).catch(() => undefined);
      }, heartbeatMs);

      // Hold the stream open until the client disconnects. `stream.onAbort`
      // is invoked by Hono when the underlying connection closes.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(heartbeat);
          opts.realtime.off('agent_message', onAgentMessage);
          opts.realtime.off('human_action', onHumanAction);
          resolve();
        });
      });
    });
  });

  return app;
}
