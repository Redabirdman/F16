/**
 * Shared @f16/stagehand types.
 *
 * For now this carries only the /health response contract so the HTTP layer,
 * the smoke test, and downstream backend callers can agree on the shape.
 * As real Stagehand intents (M8+) come online, add their request/response
 * envelopes here.
 */

export type HealthResponse = {
  ok: true;
  service: 'f16-stagehand';
  version: string;
  /** Milliseconds since this process's module-load time. */
  uptime: number;
  /** Count of currently-open browser instances in the pool. 0 until M8. */
  browsers: number;
};
