/**
 * LLM usage sink (admin costs, 2026-07-08).
 *
 * `callClaude` and `callClaudeWithTools` are pure modules with no DB handle,
 * so persistence goes through a process-global sink registered once at boot
 * (src/index.ts → registerLlmUsageSink with a drizzle-backed writer).
 *
 * Recording is FIRE-AND-FORGET: a failed insert must never fail, slow down,
 * or retry a customer-facing LLM call. Errors log at warn and are dropped.
 * When no sink is registered (unit tests, scripts), recording is a no-op.
 */
import { logger } from '../logger.js';

export interface LlmUsageEvent {
  model: string;
  tier: string;
  agentRole?: string | undefined;
  purpose?: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs?: number | undefined;
  iterations?: number | undefined;
}

export type LlmUsageSink = (event: LlmUsageEvent) => Promise<void>;

let _sink: LlmUsageSink | null = null;

/** Register the persistence sink (boot) or null to disable (tests). */
export function registerLlmUsageSink(sink: LlmUsageSink | null): void {
  _sink = sink;
}

/**
 * Best-effort extraction of the calling agent role / purpose from the
 * logContext callers already pass (no new parameter threading needed).
 */
export function usageTagsFromLogContext(ctx: Record<string, unknown> | undefined): {
  agentRole?: string;
  purpose?: string;
} {
  if (!ctx) return {};
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = ctx[k];
      if (typeof v === 'string' && v.length > 0 && v.length <= 64) return v;
    }
    return undefined;
  };
  const agentRole = pick('agent', 'agentRole', 'role');
  const purpose = pick('purpose', 'op', 'stage', 'source');
  return {
    ...(agentRole !== undefined ? { agentRole } : {}),
    ...(purpose !== undefined ? { purpose } : {}),
  };
}

/** Record one completed LLM call. Never throws, never awaited by callers. */
export function recordLlmUsage(event: LlmUsageEvent): void {
  const sink = _sink;
  if (!sink) return;
  void sink(event).catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), model: event.model },
      'llm-usage: sink insert failed (dropped)',
    );
  });
}
