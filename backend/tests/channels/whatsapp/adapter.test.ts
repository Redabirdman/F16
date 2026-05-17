/**
 * WhatsApp / WAHA adapter tests (M4.T2).
 *
 * Strategy: spin up a tiny Node `http.createServer` on a random port and
 * record every request the adapter makes. Zero external test dependencies
 * (no msw / nock). All routes return a canned WAHA-shaped response unless
 * a per-test override flips status to 500 (for the PII-protection test) or
 * customizes the body (for healthCheck).
 *
 * No live WAHA here — that comes in M5+ when there's real lead flow.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WahaClient, phoneToChatId } from '../../../src/channels/whatsapp/waha-client.js';
import { WhatsAppAdapter } from '../../../src/channels/whatsapp/adapter.js';
import type { ContentBlock } from '../../../src/channels/types.js';

interface SeenRequest {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

let server: Server;
let port: number;
const seenRequests: SeenRequest[] = [];

/**
 * Per-test override knob. The default response is a canned WAHA-shaped send
 * reply with a sequential id; tests that need 500s or session-status payloads
 * set this in beforeEach.
 */
let respond: (req: IncomingMessage, res: ServerResponse, body: unknown) => void;

function defaultRespond(_req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      id: { _serialized: `wamid.fake-${seenRequests.length}` },
      ack: 1,
      timestamp: Math.floor(Date.now() / 1000),
    }),
  );
}

beforeAll(async () => {
  respond = defaultRespond;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      let body: unknown = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      seenRequests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body,
        headers: req.headers,
      });
      respond(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seenRequests.length = 0;
  respond = defaultRespond;
});

function buildClient(): WahaClient {
  return new WahaClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    session: 'default',
  });
}

function buildAdapter(): WhatsAppAdapter {
  return new WhatsAppAdapter({ client: buildClient() });
}

describe('phoneToChatId', () => {
  it('strips formatting and produces "<digits>@c.us"', () => {
    expect(phoneToChatId('+33 6 12 34 56 78')).toBe('33612345678@c.us');
    expect(phoneToChatId('+1 (555) 010-0000')).toBe('15550100000@c.us');
  });

  it('throws on input with no digits', () => {
    expect(() => phoneToChatId('not-a-phone')).toThrow(/Invalid phone/);
  });
});

describe('WhatsAppAdapter.send — text', () => {
  it('hits /api/sendText with chatId+text, sets x-api-key, returns DeliveryReceipt', async () => {
    const receipt = await buildAdapter().send({
      to: { channel: 'whatsapp', address: '+33612345678' },
      body: [{ type: 'text', text: 'Bonjour Marie' }],
    });

    expect(seenRequests).toHaveLength(1);
    const req = seenRequests[0]!;
    expect(req.url).toBe('/api/sendText');
    expect(req.method).toBe('POST');
    expect(req.headers['x-api-key']).toBe('test-key');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.body).toMatchObject({
      session: 'default',
      chatId: '33612345678@c.us',
      text: 'Bonjour Marie',
    });

    expect(receipt.channel).toBe('whatsapp');
    expect(receipt.externalId).toBe('wamid.fake-1');
    expect(receipt.acceptedAt).toBeInstanceOf(Date);
    expect(receipt.raw).toBeDefined();
  });

  it('includes replyTo when MessageRef is supplied', async () => {
    await buildAdapter().send({
      to: { channel: 'whatsapp', address: '+33612345678' },
      body: [{ type: 'text', text: 'Re: votre devis' }],
      replyTo: { channel: 'whatsapp', externalId: 'wamid.prev-123' },
    });

    expect(seenRequests[0]?.body).toMatchObject({
      chatId: '33612345678@c.us',
      text: 'Re: votre devis',
      replyTo: 'wamid.prev-123',
    });
  });
});

describe('WhatsAppAdapter.send — media', () => {
  it('image block → /api/sendImage with file.url and caption', async () => {
    await buildAdapter().send({
      to: { channel: 'whatsapp', address: '+33612345678' },
      body: [
        {
          type: 'image',
          url: 'https://cdn.example.fr/photo.jpg',
          caption: 'Votre toit',
        },
      ],
    });

    expect(seenRequests[0]?.url).toBe('/api/sendImage');
    expect(seenRequests[0]?.body).toMatchObject({
      chatId: '33612345678@c.us',
      file: { url: 'https://cdn.example.fr/photo.jpg' },
      caption: 'Votre toit',
    });
  });

  it('document block → /api/sendFile with file.url and filename', async () => {
    await buildAdapter().send({
      to: { channel: 'whatsapp', address: '+33612345678' },
      body: [
        {
          type: 'document',
          url: 'https://cdn.example.fr/devis.pdf',
          filename: 'devis.pdf',
          mimeType: 'application/pdf',
        },
      ],
    });

    expect(seenRequests[0]?.url).toBe('/api/sendFile');
    expect(seenRequests[0]?.body).toMatchObject({
      chatId: '33612345678@c.us',
      file: { url: 'https://cdn.example.fr/devis.pdf', filename: 'devis.pdf' },
    });
  });
});

