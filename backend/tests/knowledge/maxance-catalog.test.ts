/**
 * Maxance product catalogue — ingestion smoke test (M9).
 *
 * Drives the REAL curated catalogue file through the markdown adapter (no DB,
 * no embeddings) and asserts it chunks into per-product sections with the
 * key facts a Sales Agent must be able to retrieve. Guards against the file
 * being moved/renamed/garbled or the bootstrap path drifting.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { markdownFileAdapter } from '../../src/knowledge/adapters/markdown-file.js';
import {
  bootstrapKnowledgeSources,
  __resetBootstrapForTests,
} from '../../src/knowledge/bootstrap.js';
import {
  getKnowledgeSource,
  __resetKnowledgeSourcesForTests,
} from '../../src/knowledge/source-registry.js';
import type { IngestableChunk } from '../../src/knowledge/types.js';

const here = dirname(fileURLToPath(import.meta.url));
// tests/knowledge → backend → F16 root, where the catalogue lives.
const catalogPath = resolve(here, '../../../MAXANCE catalogue produits agent.md');

async function collect(path: string): Promise<IngestableChunk[]> {
  const out: IngestableChunk[] = [];
  for await (const c of markdownFileAdapter.ingest({ name: 'maxance_product_catalog', path })) {
    out.push(c);
  }
  return out;
}

describe('maxance product catalogue', () => {
  it('exists on disk at the F16-root path', () => {
    expect(existsSync(catalogPath)).toBe(true);
  });

  it('bootstrap registers it with the same default path that exists on disk', () => {
    __resetKnowledgeSourcesForTests();
    __resetBootstrapForTests();
    bootstrapKnowledgeSources();
    const src = getKnowledgeSource('maxance_product_catalog');
    expect(src).toBeDefined();
    // The default repo-relative path resolves (from backend/ cwd) to the same
    // file this test located absolutely.
    expect(src!.adapter).toBe('markdown-file');
    __resetKnowledgeSourcesForTests();
    __resetBootstrapForTests();
  });

  it('chunks into per-product sections (one H2 per product)', async () => {
    const chunks = await collect(catalogPath);
    expect(chunks.length).toBeGreaterThanOrEqual(15);
    const titles = chunks.map((c) => String(c.meta?.sectionTitle ?? ''));
    // A representative spread across the product families.
    expect(titles.some((t) => /Nouvelles Mobilités/i.test(t))).toBe(true);
    expect(titles.some((t) => /Moto/i.test(t))).toBe(true);
    expect(titles.some((t) => /Auto Pro/i.test(t))).toBe(true);
    expect(titles.some((t) => /Habitation/i.test(t))).toBe(true);
    expect(titles.some((t) => /Santé/i.test(t))).toBe(true);
  });

  it('encodes the quoting boundary so the Sales Agent knows only NVEI auto-quotes', async () => {
    const chunks = await collect(catalogPath);
    const meta = chunks.find((c) => /périmètre de devis/i.test(String(c.meta?.sectionTitle ?? '')));
    expect(meta).toBeDefined();
    // Names trottinette/NVEI as the only auto-quotable product today.
    expect(meta!.text).toMatch(/NVEI|[Tt]rottinette/);
    expect(meta!.text.toLowerCase()).toContain('devis');
  });

  it('preserves key figures verbatim (compliance-sensitive)', async () => {
    const chunks = await collect(catalogPath);
    const blob = chunks.map((c) => c.text).join('\n');
    // NVEI valeur cap, NVEI franchise minimum, Santé age band.
    expect(blob).toContain('10 000 €');
    expect(blob).toContain('minimum de 50 €');
    expect(blob).toContain('18 à 90 ans');
  });
});
