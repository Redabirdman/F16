/**
 * reconcileLead idempotency test (DB-gated, throwaway f16_test DB).
 *
 * Verifies create-then-update semantics:
 *   - First reconcileLead call: creates Contact + Deal (hubspot_deal_id written back).
 *   - Second reconcileLead call: updates Deal (no second createDeal).
 *
 * Uses a fake HubSpotClient — the point is to test DB idempotency
 * (hubspot_deal_id write-back gates create vs update), not live HTTP.
 *
 * Gate: TEST_DATABASE_URL must be set (postgres://f16:f16@127.0.0.1:5435/f16_test).
 * Never use the prod f16 database — this file's TRUNCATEs against a raw
 * DATABASE_URL are what seeded the 'd1' fixture into prod (2026-07-04 audit).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createDb } from '../../../src/db/index.js';
import { leads } from '../../../src/db/schema/index.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import { reconcileLead } from '../../../src/integrations/hubspot/dual-write.js';
import { __resetSchemaCacheForTests } from '../../../src/integrations/hubspot/schema.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const RUN = Boolean(pgUrl);

let savedPiiKey: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
});

afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
});

function fakeClient() {
  return {
    ensureProperty: vi.fn().mockResolvedValue(undefined),
    listPipelines: vi.fn().mockResolvedValue([]),
    createPipeline: vi.fn().mockResolvedValue({
      id: 'pipe',
      stages: [
        { id: 's-nouveau', label: 'Nouveau' },
        { id: 's-qualifie', label: 'Qualifié' },
        { id: 's-devis_en_cours', label: 'Devis en cours' },
        { id: 's-devis_envoye', label: 'Devis envoyé / Négociation' },
        { id: 's-attente_paiement', label: 'En attente paiement' },
        { id: 's-gagne', label: 'Gagné' },
        { id: 's-perdu', label: 'Perdu' },
      ],
    }),
    upsertContact: vi.fn().mockResolvedValue({ hubspotContactId: 'c1', isNew: true }),
    createDeal: vi.fn().mockResolvedValue({ hubspotDealId: 'd1' }),
    associateContactDeal: vi.fn().mockResolvedValue(undefined),
    updateDeal: vi.fn().mockResolvedValue(undefined),
    updateContact: vi.fn().mockResolvedValue(undefined),
  };
}

describe.runIf(RUN)('reconcileLead (DB-gated)', () => {
  beforeAll(() => __resetSchemaCacheForTests());

  it('creates on first run, updates (no second create) on second run', async () => {
    const db = createDb(pgUrl!);

    // Truncate to avoid cross-test pollution.
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);

    // Seed: a customer with email + a lead in status 'new'.
    const customer = await insertCustomer(db, {
      fullName: 'Reconcile Tester',
      email: `reconcile-${Date.now()}@example.fr`,
      phone: '+33612340000',
    });

    const [insertedLead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'new',
      })
      .returning();
    const leadId = insertedLead!.id;

    const client = fakeClient();

    // First run: should CREATE deal.
    const first = await reconcileLead({ db, client } as never, leadId);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected ok=true on first call');
    expect((first.result as { created?: boolean }).created).toBe(true);
    expect(client.createDeal).toHaveBeenCalledOnce();
    expect(client.upsertContact).toHaveBeenCalledOnce();
    expect(client.associateContactDeal).toHaveBeenCalledOnce();
    expect(client.updateDeal).not.toHaveBeenCalled();

    // Verify hubspot_deal_id was written back to the DB.
    const [leadAfterCreate] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    expect(leadAfterCreate!.hubspotDealId).toBe('d1');

    // Second run: should UPDATE deal (no second create).
    const second = await reconcileLead({ db, client } as never, leadId);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected ok=true on second call');
    expect((second.result as { updated?: boolean }).updated).toBe(true);
    expect(client.createDeal).toHaveBeenCalledOnce(); // still only once
    expect(client.updateDeal).toHaveBeenCalledOnce();
  });
});
