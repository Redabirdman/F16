/**
 * Knowledge drift detection — integration tests (F16 M7.T4).
 *
 * Gated on TEST_DATABASE_URL + PII_ENCRYPTION_KEY. No Redis needed —
 * `ingestSourceWithDrift` calls `ingestSource` directly without going through
 * the dispatcher/queue.
 *
 * Embeddings are stubbed via `__setEmbeddingClientForTests` so the ingest path
 * stays deterministic and offline. Fixtures are tiny on-the-fly markdown files
 * rewritten between calls to simulate source evolution.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, and } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { knowledgeChunks } from '../../src/db/schema/index.js';
import { EmbeddingClient, __setEmbeddingClientForTests } from '../../src/llm/embeddings.js';
import { ingestSourceWithDrift } from '../../src/knowledge/drift.js';
import { markdownFileAdapter } from '../../src/knowledge/adapters/markdown-file.js';
import { deleteBySource } from '../../src/db/repositories/knowledge.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

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

/** Minimal deterministic stub — drift cares about the rows, not the vectors. */
class StubEmbeddingClient extends EmbeddingClient {
  constructor() {
    super({
      apiKey: 'stub',
      fetchImpl: (async () => ({}) as Response) as typeof fetch,
    });
  }
  override async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => {
      const v = new Array<number>(1536).fill(0);
      v[0] = 1;
      return v;
    });
  }
}

// Fixture A — three H2 sections. Each becomes one chunk with sourcePath = slug.
const FIXTURE_A = [
  '# Drift Fixture',
  '',
  '## 1. SECTION ALPHA',
  '',
  'Le contenu de la section alpha.',
  '',
  '## 2. SECTION BETA',
  '',
  'Une deuxième section avec son propre paragraphe distinct.',
  '',
  '## 3. SECTION GAMMA',
  '',
  'Une troisième section pour le test.',
].join('\n');

// Fixture B — section GAMMA removed (subset of A's source_paths).
const FIXTURE_B = [
  '# Drift Fixture',
  '',
  '## 1. SECTION ALPHA',
  '',
  'Le contenu de la section alpha.',
  '',
  '## 2. SECTION BETA',
  '',
  'Une deuxième section avec son propre paragraphe distinct.',
].join('\n');

// Fixture A+1 — adds SECTION DELTA on top of A.
const FIXTURE_A_PLUS_ONE = [
  FIXTURE_A,
  '',
  '## 4. SECTION DELTA',
  '',
  'Une quatrième section ajoutée pour tester les drifts.',
].join('\n');

// Fixture A but with one body changed (no price drift expected).
const FIXTURE_A_BETA_EDITED = [
  '# Drift Fixture',
  '',
  '## 1. SECTION ALPHA',
  '',
  'Le contenu de la section alpha.',
  '',
  '## 2. SECTION BETA',
  '',
  'Une deuxième section dont le contenu a été modifié pour le test de drift.',
  '',
  '## 3. SECTION GAMMA',
  '',
  'Une troisième section pour le test.',
].join('\n');

// Price fixture pair — drift classifier should flag price_change.
const FIXTURE_PRICE_BEFORE = [
  '# Tarifs',
  '',
  '## 1. FORMULE STANDARD',
  '',
  'La formule standard coûte 5€ par mois.',
  '',
  '## 2. FORMULE PREMIUM',
  '',
  'La formule premium coûte 15€ par mois.',
].join('\n');

const FIXTURE_PRICE_AFTER = [
  '# Tarifs',
  '',
  '## 1. FORMULE STANDARD',
  '',
  'La formule standard coûte 7€ par mois.',
  '',
  '## 2. FORMULE PREMIUM',
  '',
  'La formule premium coûte 15€ par mois.',
].join('\n');

// Mixed-drift fixture pair.
const FIXTURE_MIXED_BEFORE = [
  '# Mixed',
  '',
  '## 1. SECTION ONE',
  '',
  'Premier contenu.',
  '',
  '## 2. SECTION TWO',
  '',
  'Deuxième contenu.',
].join('\n');

const FIXTURE_MIXED_AFTER = [
  '# Mixed',
  '',
  '## 1. SECTION ONE',
  '',
  'Premier contenu modifié.',
  '',
  '## 3. SECTION THREE',
  '',
  'Troisième contenu nouveau.',
].join('\n');

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'f16-drift-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function fixtureFile(name: string, content: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

