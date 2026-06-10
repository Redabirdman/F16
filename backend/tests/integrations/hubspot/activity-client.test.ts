/**
 * activity-client.test.ts — HubSpot engagement method tests (Phase 3).
 *
 * Uses the same stub-HTTP-server pattern as client.test.ts. Verifies:
 *   - createNote → POST /crm/v3/objects/notes with correct properties + associations
 *   - createCall → POST /crm/v3/objects/calls with correct properties + associations
 *   - createCommunication → POST /crm/v3/objects/communications with correct properties
 *
 * Association typeIds verified:
 *   Notes:  contact 202, deal 214
 *   Calls:  contact 194, deal 206
 *   Comms:  contact  82, deal  86
 *
 * NEVER hits api.hubapi.com.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HubSpotClient } from '../../../src/integrations/hubspot/client.js';

interface SeenRequest {
  method: string;
  url: string;
  body: unknown;
}

let server: Server;
let port: number;
const seenRequests: SeenRequest[] = [];
let respond: (req: IncomingMessage, res: ServerResponse) => void;

function defaultRespond(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';
  res.setHeader('content-type', 'application/json');
  if (url.startsWith('/crm/v3/objects/notes') && req.method === 'POST') {
    res.statusCode = 201;
    res.end(JSON.stringify({ id: 'note-hs-1', properties: {} }));
    return;
  }
  if (url.startsWith('/crm/v3/objects/calls') && req.method === 'POST') {
    res.statusCode = 201;
    res.end(JSON.stringify({ id: 'call-hs-1', properties: {} }));
    return;
  }
  if (url.startsWith('/crm/v3/objects/communications') && req.method === 'POST') {
    res.statusCode = 201;
    res.end(JSON.stringify({ id: 'comm-hs-1', properties: {} }));
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
      seenRequests.push({ method: req.method ?? '', url: req.url ?? '', body });
      respond(req, res);
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
    sleepMs: async () => undefined,
  });
}

// ---------------------------------------------------------------------------
// createNote
// ---------------------------------------------------------------------------

describe('HubSpotClient.createNote', () => {
  it('POSTs /crm/v3/objects/notes with correct properties and associations', async () => {
    const ts = new Date('2024-06-10T10:00:00.000Z');
    const out = await buildClient().createNote({
      body: 'Test note body',
      contactId: 'contact-123',
      dealId: 'deal-456',
      timestamp: ts,
    });

    expect(out.noteId).toBe('note-hs-1');
    expect(seenRequests).toHaveLength(1);
    const req = seenRequests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/crm/v3/objects/notes');

    const b = req.body as {
      properties: { hs_note_body: string; hs_timestamp: string };
      associations: Array<{
        to: { id: string };
        types: Array<{ associationCategory: string; associationTypeId: number }>;
      }>;
    };

    // Properties
    expect(b.properties.hs_note_body).toBe('Test note body');
    expect(b.properties.hs_timestamp).toBe('2024-06-10T10:00:00.000Z');

    // Associations — contact typeId 202, deal typeId 214 (HUBSPOT_DEFINED)
    expect(b.associations).toHaveLength(2);
    const contactAssoc = b.associations.find((a) => a.to.id === 'contact-123');
    const dealAssoc = b.associations.find((a) => a.to.id === 'deal-456');

    expect(contactAssoc).toBeDefined();
    expect(contactAssoc!.types[0]!.associationCategory).toBe('HUBSPOT_DEFINED');
    expect(contactAssoc!.types[0]!.associationTypeId).toBe(202);

    expect(dealAssoc).toBeDefined();
    expect(dealAssoc!.types[0]!.associationCategory).toBe('HUBSPOT_DEFINED');
    expect(dealAssoc!.types[0]!.associationTypeId).toBe(214);
  });
});

// ---------------------------------------------------------------------------
// createCall
// ---------------------------------------------------------------------------

describe('HubSpotClient.createCall', () => {
  it('POSTs /crm/v3/objects/calls with OUTBOUND direction + duration + associations', async () => {
    const ts = new Date('2024-06-10T10:00:00.000Z');
    const out = await buildClient().createCall({
      title: 'Appel sortant Assuryal',
      body: 'Client discussed scooter plan',
      durationMs: 90000,
      contactId: 'contact-123',
      dealId: 'deal-456',
      timestamp: ts,
    });

    expect(out.callId).toBe('call-hs-1');
    expect(seenRequests).toHaveLength(1);
    const req = seenRequests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/crm/v3/objects/calls');

    const b = req.body as {
      properties: Record<string, unknown>;
      associations: Array<{
        to: { id: string };
        types: Array<{ associationCategory: string; associationTypeId: number }>;
      }>;
    };

    expect(b.properties.hs_call_title).toBe('Appel sortant Assuryal');
    expect(b.properties.hs_call_body).toBe('Client discussed scooter plan');
    expect(b.properties.hs_call_direction).toBe('OUTBOUND');
    expect(b.properties.hs_call_duration).toBe(90000);
    expect(b.properties.hs_timestamp).toBe('2024-06-10T10:00:00.000Z');

    // Associations — contact typeId 194, deal typeId 206 (HUBSPOT_DEFINED)
    expect(b.associations).toHaveLength(2);
    const contactAssoc = b.associations.find((a) => a.to.id === 'contact-123');
    const dealAssoc = b.associations.find((a) => a.to.id === 'deal-456');

    expect(contactAssoc!.types[0]!.associationTypeId).toBe(194);
    expect(dealAssoc!.types[0]!.associationTypeId).toBe(206);
    expect(contactAssoc!.types[0]!.associationCategory).toBe('HUBSPOT_DEFINED');
  });

  it('omits hs_call_duration when durationMs is not provided', async () => {
    await buildClient().createCall({
      title: 'Test',
      body: 'body',
      contactId: 'c',
      dealId: 'd',
      timestamp: new Date(),
    });
    const b = seenRequests[0]!.body as { properties: Record<string, unknown> };
    expect(b.properties.hs_call_duration).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createCommunication
// ---------------------------------------------------------------------------

describe('HubSpotClient.createCommunication', () => {
  it('POSTs /crm/v3/objects/communications with WHATSAPP channel + associations', async () => {
    const ts = new Date('2024-06-10T10:00:00.000Z');
    const out = await buildClient().createCommunication({
      channel: 'WHATSAPP',
      body: '[Client] Bonjour',
      contactId: 'contact-123',
      dealId: 'deal-456',
      timestamp: ts,
    });

    expect(out.communicationId).toBe('comm-hs-1');
    expect(seenRequests).toHaveLength(1);
    const req = seenRequests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/crm/v3/objects/communications');

    const b = req.body as {
      properties: Record<string, unknown>;
      associations: Array<{
        to: { id: string };
        types: Array<{ associationCategory: string; associationTypeId: number }>;
      }>;
    };

    expect(b.properties.hs_communication_channel_type).toBe('WHATSAPP');
    expect(b.properties.hs_communication_body).toBe('[Client] Bonjour');
    expect(b.properties.hs_timestamp).toBe('2024-06-10T10:00:00.000Z');

    // Associations — contact typeId 82, deal typeId 86 (HUBSPOT_DEFINED)
    const contactAssoc = b.associations.find((a) => a.to.id === 'contact-123');
    const dealAssoc = b.associations.find((a) => a.to.id === 'deal-456');

    expect(contactAssoc!.types[0]!.associationTypeId).toBe(82);
    expect(dealAssoc!.types[0]!.associationTypeId).toBe(86);
    expect(contactAssoc!.types[0]!.associationCategory).toBe('HUBSPOT_DEFINED');
  });

  it('works with SMS channel type', async () => {
    await buildClient().createCommunication({
      channel: 'SMS',
      body: 'Your quote is ready',
      contactId: 'c',
      dealId: 'd',
      timestamp: new Date(),
    });
    const b = seenRequests[0]!.body as { properties: Record<string, unknown> };
    expect(b.properties.hs_communication_channel_type).toBe('SMS');
  });
});
