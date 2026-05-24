/**
 * Supervisor Agent (M15.T1) — the swarm's meta-observer.
 *
 * Subscribes to the queues that already address `toRole: 'supervisor'`:
 *
 *   - `compliance` — COMPLIANCE.BLOCKED from the Sales Agent's two block paths
 *   - `knowledge`  — KNOWLEDGE.REINDEXED + KNOWLEDGE.DRIFT_DETECTED from the
 *                    Knowledge Curator's bootstrap + scheduled reindex flows
 *
 * What it DOES (V1, deliberately small):
 *   For each observed event, write a structured audit_log row tagged
 *   `supervisor.observed.<event>` so the M13 forensic export naturally
 *   includes the supervisor's view of swarm activity, and so M15.T3's
 *   nightly strategy review can mine these rows to find patterns.
 *
 * What it does NOT do (deferred):
 *   - Auto-acting on observations (the spec phrasing "manages misbehaving
 *     agents" is V2 work — we want a few weeks of audit data to know what
 *     "misbehaving" actually looks like in production before we auto-act).
 *   - Subscribing to LEAD.STATUS_CHANGED — that intent isn't emitted today
 *     (sales-agent + engagement-agent update `leads.status` directly +
 *     write audit rows themselves). The strategy review reads audit_log
 *     for lead transitions instead.
 *
 * Singleton, concurrency 1 — the observer has no per-instance state and
 * we want serialized writes so the audit timeline doesn't interleave.
 */
import { BaseAgent } from '../base.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';
import { appendAudit } from '../../db/repositories/audit-log.js';

export class SupervisorAgent extends BaseAgent {
  protected async onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    try {
      switch (envelope.intent) {
        case 'COMPLIANCE.BLOCKED':
          return await this.observe(envelope, {
            kind: 'compliance.blocked',
            severity: 'standard',
          });
        case 'KNOWLEDGE.REINDEXED':
          return await this.observe(envelope, {
            kind: 'knowledge.reindexed',
            severity: 'info',
          });
        case 'KNOWLEDGE.DRIFT_DETECTED':
          return await this.observe(envelope, {
            kind: 'knowledge.drift_detected',
            severity: 'standard',
          });
        default:
          // Other intents shouldn't reach us — the dispatcher filter on
          // toRole='supervisor' is what brings them here. Log + skip rather
          // than fail-loud so a future emit doesn't poison the queue.
          return {
            ok: true,
            result: { skipped: 'unhandled-intent', intent: envelope.intent },
          };
      }
    } catch (err) {
      logger.error(
        { err, intent: envelope.intent, instanceId: this.instanceId },
        'supervisor-agent: onMessage threw',
      );
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Capture the observation as an audit_log row. The row carries:
   *   - actorType='agent', actorId=`supervisor-agent#singleton`
   *   - action=`supervisor.observed.<kind>`
   *   - targetType/Id from envelope.correlationId when present
   *   - meta carries the source agent + the envelope's payload (safe
   *     because the payload is already typed + the audit table is
   *     operator-only)
   *
   * Best-effort audit: a failed write logs + returns `ok:true` so the
   * dispatcher doesn't BullMQ-retry. The observation lost is annoying
   * but not actionable; the source agent's primary action already landed.
   */
  private async observe(
    envelope: AgentMessageEnvelope,
    kind: { kind: string; severity: 'info' | 'standard' | 'critical' },
  ): Promise<MessageHandlerResult> {
    try {
      await appendAudit(this.db, {
        actorType: 'agent',
        actorId: `${this.role}#${this.instanceId}`,
        action: `supervisor.observed.${kind.kind}`,
        targetType: envelope.correlationId ? 'correlation' : null,
        targetId: envelope.correlationId,
        meta: {
          severity: kind.severity,
          sourceMessageId: envelope.id,
          intent: envelope.intent,
          payload: envelope.payload as Record<string, unknown>,
        },
      });
      logger.info(
        {
          kind: kind.kind,
          severity: kind.severity,
          correlationId: envelope.correlationId,
          sourceMessageId: envelope.id,
        },
        'supervisor: observed event',
      );
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          intent: envelope.intent,
        },
        'supervisor: audit append failed (non-blocking)',
      );
    }
    return {
      ok: true,
      result: { observed: kind.kind, severity: kind.severity },
    };
  }
}
