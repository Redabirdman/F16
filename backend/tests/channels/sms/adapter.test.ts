/**
 * SMS / android-sms-gateway adapter tests (M4.T5).
 *
 * Strategy mirrors the WAHA test suite: spin up a tiny Node
 * `http.createServer` on a random port and record every request the
 * adapter/client makes. No external test deps; no live phone needed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SmsGatewayClient, normalizePhone } from '../../../src/channels/sms/gateway-client.js';
import { SmsAdapter } from '../../../src/channels/sms/adapter.js';
import { logger } from '../../../src/logger.js';
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

let respond: (req: IncomingMessage, res: ServerResponse, body: unknown) => void;

let sendIdCounter = 0;
function defaultRespond(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'POST' && req.url === '/3rdparty/v1/messages') {
    sendIdCounter += 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: `sms-fake-${sendIdCounter}`,
        state: 'Pending',
        recipients: [{ phoneNumber: '+33612345678', state: 'Pending' }],
      }),
    );
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/3rdparty/v1/messages/')) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'sms-fake-1',
        state: 'Sent',
        recipients: [{ phoneNumber: '+33612345678', state: 'Sent' }],
      }),
    );
    return;
  }
  if (req.method === 'GET' && req.url === '/3rdparty/v1/messages') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  res.statusCode = 404;
  res.end();
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
  sendIdCounter = 0;
  respond = defaultRespond;
});

function buildClient(): SmsGatewayClient {
  return new SmsGatewayClient({
    baseUrl: `http://127.0.0.1:${port}`,
    username: 'ridaa',
    password: 'hunter2',
    simNumber: 0,
  });
}

function buildAdapter(): SmsAdapter {
  return new SmsAdapter({ client: buildClient() });
}

const EXPECTED_AUTH = `Basic ${Buffer.from('ridaa:hunter2', 'utf8').toString('base64')}`;

describe('normalizePhone', () => {
  it('strips formatting and produces "+digits"', () => {
    expect(normalizePhone('+33 6 12 34 56 78')).toBe('+33612345678');
    expect(normalizePhone('+1 (555) 010-0000')).toBe('+15550100000');
    expect(normalizePhone('33612345678')).toBe('+33612345678');
  });

  it('throws on input with no digits', () => {
    expect(() => normalizePhone('not-a-phone')).toThrow(/Invalid phone/);
  });
});

describe('SmsAdapter.capabilities', () => {
  it('returns flags for a text-only, non-interactive channel', () => {
    expect(buildAdapter().capabilities()).toEqual({
      interactive: false,
      voice: false,
      attachments: false,
      markdown: false,
    });
  });
});

describe('SmsAdapter.send — single text block', () => {
  it('POSTs to /3rdparty/v1/messages with Basic Auth + JSON body, returns DeliveryReceipt', async () => {
    const receipt = await buildAdapter().send({
      to: { channel: 'sms', address: '+33612345678' },
      body: [{ type: 'text', text: 'Bonjour Marie' }],
    });

    expect(seenRequests).toHaveLength(1);
    const req = seenRequests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/3rdparty/v1/messages');
    expect(req.headers.authorization).toBe(EXPECTED_AUTH);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.body).toMatchObject({
      message: 'Bonjour Marie',
      phoneNumbers: ['+33612345678'],
      simNumber: 0,
    });

    expect(receipt.channel).toBe('sms');
    expect(receipt.externalId).toBe('sms-fake-1');
    expect(receipt.acceptedAt).toBeInstanceOf(Date);
    expect(receipt.raw).toMatchObject({ state: 'Pending' });
  });
});

describe('SmsAdapter.send — composition', () => {
  it('concatenates multiple text blocks with newlines into one message', async () => {
    await buildAdapter().send({
      to: { channel: 'sms', address: '+33612345678' },
      body: [
        { type: 'text', text: 'Bonjour Marie' },
        { type: 'text', text: 'Votre devis est prêt' },
      ],
    });

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.body).toMatchObject({
      message: 'Bonjour Marie\nVotre devis est prêt',
    });
  });

  it('strips markdown syntax from markdown blocks', async () => {
    await buildAdapter().send({
      to: { channel: 'sms', address: '+33612345678' },
      body: [{ type: 'markdown', text: '**Bonjour** Marie, voici le [devis](https://x.fr).' }],
    });

    const msg = (seenRequests[0]?.body as { message: string }).message;
    expect(msg).not.toContain('**');
    expect(msg).toContain('Bonjour Marie');
    expect(msg).toContain('devis (https://x.fr)');
  });

  it('degrades image blocks to [image: <caption-or-url>]', async () => {
    await buildAdapter().send({
      to: { channel: 'sms', address: '+33612345678' },
      body: [
        {
          type: 'image',
          url: 'https://cdn.example.fr/photo.jpg',
          caption: 'Votre toit',
        },
      ],
    });

    expect((seenRequests[0]?.body as { message: string }).message).toBe('[image: Votre toit]');
  });

  it('degrades image blocks without caption to [image: <url>]', async () => {
    await buildAdapter().send({
      to: { channel: 'sms', address: '+33612345678' },
      body: [{ type: 'image', url: 'https://cdn.example.fr/photo.jpg' }],
    });
    expect((seenRequests[0]?.body as { message: string }).message).toBe(
      '[image: https://cdn.example.fr/photo.jpg]',
    );
  });

  it('degrades document blocks to [file: <filename>]', async () => {
    await buildAdapter().send({
      to: { channel: 'sms', address: '+33612345678' },
      body: [
        {
          type: 'document',
          url: 'https://cdn.example.fr/devis.pdf',
          filename: 'devis.pdf',
          mimeType: 'application/pdf',
        },
      ],
    });
    expect((seenRequests[0]?.body as { message: string }).message).toBe('[file: devis.pdf]');
  });

  it('mixed (text + image + text) → one POST with concatenated body', async () => {
    const body: ContentBlock[] = [
      { type: 'text', text: 'Bonjour' },
      { type: 'image', url: 'https://cdn.example.fr/p.jpg', caption: 'Voici' },
      { type: 'text', text: 'Merci' },
    ];
    await buildAdapter().send({
      to: { channel: 'sms', address: '+33612345678' },
      body,
    });

    expect(seenRequests).toHaveLength(1);
    expect((seenRequests[0]?.body as { message: string }).message).toBe(
      'Bonjour\n[image: Voici]\nMerci',
    );
  });
});

describe('SmsAdapter.send — guardrails', () => {
  it('throws and does not hit the network when body produces empty text', async () => {
    await expect(
      buildAdapter().send({
        to: { channel: 'sms', address: '+33612345678' },
        body: [{ type: 'interactive', spec: { buttons: [] } }],
      }),
    ).rejects.toThrow(/SMS body is empty/);
    expect(seenRequests).toHaveLength(0);
  });

  it('throws when ContactRef.channel is not "sms"', async () => {
    await expect(
      buildAdapter().send({
        to: { channel: 'whatsapp', address: '+33612345678' },
        body: [{ type: 'text', text: 'oops' }],
      }),
    ).rejects.toThrow(/cannot send to whatsapp/);
    expect(seenRequests).toHaveLength(0);
  });

  it('on gateway 401: throws WITHOUT echoing the phone or message body', async () => {
    respond = (_req, res) => {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'unauthorized' }));
    };

    let caught: unknown;
    try {
      await buildAdapter().send({
        to: { channel: 'sms', address: '+33612345678' },
        body: [{ type: 'text', text: 'SUPER-SECRET phone +33612345678' }],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/401/);
    expect(msg).not.toContain('SUPER-SECRET');
    expect(msg).not.toContain('+33612345678');
  });

  it('on gateway 500: same PII protection', async () => {
    respond = (_req, res) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain');
      res.end('internal server error');
    };

    let caught: unknown;
    try {
      await buildAdapter().send({
        to: { channel: 'sms', address: '+33612345678' },
        body: [{ type: 'text', text: 'leak +33612345678 here' }],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/500/);
    expect(msg).not.toContain('+33612345678');
    expect(msg).not.toContain('leak');
  });
});

describe('SmsAdapter.send — multi-segment warning', () => {
  it('logs a warn when composed body exceeds 160 chars but still sends', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const longText = 'a'.repeat(200);
      const receipt = await buildAdapter().send({
        to: { channel: 'sms', address: '+33612345678' },
        body: [{ type: 'text', text: longText }],
      });

      expect(seenRequests).toHaveLength(1);
      expect(receipt.externalId).toBe('sms-fake-1');
      expect(warnSpy).toHaveBeenCalled();
      const calls = warnSpy.mock.calls;
      const matched = calls.some((call) => {
        const arg = call[0];
        if (typeof arg === 'object' && arg !== null && 'length' in arg) {
          return (arg as { length: number }).length === 200;
        }
        return false;
      });
      expect(matched).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('SmsGatewayClient — phone normalization on the wire', () => {
  it('formatted and unformatted E.164 produce identical POST bodies', async () => {
    const client = buildClient();
    await client.sendMessage({ phoneNumber: '+33 6 12 34 56 78', message: 'hi' });
    await client.sendMessage({ phoneNumber: '+33612345678', message: 'hi' });

    expect(seenRequests).toHaveLength(2);
    expect(seenRequests[0]?.body).toEqual(seenRequests[1]?.body);
    expect(seenRequests[0]?.body).toMatchObject({
      phoneNumbers: ['+33612345678'],
      message: 'hi',
      simNumber: 0,
    });
  });
});

describe('SmsGatewayClient.getMessageStatus', () => {
  it('GETs /3rdparty/v1/messages/<id> and parses the response', async () => {
    const status = await buildClient().getMessageStatus('sms-fake-1');

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.method).toBe('GET');
    expect(seenRequests[0]?.url).toBe('/3rdparty/v1/messages/sms-fake-1');
    expect(seenRequests[0]?.headers.authorization).toBe(EXPECTED_AUTH);

    expect(status).toMatchObject({
      id: 'sms-fake-1',
      state: 'Sent',
      recipients: [{ phoneNumber: '+33612345678', state: 'Sent' }],
    });
  });
});

describe('SmsAdapter.healthCheck', () => {
  it('returns {healthy:true} on a 200 from the gateway', async () => {
    const result = await buildAdapter().healthCheck();
    expect(result.healthy).toBe(true);
  });

  it('returns {healthy:false} on connection refused', async () => {
    // Use a port that nothing is listening on. Port 1 on loopback reliably
    // refuses on Linux/macOS/Windows.
    const client = new SmsGatewayClient({
      baseUrl: 'http://127.0.0.1:1',
      username: 'x',
      password: 'y',
    });
    const adapter = new SmsAdapter({ client });
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(typeof result.detail).toBe('string');
  });
});
