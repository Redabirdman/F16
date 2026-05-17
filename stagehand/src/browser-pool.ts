/**
 * Stagehand browser pool — placeholder for M1.T5.
 *
 * The real pool (M8) will manage a bounded set of Stagehand/Playwright browser
 * instances, hand them out for individual intents, recycle them after N uses,
 * and tear them down on shutdown. For now this is a no-op shell so the HTTP
 * surface (`/health` reports `browsers: pool.size()`) can be wired without
 * blocking on the real implementation.
 */
export class BrowserPool {
  /** Number of currently-open browser instances. Always 0 in this placeholder. */
  size(): number {
    return 0;
  }
}

/** Process-wide singleton. Replace internals in M8 — keep the export name stable. */
export const pool = new BrowserPool();
