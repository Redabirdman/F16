/**
 * Unit tests for `startMaxanceHeartbeat` (M8.T2).
 *
 * Uses Vitest's fake timers to drive ticks deterministically and a stub
 * BrowserPool that returns a configurable Stagehand stub. No real browser.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startMaxanceHeartbeat } from '../../src/maxance/heartbeat.js';
import type { BrowserPool, PooledSession } from '../../src/browser-pool.js';

type StubExtract = (instruction: string, schema: unknown) => Promise<{ pageType: string }>;

interface StubPooledSession {
  sessionId: string;
  name: string;
  createdAt: Date;
  busy: boolean;
  dataDir: string;
  stagehand: { extract: StubExtract };
}

class StubPool {
  session: StubPooledSession | undefined;
  borrowCalls = 0;
  releaseCalls = 0;
  get = (id: string): StubPooledSession | undefined =>
    this.session && this.session.sessionId === id ? this.session : undefined;
  borrow = (id: string): StubPooledSession => {
    if (!this.session || this.session.sessionId !== id) {
      throw new Error(`session ${id} not found`);
    }
    if (this.session.busy) throw new Error(`session ${id} is busy`);
    this.session.busy = true;
    this.borrowCalls += 1;
    return this.session;
  };
  release = (id: string): void => {
    if (this.session && this.session.sessionId === id) this.session.busy = false;
    this.releaseCalls += 1;
  };
}

const asPool = (p: StubPool): BrowserPool => p as unknown as BrowserPool;
const asSession = (s: StubPooledSession): PooledSession => s as unknown as PooledSession;
void asSession; // exported helper isn't used directly — kept for parity with login tests.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeSession(extract: StubExtract): StubPooledSession {
  return {
    sessionId: 'sess-hb',
    name: 'maxance-default',
    createdAt: new Date(),
    busy: false,
    dataDir: '/tmp/hb',
    stagehand: { extract },
  };
}

describe('startMaxanceHeartbeat', () => {
  it('ticks at intervalMs and reports healthy on dashboard', async () => {
    const pool = new StubPool();
    pool.session = makeSession(async () => ({ pageType: 'dashboard' }));
    const pings: Array<{ healthy: boolean; pageType: string }> = [];

    const hb = startMaxanceHeartbeat({
      sessionId: 'sess-hb',
      pool: asPool(pool),
      intervalMs: 1000,
      onPing: (r) => pings.push({ healthy: r.healthy, pageType: r.pageType }),
    });

    await vi.advanceTimersByTimeAsync(1000);
    // Let the async extract resolve.
    await vi.advanceTimersByTimeAsync(0);
    expect(pings.at(-1)).toEqual({ healthy: true, pageType: 'dashboard' });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(pings.length).toBeGreaterThanOrEqual(2);

    hb.stop();
  });

  it('login_form pageType → fires onSessionLost and stops', async () => {
    const pool = new StubPool();
    pool.session = makeSession(async () => ({ pageType: 'login_form' }));
    let lostCalls = 0;

    const hb = startMaxanceHeartbeat({
      sessionId: 'sess-hb',
      pool: asPool(pool),
      intervalMs: 1000,
      onSessionLost: () => {
        lostCalls += 1;
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(lostCalls).toBe(1);

    // No more ticks should fire.
    const beforeBorrows = pool.borrowCalls;
    await vi.advanceTimersByTimeAsync(5000);
    expect(pool.borrowCalls).toBe(beforeBorrows);
    hb.stop();
  });

  it('3 consecutive extract errors → onSessionLost', async () => {
    const pool = new StubPool();
    pool.session = makeSession(async () => {
      throw new Error('extract failed');
    });
    let lostCalls = 0;

    startMaxanceHeartbeat({
      sessionId: 'sess-hb',
      pool: asPool(pool),
      intervalMs: 100,
      onSessionLost: () => {
        lostCalls += 1;
      },
    });

    // Three ticks → three failures → onSessionLost on the third.
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(lostCalls).toBe(1);
  });

  it('stop() prevents further ticks', async () => {
    const pool = new StubPool();
    pool.session = makeSession(async () => ({ pageType: 'dashboard' }));
    const hb = startMaxanceHeartbeat({
      sessionId: 'sess-hb',
      pool: asPool(pool),
      intervalMs: 1000,
    });

    hb.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(pool.borrowCalls).toBe(0);
  });

  it('borrows + releases on every tick (read-only contract)', async () => {
    const pool = new StubPool();
    pool.session = makeSession(async () => ({ pageType: 'dashboard' }));

    startMaxanceHeartbeat({
      sessionId: 'sess-hb',
      pool: asPool(pool),
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.borrowCalls).toBe(1);
    expect(pool.releaseCalls).toBe(1);
  });

  it('skips tick when session is busy (no false session-lost)', async () => {
    const pool = new StubPool();
    pool.session = makeSession(async () => ({ pageType: 'login_form' }));
    if (pool.session) pool.session.busy = true;

    let lostCalls = 0;
    startMaxanceHeartbeat({
      sessionId: 'sess-hb',
      pool: asPool(pool),
      intervalMs: 1000,
      onSessionLost: () => {
        lostCalls += 1;
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    // Busy → tick is a no-op; extract should not have run; no false alarm.
    expect(pool.borrowCalls).toBe(0);
    expect(lostCalls).toBe(0);
  });

  it('missing session in pool → onSessionLost', async () => {
    const pool = new StubPool();
    let lostCalls = 0;
    startMaxanceHeartbeat({
      sessionId: 'sess-missing',
      pool: asPool(pool),
      intervalMs: 1000,
      onSessionLost: () => {
        lostCalls += 1;
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(lostCalls).toBe(1);
  });
});
