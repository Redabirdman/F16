/**
 * Stagehand session manager (M8.T1).
 *
 * One **session** = one Stagehand V3 instance backed by one local Chromium
 * via a per-session `userDataDir` so cookies, localStorage, and signed-in state
 * survive across `act`/`extract`/`observe` intents within the same logical run.
 *
 * Stagehand V3 surface used (from `@browserbasehq/stagehand@3.4.0`):
 *   - `new Stagehand({ env: 'LOCAL', model: ..., localBrowserLaunchOptions })`
 *   - `await stagehand.init()`
 *   - `stagehand.context.activePage()` returns a V3 `Page` exposing
 *     `goto`, `url()`, `title()`, `screenshot()`.
 *   - `stagehand.act|extract|observe(instruction, ...)` — these live on the
 *     Stagehand instance, NOT on `stagehand.page` (a common drift from V2 docs).
 *
 * Borrow/release is atomic so concurrent intents on the same session error
 * cleanly instead of racing on the underlying Chromium target.
 *
 * Multi-tenant note: each session's userDataDir lives under
 * `<dataRoot>/sessions/<sessionId>`. Close keeps the directory on disk by
 * default so a follow-up Maxance run with the same `name` could be wired to
 * reuse cookies (M8.T2). For now sessions die with the process — persistence
 * across restarts is a name-based opt-in we don't enable here.
 */
import { Stagehand } from '@browserbasehq/stagehand';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.js';

export interface SessionInfo {
  sessionId: string;
  name: string;
  createdAt: Date;
  busy: boolean;
}

export interface SessionCreateOptions {
  name?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
}

/**
 * Internal record. Not exported because callers only need the public
 * `SessionInfo` view; the live Stagehand handle is borrowed via `borrow()`.
 */
export interface PooledSession {
  sessionId: string;
  name: string;
  createdAt: Date;
  stagehand: Stagehand;
  busy: boolean;
  dataDir: string;
}

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

export class BrowserPool {
  private sessions = new Map<string, PooledSession>();
  private readonly dataRoot: string;

  constructor(opts: { dataRoot?: string } = {}) {
    this.dataRoot = opts.dataRoot ?? process.env.STAGEHAND_DATA_DIR ?? './data';
  }

  /** Currently-open session count. Drives /health's `browsers` field. */
  size(): number {
    return this.sessions.size;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      name: s.name,
      createdAt: s.createdAt,
      busy: s.busy,
    }));
  }

  /**
   * Launch a Stagehand instance + its Chromium and register it.
   * Throws if `ANTHROPIC_API_KEY` is missing — Stagehand's `act`/`extract`/`observe`
   * need an LLM to interpret natural-language instructions. We don't fall back to
   * OpenAI here; the F16 platform is Anthropic-first (per `project_llm_sdk_swap`).
   */
  async create(opts: SessionCreateOptions = {}): Promise<SessionInfo> {
    const sessionId = randomUUID();
    const name = opts.name ?? `session-${sessionId.slice(0, 8)}`;
    const dataDir = join(this.dataRoot, 'sessions', sessionId);
    await mkdir(dataDir, { recursive: true });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY required to launch Stagehand');
    }

    // STAGEHAND_BROWSER_HEADLESS=false flips to headed. Default headless.
    const envHeadless = process.env.STAGEHAND_BROWSER_HEADLESS;
    const headless = opts.headless ?? envHeadless !== 'false';

    const stagehand = new Stagehand({
      env: 'LOCAL',
      // V3 takes model as a single field carrying both modelName + clientOptions.
      // Drift from M8 design snippet: there is no `modelName` / `modelClientOptions`
      // at the top level. The string form selects defaults; the object form lets
      // us pass the Anthropic API key explicitly (which is what we want).
      model: {
        modelName: DEFAULT_MODEL,
        apiKey,
      },
      localBrowserLaunchOptions: {
        headless,
        userDataDir: dataDir,
        ...(opts.viewport ? { viewport: opts.viewport } : {}),
      },
      verbose: 0,
    });

    await stagehand.init();
    logger.info({ sessionId, name, dataDir, headless }, 'stagehand: session created');

    const s: PooledSession = {
      sessionId,
      name,
      createdAt: new Date(),
      stagehand,
      busy: false,
      dataDir,
    };
    this.sessions.set(sessionId, s);
    return { sessionId, name, createdAt: s.createdAt, busy: false };
  }

  get(sessionId: string): PooledSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Atomic borrow — flips busy=true and returns the live session record.
   * Throws on unknown id or if another caller already holds it. Callers MUST
   * `release()` in a `finally` block to avoid leaks.
   */
  borrow(sessionId: string): PooledSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} not found`);
    if (s.busy) throw new Error(`session ${sessionId} is busy`);
    s.busy = true;
    return s;
  }

  release(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.busy = false;
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      await s.stagehand.close();
    } catch (err) {
      logger.warn({ err, sessionId }, 'stagehand close threw');
    }
    // Intentionally keep `dataDir` on disk — caller decides cleanup. M16 will add
    // a sweep job; for now a long-lived process can pile up directories under
    // STAGEHAND_DATA_DIR/sessions/ and that's acceptable.
    this.sessions.delete(sessionId);
    logger.info({ sessionId }, 'stagehand: session closed');
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.close(id);
    }
  }
}

/** Process-wide singleton consumed by the HTTP routes + the shutdown hook. */
export const pool = new BrowserPool();
