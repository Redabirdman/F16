/**
 * useRealtime (M14.T2) — subscribes to /v1/admin/events SSE and triggers
 * React Query cache invalidation when relevant rows change.
 *
 * Event routing:
 *   - human_action (INSERT or status change) → invalidate the queue list
 *     + the audit page (any state change also writes an audit row)
 *   - agent_message → no automatic invalidation in V2 (the admin doesn't
 *     render agent_messages directly yet; M14 V2.5 surface for /agents).
 *
 * Connection lifecycle:
 *   - Opens EventSource once on mount.
 *   - Browser's EventSource auto-reconnects on socket drops with
 *     exponential backoff (built-in). No manual reconnect.
 *   - Closes on unmount.
 *
 * Auth: the SSE endpoint accepts the bearer token as `?token=` query param
 * because EventSource can't set headers (browser limitation). The token
 * is read from localStorage by `getAdminToken()`.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAdminToken } from './api';

export function useRealtime(): void {
  const qc = useQueryClient();

  useEffect(() => {
    const token = getAdminToken();
    const url = token ? `/v1/admin/events?token=${encodeURIComponent(token)}` : '/v1/admin/events';
    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch {
      // EventSource not available (very old browser); silently skip.
      return undefined;
    }

    const onHumanAction = (): void => {
      void qc.invalidateQueries({ queryKey: ['admin', 'human-actions'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
    };
    const onAgentMessage = (): void => {
      // M14 V2 doesn't render agent_messages directly. Future hook point
      // for /agents (V2.5). We still bump the dashboard so the live
      // "activity in the last 24h" counter stays warm.
      void qc.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
    };

    es.addEventListener('human_action', onHumanAction);
    es.addEventListener('agent_message', onAgentMessage);
    // No-op listeners — keep the connection alive without burning cycles.
    es.addEventListener('heartbeat', () => undefined);
    es.addEventListener('hello', () => undefined);

    return () => {
      es.close();
    };
  }, [qc]);
}