d('knowledge drift (live pg, stub embeddings)', () => {
  let db: Database;
  const SOURCE = 'drift_test_source';

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await deleteBySource(db, SOURCE);
    __setEmbeddingClientForTests(new StubEmbeddingClient());
  });

  afterEach(async () => {
    __setEmbeddingClientForTests(null);
    await deleteBySource(db, SOURCE);
  });

  // -------------------------------------------------------------------------
  // 1. First run = all added.
  // -------------------------------------------------------------------------
  it('test 1: first run treats every chunk as added (new_product)', async () => {
    const fp = fixtureFile('t1.md', FIXTURE_A);
    const res = await ingestSourceWithDrift(db, markdownFileAdapter, {
      name: SOURCE,
      path: fp,
    });

    expect(res.drift.kind).toBe('new_product');
    expect(res.drift.added.length).toBe(3);
    expect(res.drift.removed).toHaveLength(0);
    expect(res.drift.changed).toHaveLength(0);
    expect(res.drift.unchanged).toBe(0);
    expect(res.orphansDeleted).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 2. Second run with no changes = no drift.
  // -------------------------------------------------------------------------
  it('test 2: rerun on unchanged source yields no drift (kind=null)', async () => {
    const fp = fixtureFile('t2.md', FIXTURE_A);
    await ingestSourceWithDrift(db, markdownFileAdapter, { name: SOURCE, path: fp });
    const second = await ingestSourceWithDrift(db, markdownFileAdapter, {
      name: SOURCE,
      path: fp,
    });

    expect(second.drift.kind).toBeNull();
    expect(second.drift.added).toHaveLength(0);
    expect(second.drift.removed).toHaveLength(0);
    expect(second.drift.changed).toHaveLength(0);
    expect(second.drift.unchanged).toBe(3);
    expect(second.orphansDeleted).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. Removed chunk → kind=removed_product + orphan deleted.
  // -------------------------------------------------------------------------
  it('test 3: dropping a chunk emits removed_product + deletes the orphan row', async () => {
    const fp = fixtureFile('t3.md', FIXTURE_A);
    await ingestSourceWithDrift(db, markdownFileAdapter, { name: SOURCE, path: fp });

    writeFileSync(fp, FIXTURE_B, 'utf8');
    const second = await ingestSourceWithDrift(db, markdownFileAdapter, {
      name: SOURCE,
      path: fp,
    });

    expect(second.drift.kind).toBe('removed_product');
    expect(second.drift.removed).toHaveLength(1);
    expect(second.drift.added).toHaveLength(0);
    expect(second.drift.changed).toHaveLength(0);
    expect(second.orphansDeleted).toBe(1);

    const orphanPath = second.drift.removed[0]!;
    const stillThere = await db
      .select()
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.source, SOURCE), eq(knowledgeChunks.sourcePath, orphanPath)));
    expect(stillThere).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. Added chunk → kind=new_product.
  // -------------------------------------------------------------------------
  it('test 4: adding a chunk emits new_product with added.length=1', async () => {
    const fp = fixtureFile('t4.md', FIXTURE_A);
    await ingestSourceWithDrift(db, markdownFileAdapter, { name: SOURCE, path: fp });

    writeFileSync(fp, FIXTURE_A_PLUS_ONE, 'utf8');
    const second = await ingestSourceWithDrift(db, markdownFileAdapter, {
      name: SOURCE,
      path: fp,
    });

    expect(second.drift.kind).toBe('new_product');
    expect(second.drift.added).toHaveLength(1);
    expect(second.drift.removed).toHaveLength(0);
    expect(second.drift.changed).toHaveLength(0);
    expect(second.orphansDeleted).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. Changed chunk (no price) → kind='other'.
  // -------------------------------------------------------------------------
  it("test 5: editing a chunk without price changes yields kind='other'", async () => {
    const fp = fixtureFile('t5.md', FIXTURE_A);
    await ingestSourceWithDrift(db, markdownFileAdapter, { name: SOURCE, path: fp });

    writeFileSync(fp, FIXTURE_A_BETA_EDITED, 'utf8');
    const second = await ingestSourceWithDrift(db, markdownFileAdapter, {
      name: SOURCE,
      path: fp,
    });

    expect(second.drift.kind).toBe('other');
    expect(second.drift.changed).toHaveLength(1);
    expect(second.drift.added).toHaveLength(0);
    expect(second.drift.removed).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 6. Price change → kind='price_change'.
  // -------------------------------------------------------------------------
  it("test 6: edited price body produces kind='price_change'", async () => {
    const fp = fixtureFile('t6.md', FIXTURE_PRICE_BEFORE);
    await ingestSourceWithDrift(db, markdownFileAdapter, { name: SOURCE, path: fp });

    writeFileSync(fp, FIXTURE_PRICE_AFTER, 'utf8');
    const second = await ingestSourceWithDrift(db, markdownFileAdapter, {
      name: SOURCE,
      path: fp,
    });

    expect(second.drift.kind).toBe('price_change');
    expect(second.drift.changed.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 7. Mixed drift → kind='other', every bucket populated.
  // -------------------------------------------------------------------------
  it("test 7: mixed drift (added + removed + changed) lands in kind='other'", async () => {
    const fp = fixtureFile('t7.md', FIXTURE_MIXED_BEFORE);
    await ingestSourceWithDrift(db, markdownFileAdapter, { name: SOURCE, path: fp });

    writeFileSync(fp, FIXTURE_MIXED_AFTER, 'utf8');
    const second = await ingestSourceWithDrift(db, markdownFileAdapter, {
      name: SOURCE,
      path: fp,
    });

    expect(second.drift.kind).toBe('other');
    expect(second.drift.added.length).toBeGreaterThanOrEqual(1);
    expect(second.drift.removed.length).toBeGreaterThanOrEqual(1);
    expect(second.drift.changed.length).toBeGreaterThanOrEqual(1);
    // Orphans cleaned up: one row per removed path + one stale-sha row per
    // changed path (the old-sha row that lingered after the new-sha upsert).
    expect(second.orphansDeleted).toBe(second.drift.removed.length + second.drift.changed.length);
  });
});
