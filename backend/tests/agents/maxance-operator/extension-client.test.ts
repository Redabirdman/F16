/**
 * Unit tests for the V1 ExtensionClient (M8.T8 phase 2c).
 *
 * Spawns a real WebSocket server on a random localhost port (the
 * ExtensionClient's own start()), connects a stub WS client that pretends
 * to be the Chrome extension, exchanges wire frames, and asserts the
 * client's method surface behaves like the StagehandClient one.
 *
 * No browser. No real Maxance. ~200ms total runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import {
  ExtensionClient,
  ExtensionClientError,
} from '../../../src/agents/maxance-operator/extension-client.js';
import type { Command, Response } from '@f16/extension/wire';

/**
 * Ask the OS for a guaranteed-free ephemeral port: bind a throwaway server
 * to port 0, read back the assigned port, then close it. The kernel won't
 * immediately re-hand the same port on the next bind in this tight window,
 * so each harness gets a distinct, currently-unused port. This avoids the
 * EADDRINUSE flakes the old `19_000 + random(30_000)` picker hit when it
 * collided with a real listener on this machine (this PC runs a live Maxance
 * extension WS keepalive) or with a sibling test still releasing its socket.
 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

interface Harness {
  client: ExtensionClient;
  /** Stub extension socket — connects outbound just like the real extension. */
  fakeExt: WsClient;
  port: number;
  receivedCommands: Command[];
  cleanup: () => Promise<void>;
}

async function newHarness(opts: { autoReply?: boolean } = {}): Promise<Harness> {
  const port = await freePort();
  const client = new ExtensionClient({ port, timeoutMs: 2_000 });
  await client.start();

  const receivedCommands: Command[] = [];
  const fakeExt = new WsClient(`ws://127.0.0.1:${port}`);

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('fake_ext_open_timeout')), 2_000);
    fakeExt.once('open', () => {
      clearTimeout(t);
      resolve();
    });
    fakeExt.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });

  fakeExt.on('message', (raw) => {
    const text = typeof raw === 'string' ? raw : raw.toString();
    const parsed = JSON.parse(text) as Command;
    receivedCommands.push(parsed);
    if (opts.autoReply) autoReplyTo(fakeExt, parsed);
  });

  // Give the server a tick to notice the connection before we start sending.
  await new Promise((r) => setTimeout(r, 50));

  return {
    client,
    fakeExt,
    port,
    receivedCommands,
    cleanup: async () => {
      try {
        fakeExt.close();
      } catch {
        /* noop */
      }
      await client.stop();
    },
  };
}

function autoReplyTo(sock: WsClient, cmd: Command): void {
  let resp: Response;
  switch (cmd.kind) {
    case 'ping':
      resp = { id: cmd.id, kind: 'pong', ...(cmd.nonce ? { nonce: cmd.nonce } : {}) };
      break;
    case 'login.ensure':
      resp = {
        id: cmd.id,
        kind: 'login.ensure.ok',
        alreadyLoggedIn: true,
        requiredHumanAction: false,
        finalUrl: 'https://www.maxance.com/Proximeo/',
        durationMs: 42,
      };
      break;
    case 'quote.preview':
      resp = {
        id: cmd.id,
        kind: 'quote.preview.ok',
        pricePreviewEur: { monthly: 18.95, annual: 90.85 },
        screenshots: [],
        finalUrl: 'https://www.maxance.com/Proximeo/x',
        durationMs: 1234,
      };
      break;
    case 'quote.confirm':
      resp = {
        id: cmd.id,
        kind: 'quote.confirm.ok',
        devisNumber: 'DR0000973579',
        pdfSentTo: cmd.subscriber.email,
        screenshots: [],
        finalUrl: 'https://www.maxance.com/Proximeo/souscriptionDevisValiderFinaleMoto.do',
        durationMs: 5678,
      };
      break;
    default:
      throw new Error(`autoReplyTo: unhandled command kind '${(cmd as { kind: string }).kind}'`);
  }
  sock.send(JSON.stringify(resp));
}

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

beforeEach(() => {
  // each test runs newHarness() as needed
});

describe('ExtensionClient — connection lifecycle', () => {
  it('starts a WS server and reports connected when an extension joins', async () => {
    harness = await newHarness();
    expect(harness.client.isConnected()).toBe(true);
  });

  it('reports not connected after the extension closes', async () => {
    harness = await newHarness();
    harness.fakeExt.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(harness.client.isConnected()).toBe(false);
  });
});

describe('ExtensionClient — ping/health', () => {
  it('round-trips a ping → pong via health()', async () => {
    harness = await newHarness({ autoReply: true });
    await expect(harness.client.health()).resolves.toEqual({ status: 'ok' });
    expect(harness.receivedCommands).toHaveLength(1);
    expect(harness.receivedCommands[0]?.kind).toBe('ping');
  });

  it('returns no_extension when no extension is connected', async () => {
    const port = await freePort();
    const client = new ExtensionClient({ port, timeoutMs: 1_000 });
    await client.start();
    await expect(client.health()).resolves.toEqual({ status: 'no_extension' });
    await client.stop();
  });
});

