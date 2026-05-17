/**
 * E2E smoke for the dev seed CLI (M2.T8).
 *
 * Runs the actual `tsx scripts/seed-dev.ts --yes` via execSync so we exercise
 * the script the same way a human or CI would. Gated on TEST_DATABASE_URL —
 * skipped otherwise so `pnpm test` stays hermetic without docker.
 *
 * What we assert beyond "exit 0":
 *   - row counts per table match the script's contract
 *   - PII decrypted via the repo equals the seed plaintext (proves the
 *     PII_ENCRYPTION_KEY round-tripped through the CLI subprocess)
 *   - getCampaignTree returns the full nested fixture
 *   - searchSimilar over knowledge_chunks finds the seed chunk (pgvector
 *     pipeline + the deterministic test embedding)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, eq } from 'drizzle-orm';
import { createDb } from '../../src/db/index.js';
import {
  customers,
  leads,
  quotes,
  maxanceActions,
  ads,
  creatives,
  humanActions,
  campaigns,
} from '../../src/db/schema/index.js';
import { getCustomerById } from '../../src/db/repositories/customers.js';
import { decryptCustomerRow } from '../../src/db/repositories/customers.js';
import { getCampaignTree } from '../../src/db/repositories/ads.js';
import { searchSimilar } from '../../src/db/repositories/knowledge.js';

const liveUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!liveUrl);

// Resolve the backend root (two levels up from this file: tests/e2e → backend).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..', '..');

// One key for the whole suite — must be reused by both the subprocess and
// the in-process getCustomerById decrypt assertion (test 2).
const PII_KEY = randomBytes(32).toString('base64');

d('seed-dev CLI e2e', () => {
  const db = createDb(liveUrl!);

  beforeAll(() => {
    // Run the seed script as a subprocess with explicit env. We DO NOT
    // mutate process.env.PII_ENCRYPTION_KEY at the parent level until after
    // the subprocess finishes — we want the parent to inherit the same key
    // for the decrypt assertion.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: liveUrl!,
      PII_ENCRYPTION_KEY: PII_KEY,
      // Keep dev logs out of vitest output unless debugging.
      LOG_LEVEL: 'warn',
    };

    execSync('pnpm exec tsx scripts/seed-dev.ts --yes', {
      cwd: backendRoot,
      env,
      stdio: 'pipe',
    });

    // After subprocess success, mirror the key into the parent so the
    // crypto module (lazy-initialized on first encrypt/decrypt call) can
    // decrypt rows the script just wrote.
    process.env.PII_ENCRYPTION_KEY = PII_KEY;
  });

  it('test 1: inserts the documented row counts', async () => {
    const counts = async (rel: { schema?: string; name?: string } | unknown, table: string) => {
      void rel;
      const rows = (await db.execute(
        sql.raw(`SELECT count(*)::int AS n FROM ${table}`),
      )) as unknown as Array<{ n: number }>;
      return rows[0]!.n;
    };

    expect(await counts(customers, 'customers')).toBe(2);
    expect(await counts(leads, 'leads')).toBe(3);
    expect(await counts(quotes, 'quotes')).toBe(1);
    expect(await counts(maxanceActions, 'maxance_actions')).toBe(3);
    expect(await counts(ads, 'ads')).toBeGreaterThanOrEqual(1);
    expect(await counts(creatives, 'creatives')).toBeGreaterThanOrEqual(1);

    const pending = await db.select().from(humanActions).where(eq(humanActions.status, 'pending'));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.intent).toBe('APPROVE_CREATIVE');
    expect(pending[0]!.severity).toBe(2);
  });

  it('test 2: PII decrypts to the seed plaintext via the repo', async () => {
    // Find Pierre — the only car/voiture customer. Decrypted at the SELECT
    // boundary by drizzle's plain query, then ran through decryptCustomerRow
    // to validate the field-by-field decrypt path.
    const allRows = await db.select().from(customers);
    expect(allRows).toHaveLength(2);

    // Decrypt each then pick by name.
    const decrypted = allRows.map((r) => decryptCustomerRow(r));
    const pierre = decrypted.find((c) => c.fullName === 'Pierre Martin');
    expect(pierre).toBeDefined();
    expect(pierre!.email).toBe('pierre.martin@example.fr');
    expect(pierre!.phone).toBe('+33687654321');
    expect(pierre!.iban).toBe('FR1420041010050500013M02606');
    expect(pierre!.address).toMatchObject({
      city: 'Marseille',
      postcode: '13001',
      country: 'France',
    });

    // Round-trip through the public repo entry point too — proves
    // getCustomerById works end-to-end with the seeded data.
    const refetched = await getCustomerById(db, pierre!.id);
    expect(refetched?.fullName).toBe('Pierre Martin');
  });

  it('test 3: getCampaignTree returns the seeded campaign with adset → ads → creatives', async () => {
    const [c] = await db.select().from(campaigns).limit(1);
    expect(c).toBeDefined();

    const tree = await getCampaignTree(db, c!.id);
    expect(tree).not.toBeNull();
    expect(tree!.name).toBe('Seed — Scooter Acquisition');
    expect(tree!.productLine).toBe('scooter');
    expect(tree!.adsets).toHaveLength(1);

    const adset = tree!.adsets[0]!;
    expect(adset.name).toBe('Seed — Lyon 25-45');
    expect(adset.ads).toHaveLength(2);

    // Each ad has a creative; the angles cover Fear + Legal as documented.
    const angles = adset.ads.map((a) => a.creative?.angle).sort();
    expect(angles).toEqual(['Fear', 'Legal']);

    // And latest metric is populated (we seeded h0).
    for (const ad of adset.ads) {
      expect(ad.latestMetric).not.toBeNull();
    }
  });

  it('test 4: kNN search on knowledge_chunks returns the seed chunk', async () => {
    // The seed uses Array(1536).fill(0.01). Query with the same vector — the
    // seed chunk must be the nearest neighbor (distance ~ 0).
    const queryVec = Array<number>(1536).fill(0.01);
    const hits = await searchSimilar(db, queryVec, { limit: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.chunk.source).toBe('assuryalconseil.fr');
    expect(hits[0]!.distance).toBeLessThan(0.01);
  });
});