describe('WhatsAppAdapter.send — multi-block', () => {
  it('sends N HTTP requests in order; receipt uses the last externalId', async () => {
    const body: ContentBlock[] = [
      { type: 'text', text: 'Salut' },
      { type: 'image', url: 'https://cdn.example.fr/p.jpg', caption: 'Voici' },
      {
        type: 'document',
        url: 'https://cdn.example.fr/d.pdf',
        filename: 'd.pdf',
        mimeType: 'application/pdf',
      },
    ];

    const receipt = await buildAdapter().send({
      to: { channel: 'whatsapp', address: '+33612345678' },
      body,
    });

    expect(seenRequests.map((r) => r.url)).toEqual([
      '/api/sendText',
      '/api/sendImage',
      '/api/sendFile',
    ]);
    expect(receipt.externalId).toBe('wamid.fake-3');
  });

  it('empty body throws', async () => {
    await expect(
      buildAdapter().send({
        to: { channel: 'whatsapp', address: '+33612345678' },
        body: [],
      }),
    ).rejects.toThrow(/at least one block/);
  });
});

describe('WhatsAppAdapter.send — interactive', () => {
  it('routes to /api/sendButtons by default with spec spread into payload', async () => {
    await buildAdapter().send({
      to: { channel: 'whatsapp', address: '+33612345678' },
      body: [
        {
          type: 'interactive',
          spec: {
            header: 'Votre rendez-vous',
            buttons: [
              { id: 'confirm', text: 'Confirmer' },
              { id: 'reschedule', text: 'Replanifier' },
            ],
          },
        },
      ],
    });

    expect(seenRequests[0]?.url).toBe('/api/sendButtons');
    expect(seenRequests[0]?.body).toMatchObject({
      session: 'default',
      chatId: '33612345678@c.us',
      header: 'Votre rendez-vous',
      buttons: [
        { id: 'confirm', text: 'Confirmer' },
        { id: 'reschedule', text: 'Replanifier' },
      ],
    });
  });
});

describe('WhatsAppAdapter — guardrails', () => {
  it('throws when ContactRef.channel does not match the adapter', async () => {
    await expect(
      buildAdapter().send({
        to: { channel: 'email', address: 'marie@example.fr' },
        body: [{ type: 'text', text: 'oops' }],
      }),
    ).rejects.toThrow(/cannot send to email/);

    // Did not hit the network either.
    expect(seenRequests).toHaveLength(0);
  });

  it('on WAHA 500: throws without echoing the request body (PII protection)', async () => {
    respond = (_req, res) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain');
      // Response body intentionally innocuous — it would still get truncated.
      res.end('internal server error');
    };

    let caught: unknown;
    try {
      await buildAdapter().send({
        to: { channel: 'whatsapp', address: '+33612345678' },
        body: [{ type: 'text', text: 'SUPER-SECRET phone +33612345678' }],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    // Status surfaced, response prefix surfaced, request body NOT echoed.
    expect(msg).toMatch(/500/);
    expect(msg).not.toContain('SUPER-SECRET');
    expect(msg).not.toContain('+33612345678');
    expect(msg).not.toContain('33612345678@c.us');
  });
});

describe('WhatsAppAdapter.healthCheck', () => {
  it('returns {healthy:true} when /api/sessions/default reports WORKING', async () => {
    respond = (req, res) => {
      if (req.url?.startsWith('/api/sessions/')) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'WORKING' }));
        return;
      }
      defaultRespond(req, res);
    };

    const result = await buildAdapter().healthCheck();
    expect(result.healthy).toBe(true);
    expect(result.detail).toBe('WORKING');
  });

  it('returns {healthy:false} when WAHA reports STOPPED', async () => {
    respond = (req, res) => {
      if (req.url?.startsWith('/api/sessions/')) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'STOPPED' }));
        return;
      }
      defaultRespond(req, res);
    };

    const result = await buildAdapter().healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.detail).toBe('STOPPED');
  });
});

describe('WahaClient.setTyping', () => {
  it('on=true → POST /api/startTyping; failures are logged but not thrown', async () => {
    const client = buildClient();

    await client.setTyping('33612345678@c.us', true);
    expect(seenRequests[0]?.url).toBe('/api/startTyping');
    expect(seenRequests[0]?.body).toMatchObject({
      session: 'default',
      chatId: '33612345678@c.us',
    });

    // Now flip the server to 500 and confirm we swallow the error.
    respond = (_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    };
    // Must resolve, not reject.
    await expect(client.setTyping('33612345678@c.us', false)).resolves.toBeUndefined();
    expect(seenRequests.at(-1)?.url).toBe('/api/stopTyping');
  });
});