describe('ExtensionClient — login/quote/confirm method surface', () => {
  it('ensureLoggedIn round-trips and maps to LoginResult shape', async () => {
    harness = await newHarness({ autoReply: true });
    const res = await harness.client.ensureLoggedIn();
    expect(res.alreadyLoggedIn).toBe(true);
    expect(res.requiredHumanAction).toBe(false);
    expect(res.finalUrl).toMatch(/maxance/);
    expect(res.durationMs).toBe(42);
  });

  it('runQuote sends the QuoteParams over the wire (ISO-normalised)', async () => {
    harness = await newHarness({ autoReply: true });
    const res = await harness.client.runQuote('any', {
      vehicleKind: 'trottinette',
      purchasePriceEur: 350,
      purchaseDate: new Date('2026-01-15T12:34:56Z'),
      postalCode: '75001',
      stationnement: 'garage_box',
      clientDateOfBirth: '1990-06-12',
    });
    expect(res.pricePreviewEur.monthly).toBe(18.95);
    expect(res.pricePreviewEur.annual).toBe(90.85);
    // Wire-side normalisation: dates flow as YYYY-MM-DD strings.
    const sent = harness.receivedCommands[0];
    expect(sent?.kind).toBe('quote.preview');
    if (sent?.kind === 'quote.preview') {
      expect(sent.params.purchaseDate).toBe('2026-01-15');
      expect(sent.params.clientDateOfBirth).toBe('1990-06-12');
      expect(sent.dryRun).toBe(true);
    }
  });

  it('confirmQuote returns devisNumber + pdfSentTo from the wire response', async () => {
    harness = await newHarness({ autoReply: true });
    const res = await harness.client.confirmQuote(
      'any',
      {
        civilite: 'monsieur',
        lastName: 'LEFRIEKH',
        firstName: 'Ridaa',
        addressLine: '12 RUE DE LA PAIX',
        postalCode: '75001',
        city: 'PARIS',
        phoneMobile: '0612345678',
        email: 'r.lefriekh@hotmail.com',
      },
      { dryRun: true },
    );
    expect(res.devisNumber).toBe('DR0000973579');
    expect(res.pdfSentTo).toBe('r.lefriekh@hotmail.com');
    const sent = harness.receivedCommands[0];
    expect(sent?.kind).toBe('quote.confirm');
    if (sent?.kind === 'quote.confirm') {
      expect(sent.dryRun).toBe(true);
      expect(sent.subscriber.civilite).toBe('monsieur');
    }
  });
});

describe('ExtensionClient — error path', () => {
  it('throws ExtensionClientError with the wire errorCode when extension replies with error', async () => {
    harness = await newHarness();
    // Custom auto-reply: respond with an error envelope.
    harness.fakeExt.on('message', (raw) => {
      const cmd = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as Command;
      harness!.fakeExt.send(
        JSON.stringify({
          id: cmd.id,
          kind: 'error',
          errorCode: 'maxance_quote_unexpected_pricing_page',
          detail: 'price never settled',
        }),
      );
    });
    try {
      await harness.client.runQuote('any', {
        vehicleKind: 'trottinette',
        purchasePriceEur: 350,
        purchaseDate: '2026-01-15',
        postalCode: '75001',
        stationnement: 'garage_box',
        clientDateOfBirth: '1990-06-12',
      });
      throw new Error('expected_throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtensionClientError);
      if (err instanceof ExtensionClientError) {
        expect(err.errorCode).toBe('maxance_quote_unexpected_pricing_page');
      }
    }
  });

  it('rejects pending commands when the extension disconnects', async () => {
    harness = await newHarness();
    // Send a command; don't reply; close.
    const p = harness.client.ensureLoggedIn();
    await new Promise((r) => setTimeout(r, 50));
    harness.fakeExt.close();
    await expect(p).rejects.toThrow(/extension_disconnected|extension_/);
  });

  it('throws no_active_connection when no extension is connected', async () => {
    const port = await freePort();
    // reconnectGraceMs 0: production waits up to 60s for the MV3 service
    // worker to reconnect (2026-07-07 fix) — the test wants the immediate path.
    const client = new ExtensionClient({ port, timeoutMs: 1_000, reconnectGraceMs: 0 });
    await client.start();
    await expect(client.ensureLoggedIn()).rejects.toThrow(/no_active_connection/);
    await client.stop();
  });
});

describe('ExtensionClient — single-extension policy', () => {
  it('rejects a second concurrent connection with already_connected', async () => {
    harness = await newHarness();
    const second = new WsClient(`ws://127.0.0.1:${harness.port}`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no_close')), 2_000);
      second.once('close', (code) => {
        clearTimeout(t);
        resolve(code);
      });
      second.once('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
    // Policy-violation close codes from ws.close(1008, ...).
    expect(closeCode).toBe(1008);
  });
});

describe('ExtensionClient — UUID correlation', () => {
  it(
    'does not resolve a pending command for an unrelated response id',
    // health() uses a 5s internal ping timeout; budget more so we can
    // observe the rejection rather than vitest's default 5s ceiling.
    { timeout: 10_000 },
    async () => {
      harness = await newHarness();
      harness.fakeExt.on('message', () => {
        // Reply with a response carrying a DIFFERENT id (simulates a buggy ext).
        harness!.fakeExt.send(
          JSON.stringify({
            id: randomUUID(),
            kind: 'pong',
          }),
        );
      });
      // health() will time out because the response id doesn't match.
      await expect(harness.client.health()).rejects.toThrow(/timeout/);
    },
  );
});
