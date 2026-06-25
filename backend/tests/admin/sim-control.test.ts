/**
 * Tests for the admin Simulation control router (src/admin/sim-control.ts).
 *
 * Two layers:
 *   1. Router unit tests — inject a fake `ingestLead` via `deps` so they NEVER
 *      touch a DB. They assert the wire mapping (source='meta' + the
 *      f16_simulation flag) and boundary validation (bad phone -> 400).
 *   2. A DB-gated reset round-trip — guarded by TEST_DATABASE_URL, run ONLY
 *      against f16_test (5435). It uses the REAL ingestLead/purgeContact:
 *      inject -> inject same phone (matched_existing) -> reset -> status shows
 *      contact.exists=false. Mirrors the gating in tests/leads/purge.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createDb, type Database } from '../../src/db/index.js';
import { buildAdminSimRouter } from '../../src/admin/sim-control.js';

describe('admin sim-control (unit)', () => {
  it('inject-lead maps to ingestLead with source=meta + simulation flag', async () => {
    const ingestLead = vi.fn(async () => ({
      leadId: 'L1',
      customerId: 'C1',
      dedup: 'new_customer' as const,
      source: 'meta' as const,
      productLine: 'scooter' as const,
    }));
    const app = buildAdminSimRouter({ db: {} as never, deps: { ingestLead } });
    const res = await app.request('/v1/admin/sim/inject-lead', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Achraf',
        phone: '+33600000111',
        preferredChannel: 'whatsapp',
        productLine: 'scooter',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ leadId: 'L1', dedup: 'new_customer' });
    const payload = ingestLead.mock.calls[0]![1]!;
    expect(payload.source).toBe('meta');
    expect((payload.attribution as Record<string, unknown>).f16_simulation).toBe('true');
    expect(payload.preferredChannel).toBe('whatsapp');
  });

  it('inject-lead rejects an unnormalizable phone', async () => {
    const app = buildAdminSimRouter({ db: {} as never, deps: { ingestLead: vi.fn() } });
    const res = await app.request('/v1/admin/sim/inject-lead', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fullName: 'x',
        phone: '123',
        preferredChannel: 'whatsapp',
        productLine: 'scooter',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('reset rejects when neither phone nor email is given', async () => {
    const app = buildAdminSimRouter({ db: {} as never, deps: { ingestLead: vi.fn() } });
    const res = await app.request('/v1/admin/sim/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// --- DB-gated reset round-trip (f16_test only) -----------------------------
const liveUrl = process.env.TEST_DATABASE_URL;
const dbDescribe = describe.skipIf(!liveUrl);

dbDescribe('admin sim-control (db-gated reset round-trip)', () => {
  const phone = '+33600000222';
  let savedKey: string | undefined;
  let db: Database;

  beforeAll(() => {
    savedKey = process.env.PII_ENCRYPTION_KEY;
    if (!process.env.PII_ENCRYPTION_KEY) {
      process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    }
    if (liveUrl) db = createDb(liveUrl);
  });
  afterAll(async () => {
    if (db) await db.$client.end();
    if (savedKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
    else process.env.PII_ENCRYPTION_KEY = savedKey;
  });

  it('inject -> inject(same) -> reset -> status(exists:false)', async () => {
    const app = buildAdminSimRouter({ db });
    const inject = (body: Record<string, unknown>) =>
      app.request('/v1/admin/sim/inject-lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Clean slate, then two injections of the same phone.
    await app.request('/v1/admin/sim/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone }),
    });

    const first = await inject({
      fullName: 'Sim Reset One',
      phone,
      preferredChannel: 'whatsapp',
      productLine: 'scooter',
    });
    expect(first.status).toBe(200);
    expect((await first.json()).dedup).toBe('new_customer');

    const second = await inject({
      fullName: 'Sim Reset Two',
      phone,
      preferredChannel: 'whatsapp',
      productLine: 'scooter',
    });
    expect(second.status).toBe(200);
    expect((await second.json()).dedup).toBe('matched_existing');

    const reset = await app.request('/v1/admin/sim/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    expect(reset.status).toBe(200);
    const resetBody = await reset.json();
    expect(resetBody.purged.customer).toBe(1);
    expect(resetBody.purged.leads).toBeGreaterThanOrEqual(2);

    const status = await app.request('/v1/admin/sim/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.contact).toMatchObject({ exists: false, leadCount: 0 });
  });
});
