/**
 * Unit tests for the devis-inbox watcher's SELF-HEALING reconnect (the
 * 2026-07-05 prod bug: the overnight IMAP drop left every 20s sweep failing
 * with "Connection not available" forever — the watcher never reconnected
 * and the devis PDF relay was dead until a manual backend restart).
 *
 * No infra required: `imapflow` is module-mocked with a controllable fake
 * client, the dispatcher is mocked (sweeps here never find messages), and
 * fake timers drive the poll/backoff schedule deterministically.
 *
 * Covered:
 *   - reconnects after a sweep-detected connection loss AND after a
 *     client 'close' event, resuming sweeps on the NEW client,
 *   - single-flight reconnect (overlapping loss signals never spawn
 *     parallel IMAP connections),
 *   - sweeps while down skip quickly without warn-spam (one warn per
 *     state change),
 *   - auth failures (535 / invalid credentials) retry only at the max
 *     backoff (no hot retry-loop against Google).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Database } from '../../src/db/index.js';

const h = vi.hoisted(() => {
  const state = {
    instances: [] as any[],
    /** Per-connect behaviors, consumed in order; default = resolve. */
    connectQueue: [] as Array<() => Promise<void>>,
  };

  class FakeImapFlow {
    opts: unknown;
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    /** When set, mailbox operations throw this (simulates a dead session). */
    failWith: Error | null = null;
    searchCalls = 0;
    loggedOut = false;

    constructor(opts: unknown) {
      this.opts = opts;
      state.instances.push(this);
    }

    on(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }

    /** Test helper — fire a registered event ('close', 'error'). */
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }

    connect(): Promise<void> {
      const impl = state.connectQueue.shift();
      return impl ? impl() : Promise.resolve();
    }

    async logout(): Promise<void> {
      this.loggedOut = true;
    }

    async getMailboxLock(_mailbox: string): Promise<{ release(): void }> {
      if (this.failWith) throw this.failWith;
      return { release: () => undefined };
    }

    async search(_query: unknown): Promise<number[]> {
      if (this.failWith) throw this.failWith;
      this.searchCalls += 1;
      return [];
    }

    async fetchOne(): Promise<Record<string, unknown>> {
      return {};
    }

    async messageFlagsAdd(): Promise<boolean> {
      return true;
    }
  }

  return { state, FakeImapFlow };
});

vi.mock('imapflow', () => ({ ImapFlow: h.FakeImapFlow }));
vi.mock('../../src/messaging/dispatcher.js', () => ({ sendMessage: vi.fn() }));

import {
  startDevisInboxWatcher,
  isConnectionError,
  isAuthError,
} from '../../src/channels/devis-inbox.js';
import { logger } from '../../src/logger.js';

const POLL_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;

const fakeDb = {} as unknown as Database;

/** Flush pending microtasks under fake timers. */
const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0) as unknown as Promise<void>;

