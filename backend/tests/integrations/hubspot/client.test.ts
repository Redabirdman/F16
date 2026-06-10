/**
 * HubSpot REST client tests (M5.T2).
 *
 * Strategy mirrors `tests/channels/whatsapp/adapter.test.ts`: spin up a small
 * `node:http.createServer` on a random port, capture every request, and let
 * each test set its own `respond` lambda when it needs a non-default reply.
 *
 * Pure unit tests — no DB, no Redis, no BullMQ. The token is a fake string;
 * we NEVER hit api.hubapi.com from tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HubSpotClient, HubSpotApiError } from '../../../src/integrations/hubspot/client.js';

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
 * Per-test override knob. Default responds 200 with a canned shape based on
 * the URL — upsert returns a fresh contact, deals get a sequential id, etc.
 */
let respond: (req: IncomingMessage, res: ServerResponse, body: unknown) => void;

function defaultRespond(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';
  res.setHeader('content-type', 'application/json');

  if (url.startsWith('/crm/v3/objects/contacts/batch/upsert')) {
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        status: 'COMPLETE',
        results: [
          {
            id: '111',
            properties: { email: 'x@y.z' },
            new: true,
          },
        ],
      }),
    );
    return;
  }
  if (url.startsWith('/crm/v3/objects/deals') && req.method === 'POST') {
    res.statusCode = 201;
    res.end(JSON.stringify({ id: '222', properties: {} }));
    return;
  }
  if (
    url.includes('/associations/default/deals/') ||
    url.includes('/associations/default/contacts/')
  ) {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (url.startsWith('/crm/v3/pipelines/deals')) {
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        results: [
          {
            id: 'default',
            label: 'Sales Pipeline',
            displayOrder: 0,
            stages: [
              { id: 'appointmentscheduled', label: 'New', displayOrder: 0 },
              { id: 'qualifiedtobuy', label: 'Qualified', displayOrder: 1 },
            ],
          },
          {
            id: 'second',
            label: 'Other',
            displayOrder: 1,
            stages: [{ id: 's-other', displayOrder: 0 }],
          },
        ],
      }),
    );
    return;
  }
  if (url.startsWith('/crm/v3/objects/contacts')) {
    res.statusCode = 200;
    res.end(JSON.stringify({ results: [], paging: null }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found' }));
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

function buildClient(): HubSpotClient {
  return new HubSpotClient({
    accessToken: 'pat-test-token-DO-NOT-USE',
    baseUrl: `http://127.0.0.1:${port}`,
    // Skip the real exponential backoff in tests — the retry logic is unit-
    // tested via call-counting, not wall-clock timing.
    sleepMs: async () => undefined,
  });
}

// ---------------------------------------------------------------------------
// 1. upsertContact request shape
// ---------------------------------------------------------------------------
describe('HubSpotClient.upsertContact', () => {
  it('POSTs /crm/v3/objects/contacts/batch/upsert with idProperty=email + Bearer header', async () => {
    await buildClient().upsertContact({
      email: 'jean@example.com',
      firstName: 'Jean',
      lastName: 'Dupont',
      phone: '+33612345678',
      properties: { f16_lead_id: 'abc' },
    });

    expect(seenRequests).toHaveLength(1);
    const req = seenRequests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/crm/v3/objects/contacts/batch/upsert');
    expect(req.headers['authorization']).toBe('Bearer pat-test-token-DO-NOT-USE');
    expect(req.headers['content-type']).toBe('application/json');
    const body = req.body as {
      inputs: Array<{
        idProperty: string;
        id: string;
        properties: Record<string, string>;
      }>;
    };
    expect(body.inputs).toHaveLength(1);
    expect(body.inputs[0]!.idProperty).toBe('email');
    expect(body.inputs[0]!.id).toBe('jean@example.com');
    expect(body.inputs[0]!.properties).toMatchObject({
      email: 'jean@example.com',
      firstname: 'Jean',
      lastname: 'Dupont',
      phone: '+33612345678',
      f16_lead_id: 'abc',
    });
  });

  // 2. parses {id, new} -> {hubspotContactId, isNew}
  it('parses results[0] into {hubspotContactId, isNew:true}', async () => {
    const out = await buildClient().upsertContact({ email: 'a@b.c' });
    expect(out.hubspotContactId).toBe('111');
    expect(out.isNew).toBe(true);
  });

  it('returns isNew:false when HubSpot says new:false', async () => {
    respond = (_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [{ id: '111', new: false }] }));
    };
    const out = await buildClient().upsertContact({ email: 'a@b.c' });
    expect(out.isNew).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. createDeal request shape
// ---------------------------------------------------------------------------
describe('HubSpotClient.createDeal', () => {
  it('POSTs /crm/v3/objects/deals with dealname/pipeline/dealstage/amount', async () => {
    const out = await buildClient().createDeal({
      dealName: 'Trottinette — Marie',
      amount: 199,
      pipeline: 'default',
      dealStage: 'appointmentscheduled',
      productLine: 'scooter',
      properties: { f16_lead_id: 'lead-1' },
    });
    expect(out.hubspotDealId).toBe('222');

    expect(seenRequests).toHaveLength(1);
    const req = seenRequests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/crm/v3/objects/deals');
    expect(req.headers['authorization']).toBe('Bearer pat-test-token-DO-NOT-USE');
    expect((req.body as { properties: Record<string, unknown> }).properties).toMatchObject({
      dealname: 'Trottinette — Marie',
      amount: 199,
      pipeline: 'default',
      dealstage: 'appointmentscheduled',
      product_line: 'scooter',
      f16_lead_id: 'lead-1',
    });
  });
});

// ---------------------------------------------------------------------------
// 4. associateContactDeal — PUT default association
// ---------------------------------------------------------------------------
describe('HubSpotClient.associateContactDeal', () => {
  it('PUTs /crm/v4/objects/contacts/<id>/associations/default/deals/<id>', async () => {
    await buildClient().associateContactDeal('111', '222');
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]!.method).toBe('PUT');
    expect(seenRequests[0]!.url).toBe(
      '/crm/v4/objects/contacts/111/associations/default/deals/222',
    );
    expect(seenRequests[0]!.headers['authorization']).toBe('Bearer pat-test-token-DO-NOT-USE');
  });
});

// ---------------------------------------------------------------------------
// 5. getDefaultDealPipelineAndStage — discovery + cache
// ---------------------------------------------------------------------------
describe('HubSpotClient.getDefaultDealPipelineAndStage', () => {
  it('GETs /crm/v3/pipelines/deals and returns the first pipeline + first stage', async () => {
    const client = buildClient();
    const a = await client.getDefaultDealPipelineAndStage();
    expect(a).toEqual({ pipelineId: 'default', newDealStageId: 'appointmentscheduled' });
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]!.method).toBe('GET');
    expect(seenRequests[0]!.url).toBe('/crm/v3/pipelines/deals');

    // Cached: second call must NOT hit the server.
    const b = await client.getDefaultDealPipelineAndStage();
    expect(b).toEqual(a);
    expect(seenRequests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6 + 7. Retry on 429 / 5xx
// ---------------------------------------------------------------------------
describe('HubSpotClient retry', () => {
  it('retries on 429 then succeeds — 2 server calls', async () => {
    let calls = 0;
    respond = (_req, res) => {
      calls++;
      if (calls === 1) {
        res.statusCode = 429;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'error', category: 'RATE_LIMITS' }));
        return;
      }
      defaultRespond(_req, res);
    };
    const out = await buildClient().upsertContact({ email: 'r@e.t' });
    expect(out.hubspotContactId).toBe('111');
    expect(seenRequests.length).toBe(2);
  });

  it('retries on 503 then succeeds — 2 server calls', async () => {
    let calls = 0;
    respond = (_req, res) => {
      calls++;
      if (calls === 1) {
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json');
        res.end('{"status":"error"}');
        return;
      }
      defaultRespond(_req, res);
    };
    const out = await buildClient().upsertContact({ email: 'r@e.t' });
    expect(out.hubspotContactId).toBe('111');
    expect(seenRequests.length).toBe(2);
  });

  // 8. Persistent 5xx — 3 attempts, then throw with PII-safe message
  it('gives up after 3 5xx attempts and throws HubSpotApiError with only status + body prefix', async () => {
    respond = (_req, res) => {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end('{"status":"error","message":"upstream lit on fire"}');
    };
    let caught: unknown;
    try {
      await buildClient().upsertContact({
        email: 'SUPER-SECRET@example.com',
        phone: '+33612345678',
        firstName: 'Jean',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HubSpotApiError);
    const e = caught as HubSpotApiError;
    expect(e.status).toBe(503);
    expect(e.message).toMatch(/503/);
    // PII discipline: no email/name/phone leak into the error.
    expect(e.message).not.toContain('SUPER-SECRET');
    expect(e.message).not.toContain('+33612345678');
    expect(e.message).not.toContain('Jean');
    expect(seenRequests.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 9. PII discipline on 400
// ---------------------------------------------------------------------------
describe('HubSpotClient PII discipline', () => {
  it('400 error contains only status + HubSpot body prefix, never request PII', async () => {
    respond = (_req, res) => {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          status: 'error',
          category: 'VALIDATION_ERROR',
          message: 'Property values were not valid',
          errors: [{ message: 'Property "f16_lead_id" does not exist', in: 'f16_lead_id' }],
        }),
      );
    };

    let caught: unknown;
    try {
      await buildClient().upsertContact({
        email: 'SECRET-MARIE@example.fr',
        phone: '+33611111111',
        firstName: 'MariePIIName',
        properties: { f16_lead_id: 'l1' },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HubSpotApiError);
    const e = caught as HubSpotApiError;
    expect(e.status).toBe(400);
    expect(e.missingProperty).toBe('f16_lead_id');
    // Error message must NOT echo the request PII.
    expect(e.message).not.toContain('SECRET-MARIE');
    expect(e.message).not.toContain('+33611111111');
    expect(e.message).not.toContain('MariePIIName');
    // ...but it MAY safely contain HubSpot's response (which only names props).
    expect(e.message).toMatch(/f16_lead_id|does not exist/);
  });
});

// ---------------------------------------------------------------------------
// 10. healthCheck
// ---------------------------------------------------------------------------
describe('HubSpotClient.healthCheck', () => {
  it('returns {healthy:true} on 200', async () => {
    const result = await buildClient().healthCheck();
    expect(result.healthy).toBe(true);
  });

  it('returns {healthy:false, detail} when the server is unreachable', async () => {
    // Point at a port nothing is listening on — node returns ECONNREFUSED.
    const client = new HubSpotClient({
      accessToken: 't',
      baseUrl: 'http://127.0.0.1:1', // port 1 is reserved + unbound
      sleepMs: async () => undefined,
    });
    const result = await client.healthCheck();
    expect(result.healthy).toBe(false);
    expect(typeof result.detail).toBe('string');
    expect(result.detail!.length).toBeGreaterThan(0);
  });
});
