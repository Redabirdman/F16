/**
 * Per-session keep-alive ping for Maxance (M8.T2).
 *
 * Design rationale: Maxance's session window is ~30 days, but idle bounces
 * still happen — TLS resets, server-side cleanup, or our own laptop sleeping.
 * The heartbeat polls every interval (default 5min), does a strictly READ-ONLY
 * `extract` against the active page, and either confirms health or signals
 * loss-of-session via `onSessionLost`.
 *
 * IMPORTANT: this is a pure read. We never click, type, navigate, or mutate.
 * The only side-effect is one `extract` call, which costs ~$0.001 in Sonnet
 * tokens — cheap enough to run on every active session indefinitely.
 *
 * The heartbeat does NOT auto-start with the pool. M8.T4 (Maxance Operator
 * agent) decides when to attach one — typically right after a successful
 * `loginMaxance` returns.
 */
import { z } from 'zod';
import { logger } from '../logger.js';
import type { BrowserPool } from '../browser-pool.js';

const HEALTHY_PAGE_TYPES = ['dashboard', 'proximeo_home'] as const;
// Either step of the auth flow means we got logged out and bounced back to
// login. Treat both as "session lost" so the supervisor re-runs loginMaxance.
const LOST_SESSION_PAGE_TYPES = ['login_form', 'password_form', 'sms_prompt'] as const;

const HeartbeatDetection = z.object({
  pageType: z.enum([
    'dashboard',
    'proximeo_home',
    'login_form',
    'password_form',
    'sms_prompt',
    'unknown',
  ]),
});

const HeartbeatInstruction =
  'What kind of page is currently displayed on Maxance? Reply with one of:' +
  ' "dashboard" (broker dashboard with sidebar links),' +
  ' "proximeo_home" (Proximéo home with "Tarif - Nouveau Client" menu),' +
  ' "login_form" (the login form\'s identifiant step is shown — session expired),' +
  ' "password_form" (the login form\'s password step is shown — session expired),' +
  ' "sms_prompt" (asking for an SMS code — session expired),' +
  ' "unknown" (anything else).';

export interface HeartbeatPingResult {
  healthy: boolean;
  at: Date;
  pageType: string;
}

export interface HeartbeatOptions {
  /** Session id from the BrowserPool. */
  sessionId: string;
  /**
   * BrowserPool to borrow from. Injectable so tests can pass a stub without
   * touching the global pool. Defaults to the module-level singleton.
   */
  pool: BrowserPool;
  /** Tick interval. Default 5 minutes. */
  intervalMs?: number;
  /**
   * Invoked once, when the session is determined to be lost (login_form
   * detected OR 3+ consecutive errors). The heartbeat STOPS after this call —
   * it's the listener's responsibility to re-login if desired.
   */
  onSessionLost?: () => Promise<void> | void;
  /** Optional per-tick hook for telemetry / admin dashboards. */
  onPing?: (result: HeartbeatPingResult) => void;
}

export interface HeartbeatHandle {
  /** Stop the heartbeat. Idempotent. Subsequent ticks become no-ops. */
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const FAILURE_THRESHOLD = 3;

/**
 * Start a heartbeat for one session. Returns a handle to stop it.
 *
 * Tick flow:
 *   1. borrow the session (skip the tick if it's busy — another caller has it)
 *   2. extract { pageType }
 *   3. release
 *   4. healthy ('dashboard' | 'proximeo_home') → schedule next tick
 *      lost ('login_form' | 'sms_prompt') → onSessionLost, STOP
 *      unknown → treated as a soft error (counts toward FAILURE_THRESHOLD)
 *
 * Borrow contention is treated as a no-op rather than a failure: a quote-flow
 * intent holding the session shouldn't trigger a false session-lost signal.
 */
export function startMaxanceHeartbeat(opts: HeartbeatOptions): HeartbeatHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let consecutiveFailures = 0;
  let sessionLostFired = false;

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const fireSessionLost = async (): Promise<void> => {
    if (sessionLostFired) return;
    sessionLostFired = true;
    stopped = true;
    try {
      await opts.onSessionLost?.();
    } catch (err) {
      logger.warn(
        { err, sessionId: opts.sessionId },
        'maxance heartbeat: onSessionLost handler threw',
      );
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;

    let borrowed = false;
    try {
      // Skip tick if session is busy — don't block / race a quote-flow intent.
      const s = opts.pool.get(opts.sessionId);
      if (!s) {
        // Session vanished from the pool → nothing to heartbeat. Treat as lost.
        await fireSessionLost();
        return;
      }
      if (s.busy) {
        return;
      }
      opts.pool.borrow(opts.sessionId);
      borrowed = true;

      const out = await s.stagehand.extract(HeartbeatInstruction, HeartbeatDetection);
      const pageType = out.pageType;
      const now = new Date();

      if ((HEALTHY_PAGE_TYPES as readonly string[]).includes(pageType)) {
        consecutiveFailures = 0;
        opts.onPing?.({ healthy: true, at: now, pageType });
      } else if ((LOST_SESSION_PAGE_TYPES as readonly string[]).includes(pageType)) {
        opts.onPing?.({ healthy: false, at: now, pageType });
        await fireSessionLost();
      } else {
        consecutiveFailures += 1;
        opts.onPing?.({ healthy: false, at: now, pageType });
        if (consecutiveFailures >= FAILURE_THRESHOLD) {
          await fireSessionLost();
        }
      }
    } catch (err) {
      consecutiveFailures += 1;
      logger.warn(
        { err, sessionId: opts.sessionId, consecutiveFailures },
        'maxance heartbeat: tick error',
      );
      if (consecutiveFailures >= FAILURE_THRESHOLD) {
        await fireSessionLost();
      }
    } finally {
      if (borrowed) opts.pool.release(opts.sessionId);
      if (!stopped) {
        timer = setTimeout(() => {
          void tick();
        }, intervalMs);
      }
    }
  };

  // Schedule the first tick after one interval — don't fire immediately, the
  // session is presumed-healthy right after login.
  timer = setTimeout(() => {
    void tick();
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
