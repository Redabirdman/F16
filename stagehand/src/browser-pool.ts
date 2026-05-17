/**
 * Stagehand browser pool — placeholder for M1.T5.
 *
 * The real pool (M8) will manage a bounded set of Stagehand/Playwright browser
 * instances, hand them out for individual intents, recycle them after N uses,
 * and tear them down on shutdown. For now this is a no-op shell so the HTTP
 * surface (`/health` reports `browsers: pool.size()`) can be wired without
 * blocking on the real implementation.
 *
 * The acquire/release/closeAll methods are stubbed to telegraph the M8 API
 * surface — callers can wire up shutdown drains and request handlers against
 * this shape today without waiting for the real pool. `closeAll()` is a
 * deliberate no-op (not a throw) because index.ts shutdown calls it; throwing
 * would crash signal handling. acquire/release throw because they MUST NOT be
 * called pre-M8 — silently no-oping would mask bugs.
 */
import type { Stagehand } from '@browserbasehq/stagehand';

export class BrowserPool {
  /** Number of currently-open browser instances. Always 0 in this placeholder. */
  size(): number {
    return 0;
  }

  /** M8 will return a pooled Stagehand instance. Throws until then. */
  async acquire(): Promise<Stagehand> {
    throw new Error('BrowserPool.acquire not implemented until M8');
  }

  /** M8 will return the instance to the pool or recycle it. Throws until then. */
  release(_instance: Stagehand): void {
    throw new Error('BrowserPool.release not implemented until M8');
  }

  /**
   * Drain the pool on shutdown. No-op in M1 (nothing to close), but the seam
   * exists so index.ts can await this on SIGINT/SIGTERM without conditionals.
   */
  async closeAll(): Promise<void> {
    // No-op until M8.
  }
}

/** Process-wide singleton. Replace internals in M8 — keep the export name stable. */
export const pool = new BrowserPool();
