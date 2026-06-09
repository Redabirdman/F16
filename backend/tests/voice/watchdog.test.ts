/**
 * Self-healing voice watchdog tests — pure, no WSL/network (inject the runner).
 */
import { describe, it, expect } from 'vitest';
import { decideHeal, watchdogTick, startVoiceWatchdog } from '../../src/voice/watchdog.js';

const REG_OK = ' ovh-trunk/sip:sip-domain.io   ovh-trunk-auth   Registered   (exp. 3586s)';
const REG_STALE = ' ovh-trunk/sip:sip-domain.io   ovh-trunk-auth   Registered   (exp. 73120s ago)';
const REG_REJECTED = ' ovh-trunk/sip:sip-domain.io   ovh-trunk-auth   Rejected   (exp. 27s)';
const REG_UNREG = ' ovh-trunk/sip:sip-domain.io   ovh-trunk-auth   Unregistered   (exp. 3s)';

describe('decideHeal', () => {
  it('ok when active + registered with positive expiry', () => {
    expect(decideHeal('active', REG_OK)).toEqual({ heal: false, reason: 'ok' });
  });
  it('heals when asterisk is not active', () => {
    expect(decideHeal('inactive', REG_OK)).toEqual({ heal: true, reason: 'asterisk_not_active' });
    expect(decideHeal('failed', REG_OK).heal).toBe(true);
  });
  it('heals on a stale (expired "ago") registration', () => {
    expect(decideHeal('active', REG_STALE)).toEqual({ heal: true, reason: 'ovh_stale' });
  });
  it('heals on Rejected / Unregistered', () => {
    expect(decideHeal('active', REG_REJECTED).reason).toBe('ovh_stale');
    expect(decideHeal('active', REG_UNREG).reason).toBe('ovh_stale');
  });
  it('heals when the trunk line is missing entirely', () => {
    expect(decideHeal('active', undefined).reason).toBe('ovh_stale');
  });
});

describe('watchdogTick', () => {
  it('does NOT restart when healthy', async () => {
    const cmds: string[] = [];
    const run = async (bash: string): Promise<string> => {
      cmds.push(bash);
      return `ACTIVE=active\nREG=${REG_OK}`;
    };
    const d = await watchdogTick(run);
    expect(d).toEqual({ heal: false, reason: 'ok' });
    expect(cmds.some((c) => /restart asterisk/.test(c))).toBe(false);
  });

  it('restarts asterisk when the registration is stale', async () => {
    const cmds: string[] = [];
    const run = async (bash: string): Promise<string> => {
      cmds.push(bash);
      return `ACTIVE=active\nREG=${REG_STALE}`;
    };
    const d = await watchdogTick(run);
    expect(d.reason).toBe('ovh_stale');
    expect(cmds.some((c) => c.includes('systemctl restart asterisk'))).toBe(true);
  });

  it('restarts asterisk when it is not active', async () => {
    const cmds: string[] = [];
    const run = async (bash: string): Promise<string> => {
      cmds.push(bash);
      return 'ACTIVE=inactive\nREG=';
    };
    const d = await watchdogTick(run);
    expect(d.reason).toBe('asterisk_not_active');
    expect(cmds.some((c) => c.includes('systemctl restart asterisk'))).toBe(true);
  });

  it('a probe failure is swallowed (returns ok, retries next tick)', async () => {
    const run = async (): Promise<string> => {
      throw new Error('wsl unreachable');
    };
    const d = await watchdogTick(run);
    expect(d).toEqual({ heal: false, reason: 'ok' });
  });
});

describe('startVoiceWatchdog', () => {
  it('is a no-op when disabled (non-Windows)', async () => {
    const h = startVoiceWatchdog({ enabledOverride: false });
    expect((await h.tickOnce()).reason).toBe('ok');
    h.stop();
  });

  it('runs an immediate tick via the injected runner (no keepalive)', async () => {
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      return `ACTIVE=active\nREG=${REG_OK}`;
    };
    const h = startVoiceWatchdog({
      enabledOverride: true,
      noKeepalive: true,
      runner: run,
      intervalMs: 60_000,
    });
    const d = await h.tickOnce();
    expect(d.reason).toBe('ok');
    expect(calls).toBeGreaterThanOrEqual(1);
    h.stop();
  });
});
