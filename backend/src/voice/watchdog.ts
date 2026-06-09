/**
 * Self-healing voice watchdog (2026-06-09).
 *
 * The voice stack has two recurring SILENT failure modes that killed live calls
 * during testing and MUST NOT happen in production:
 *
 *   1. OVH SIP registration goes STALE — Asterisk still prints "Registered" but
 *      the binding expired ("exp. NNNNs ago") or flipped to "Rejected", so OVH
 *      returns "403 not registered" on every outbound call → the phone never
 *      rings. The ONLY clean fix is `systemctl restart asterisk` (a manual
 *      `pjsip send register` makes it WORSE — it lands in "Rejected").
 *   2. The WSL distro auto-shuts-down ~8s after the last `wsl.exe` exits when
 *      nothing holds it open → Asterisk dies → 0 calls. A persistent keepalive
 *      (`exec sleep infinity`) holds it open.
 *
 * This watchdog handles BOTH, network-independently (via `wsl.exe`, no IP):
 *   - Owns a persistent keepalive child that holds the WSL distro open; respawns
 *     it with backoff if it dies.
 *   - Every `intervalMs` (default 60s): checks Asterisk is active + the OVH
 *     registration is truly valid; restarts Asterisk to self-heal otherwise.
 *
 * Windows-only (uses `wsl.exe`); disabled cleanly elsewhere. Env-gated.
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';
import { recordVoiceWatchdogHeal, voiceOvhRegisteredGauge } from '../metrics/index.js';

const pexec = promisify(execFile);

const DEFAULT_INTERVAL_MS = 60_000;

/** Probe: raw is-active + registrations table, split by a sentinel (no `$(...)`). */
const PROBE_SEP = '---F16SEP---';
const PROBE_CMD =
  `systemctl is-active asterisk 2>/dev/null; echo '${PROBE_SEP}'; ` +
  `asterisk -rx 'pjsip show registrations' 2>/dev/null`;

export interface HealDecision {
  heal: boolean;
  reason: 'ok' | 'asterisk_not_active' | 'ovh_stale';
}

/**
 * Pure heal-decision from the probe outputs (kept separate so it's unit-testable
 * without WSL). `active` = `systemctl is-active asterisk` output; `regLine` =
 * the `pjsip show registrations` line for the OVH trunk (or undefined).
 *
 * Stale = trunk line missing, not "Registered", or expiry shown as "...ago".
 */
export function decideHeal(active: string, regLine: string | undefined): HealDecision {
  if (active.trim() !== 'active') return { heal: true, reason: 'asterisk_not_active' };
  if (!regLine || !/Registered/.test(regLine) || /\bago\b/.test(regLine)) {
    return { heal: true, reason: 'ovh_stale' };
  }
  return { heal: false, reason: 'ok' };
}

/** Runs a bash command inside the WSL distro as root. Injectable for tests. */
export type WslRunner = (bash: string) => Promise<string>;

function defaultRunner(distro: string, timeoutMs: number): WslRunner {
  return async (bash: string): Promise<string> => {
    const { stdout, stderr } = await pexec(
      'wsl.exe',
      ['-d', distro, '-u', 'root', 'bash', '-lc', bash],
      {
        timeout: timeoutMs,
        windowsHide: true,
      },
    );
    return `${stdout}\n${stderr}`;
  };
}

export interface VoiceWatchdogOptions {
  intervalMs?: number;
  distro?: string;
  /** Probe/heal runner — defaults to wsl.exe. Tests inject a fake. */
  runner?: WslRunner;
  /** Disable the persistent keepalive child (tests). Default: spawn it. */
  noKeepalive?: boolean;
  /** Override platform gate (tests). Default: process.platform === 'win32'. */
  enabledOverride?: boolean;
}

export interface VoiceWatchdogHandle {
  stop(): void;
  /** Run one check/heal cycle (also exposed for tests). */
  tickOnce(): Promise<HealDecision>;
}

/**
 * One probe + heal cycle: read Asterisk state, decide, restart if needed.
 * Best-effort — a transient wsl.exe error logs + returns ok (next tick retries).
 */
export async function watchdogTick(run: WslRunner): Promise<HealDecision> {
  let out: string;
  try {
    // Single round-trip. NOTE: we deliberately AVOID `$(...)` command
    // substitution + variable assignment — `wsl.exe` pre-evaluates them before
    // bash runs, which mangles the output (the registration text contains `(`).
    // Instead emit raw output split by a sentinel and parse in TS.
    out = await run(PROBE_CMD);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'voice-watchdog: probe failed (will retry next tick)',
    );
    return { heal: false, reason: 'ok' };
  }

  const [activePart = '', regPart = ''] = out.split(PROBE_SEP);
  const active = activePart.trim();
  const regLine =
    regPart
      .split('\n')
      .find((l) => /ovh-trunk/i.test(l))
      ?.trim() || undefined;
  const decision = decideHeal(active, regLine);

  voiceOvhRegisteredGauge().set(decision.reason === 'ok' ? 1 : 0);

  if (decision.heal) {
    recordVoiceWatchdogHeal(decision.reason);
    logger.warn(
      { reason: decision.reason, active, regLine },
      'voice-watchdog: healing — restarting asterisk',
    );
    try {
      await run('systemctl restart asterisk');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'voice-watchdog: systemctl restart asterisk FAILED',
      );
    }
  }
  return decision;
}

/**
 * Start the watchdog: a persistent keepalive child (holds the distro open) +
 * a periodic check/heal loop. Returns a handle with stop().
 */
export function startVoiceWatchdog(opts: VoiceWatchdogOptions = {}): VoiceWatchdogHandle {
  const enabled = opts.enabledOverride ?? process.platform === 'win32';
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const distro = opts.distro ?? process.env.WSL_DISTRO ?? 'Ubuntu';
  const run = opts.runner ?? defaultRunner(distro, 20_000);

  if (!enabled) {
    logger.info('voice-watchdog: disabled (non-Windows / no WSL)');
    return { stop: () => undefined, tickOnce: async () => ({ heal: false, reason: 'ok' }) };
  }

  // 1. Persistent keepalive child — holds the WSL distro open so Asterisk never
  //    gets torn down between ticks. Respawn with backoff if it dies.
  let stopped = false;
  let keepaliveProc: ReturnType<typeof spawn> | null = null;
  const spawnKeepalive = (): void => {
    if (stopped || opts.noKeepalive) return;
    try {
      keepaliveProc = spawn(
        'wsl.exe',
        ['-d', distro, '-u', 'root', 'bash', '-lc', 'exec sleep infinity'],
        {
          windowsHide: true,
          stdio: 'ignore',
        },
      );
      keepaliveProc.on('exit', () => {
        keepaliveProc = null;
        if (!stopped) setTimeout(spawnKeepalive, 3_000);
      });
      keepaliveProc.on('error', (err) =>
        logger.warn({ err: err.message }, 'voice-watchdog: keepalive spawn error'),
      );
      logger.info({ distro }, 'voice-watchdog: keepalive holding WSL distro open');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'voice-watchdog: keepalive could not spawn',
      );
    }
  };
  spawnKeepalive();

  // 2. Periodic check/heal loop.
  const tick = (): Promise<HealDecision> =>
    watchdogTick(run).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'voice-watchdog: tick threw',
      );
      return { heal: false, reason: 'ok' as const };
    });
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);

  logger.info({ intervalMs, distro }, 'voice-watchdog: started');
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
      if (keepaliveProc) {
        try {
          keepaliveProc.kill();
        } catch {
          /* ignore */
        }
        keepaliveProc = null;
      }
    },
    tickOnce: tick,
  };
}
