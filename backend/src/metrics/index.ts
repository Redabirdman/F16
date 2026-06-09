/**
 * F16 metric accessors (M16 hardening).
 *
 * Centralises every metric NAME so call sites never hand-type a string
 * (one typo = a silent orphan series). Import the helper, not the name.
 *
 *   import { recordJobCompleted, recordWebhookSignatureFailure } from '../metrics/index.js';
 */
export { metrics, registerDefaultMetrics, MetricsRegistry } from './registry.js';
import { metrics } from './registry.js';

export function recordJobCompleted(queue: string, durationSeconds?: number): void {
  metrics.counter('f16_jobs_completed_total', 'Total agent-message jobs completed').inc({ queue });
  if (durationSeconds !== undefined) recordJobDuration(queue, durationSeconds);
}

export function recordJobFailed(queue: string): void {
  metrics.counter('f16_jobs_failed_total', 'Total agent-message job attempts that failed').inc({
    queue,
  });
}

export function recordJobDeadLettered(queue: string): void {
  metrics
    .counter(
      'f16_jobs_dead_lettered_total',
      'Total jobs moved to the dead-letter queue after exhausting retries',
    )
    .inc({ queue });
}

function recordJobDuration(queue: string, seconds: number): void {
  metrics
    .counter('f16_job_process_seconds_sum', 'Sum of job processing time in seconds')
    .inc({ queue }, seconds);
  metrics.counter('f16_job_process_seconds_count', 'Count of processed jobs').inc({ queue });
}

/** webhook ∈ {waha, meta, lead, voice, voice_call_request, openai_sip} */
export function recordWebhookSignatureFailure(webhook: string): void {
  metrics
    .counter(
      'f16_webhook_signature_failures_total',
      'Total inbound webhook requests rejected for a bad/missing signature',
    )
    .inc({ webhook });
}

/** kind ∈ {openai_control} */
export function recordWsReconnect(kind: string): void {
  metrics.counter('f16_ws_reconnects_total', 'Total WebSocket reconnect attempts').inc({ kind });
}

/** Live queue-depth gauge — set by the BullMQ collector at scrape time. */
export function queueDepthGauge() {
  return metrics.gauge('f16_queue_depth', 'BullMQ jobs per queue per state (scrape-time snapshot)');
}

/** reason ∈ {asterisk_not_active, ovh_stale} — voice watchdog restarted Asterisk. */
export function recordVoiceWatchdogHeal(reason: string): void {
  metrics
    .counter(
      'f16_voice_watchdog_heals_total',
      'Times the voice watchdog restarted Asterisk to self-heal',
    )
    .inc({ reason });
}

/** OVH SIP trunk registration health: 1 = registered+valid, 0 = stale/rejected/down. */
export function voiceOvhRegisteredGauge() {
  return metrics.gauge(
    'f16_voice_ovh_registered',
    'OVH SIP trunk registration health (1=ok, 0=stale)',
  );
}