describe('devis-inbox self-healing reconnect', () => {
  let watcher: { stop(): Promise<void> } | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('F16_DEVIS_INBOX', '1');
    vi.stubEnv('SMTP_USER', 'contact@assuryalconseil.fr');
    vi.stubEnv('SMTP_PASS', 'app-password');
    h.state.instances.length = 0;
    h.state.connectQueue.length = 0;
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.stop();
      watcher = null;
    }
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reconnects after a sweep fails with "Connection not available" and resumes on the new client', async () => {
    watcher = startDevisInboxWatcher({ db: fakeDb });
    expect(watcher).not.toBeNull();
    await flush();

    expect(h.state.instances).toHaveLength(1);
    const c1 = h.state.instances[0];
    // The first sweep runs immediately after connect.
    expect(c1.searchCalls).toBeGreaterThan(0);

    // Kill the session: the next sweep fails like the live overnight drop.
    c1.failWith = new Error('Connection not available');
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // Watcher reconnected (new client), old one disposed.
    expect(h.state.instances).toHaveLength(2);
    expect(c1.loggedOut).toBe(true);

    // Sweeps resume on the NEW client.
    const c2 = h.state.instances[1];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(c2.searchCalls).toBeGreaterThan(0);
  });

  it("reconnects when the client emits 'close'", async () => {
    watcher = startDevisInboxWatcher({ db: fakeDb });
    await flush();
    expect(h.state.instances).toHaveLength(1);

    h.state.instances[0].emit('close');
    await flush();

    expect(h.state.instances).toHaveLength(2);
  });

  it('never spawns parallel reconnects when loss is detected multiple ways', async () => {
    watcher = startDevisInboxWatcher({ db: fakeDb });
    await flush();
    const c1 = h.state.instances[0];

    // The replacement connect hangs, keeping the reconnect in-flight.
    let releaseConnect!: () => void;
    h.state.connectQueue.push(
      () =>
        new Promise<void>((r) => {
          releaseConnect = r;
        }),
    );

    // Loss detected via event AND via failing sweeps AND repeated events.
    c1.failWith = new Error('Connection not available');
    c1.emit('close');
    await flush();
    c1.emit('close');
    c1.emit('error', new Error('read ECONNRESET'));
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);

    // Exactly ONE replacement client was created (still connecting).
    expect(h.state.instances).toHaveLength(2);

    releaseConnect();
    await flush();
    // Recovered — still no extra connections.
    expect(h.state.instances).toHaveLength(2);
  });

  it('skips sweeps quietly while the connection is down (no warn-spam per tick)', async () => {
    watcher = startDevisInboxWatcher({ db: fakeDb });
    await flush();
    const c1 = h.state.instances[0];

    // Keep the reconnect pending so the watcher stays "down".
    h.state.connectQueue.push(() => new Promise<void>(() => undefined));
    c1.emit('close');
    await flush();

    const warnSpy = vi.spyOn(logger, 'warn');
    const c2 = h.state.instances[1];
    const sweepsBefore = c1.searchCalls + c2.searchCalls;

    await vi.advanceTimersByTimeAsync(3 * POLL_MS);

    // No sweeps ran while down, and no warns were emitted per tick — the
    // single state-change warn happened before the spy was installed.
    expect(c1.searchCalls + c2.searchCalls).toBe(sweepsBefore);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('retries auth failures only at the max backoff (App Password revoked)', async () => {
    const authErr = Object.assign(new Error('Invalid credentials (Failure)'), {
      authenticationFailed: true,
    });
    h.state.connectQueue.push(() => Promise.reject(authErr));

    const errorSpy = vi.spyOn(logger, 'error');
    watcher = startDevisInboxWatcher({ db: fakeDb });
    await flush();

    // First attempt failed loudly at error level.
    expect(h.state.instances).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ retryInMs: MAX_BACKOFF_MS }),
      expect.stringContaining('auth'),
    );

    // No hot retry: nothing new before the max backoff elapses.
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS - 1_000);
    expect(h.state.instances).toHaveLength(1);

    // At the max backoff the retry fires (and succeeds by default).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.state.instances).toHaveLength(2);
  });

  it('classifies errors correctly (connection vs auth)', () => {
    expect(isConnectionError(new Error('Connection not available'))).toBe(true);
    expect(isConnectionError(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isConnectionError(new Error('read ECONNRESET'))).toBe(true);
    expect(isConnectionError(new Error('socket hang up'))).toBe(true);
    // Auth errors are NOT connection-class (different retry policy).
    expect(isConnectionError(new Error('535 5.7.8 Invalid credentials'))).toBe(false);
    expect(isAuthError(new Error('535 5.7.8 Invalid credentials'))).toBe(true);
    expect(
      isAuthError(Object.assign(new Error('login failed'), { authenticationFailed: true })),
    ).toBe(true);
    // A missing Spam folder is neither — it must not trigger a reconnect.
    expect(isConnectionError(new Error('Mailbox does not exist'))).toBe(false);
    expect(isAuthError(new Error('Mailbox does not exist'))).toBe(false);
  });
});
