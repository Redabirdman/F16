/**
 * React-source adapter — pure unit tests (no DB, no embeddings, no network).
 *
 * Drives the adapter against `tests/knowledge/fixtures/react-source/`, which
 * contains a miniature TSX tree (pages, data, tests, node_modules) shaped to
 * exercise every branch of the walker and extractor.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { reactSourceAdapter } from '../../src/knowledge/adapters/react-source.js';
import type { IngestableChunk } from '../../src/knowledge/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixtureDir = resolve(__dirname, 'fixtures', 'react-source');

async function collect(): Promise<IngestableChunk[]> {
  const out: IngestableChunk[] = [];
  for await (const chunk of reactSourceAdapter.ingest({ name: 'fix', path: fixtureDir })) {
    out.push(chunk);
  }
  return out;
}

/** Find chunks whose sourcePath matches a forward-slash relative path. */
function chunksFor(all: IngestableChunk[], relPath: string): IngestableChunk[] {
  return all.filter((c) => c.sourcePath === relPath);
}

describe('react-source adapter', () => {
  // 1
  it('test 1: ingest yields chunks for the fixture tree', async () => {
    const all = await collect();
    expect(all.length).toBeGreaterThan(0);
  });

  // 2
  it('test 2: walk skips node_modules, __tests__ files, and .d.ts', async () => {
    const all = await collect();
    const paths = all.map((c) => c.sourcePath ?? '');
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths.some((p) => p.includes('__tests__/'))).toBe(false);
    expect(paths.some((p) => p.endsWith('.test.tsx'))).toBe(false);
    expect(paths.some((p) => p.endsWith('.d.ts'))).toBe(false);
    // Sanity check — no stray test-content string leaked from skipped files.
    for (const c of all) expect(c.text).not.toContain('test-content');
  });

  // 3
  it('test 3: Home.tsx chunk contains the expected user-facing strings', async () => {
    const all = await collect();
    const home = chunksFor(all, 'pages/Home.tsx');
    expect(home.length).toBeGreaterThanOrEqual(1);
    const combined = home.map((c) => c.text).join('\n');
    expect(combined).toContain('Bonjour Assuryal');
    expect(combined).toContain('Votre email');
    expect(combined).toContain('Assurance trottinette à 5€/mois');
  });

  // 4
  it('test 4: Home.tsx chunk does not leak class names or non-user strings', async () => {
    const all = await collect();
    const home = chunksFor(all, 'pages/Home.tsx');
    const combined = home.map((c) => c.text).join('\n');
    expect(combined).not.toContain('text-red-500');
    expect(combined).not.toContain('should-not-extract');
  });

  // 5
  it('test 5: Quote.tsx chunk contains heading + aria-label values', async () => {
    const all = await collect();
    const quote = chunksFor(all, 'pages/Quote.tsx');
    expect(quote.length).toBeGreaterThanOrEqual(1);
    const combined = quote.map((c) => c.text).join('\n');
    expect(combined).toContain('Devis trottinette électrique');
    expect(combined).toContain('Obtenir un devis');
  });

  // 6
  it('test 6: data/products.ts chunk contains the prose description', async () => {
    const all = await collect();
    const products = chunksFor(all, 'data/products.ts');
    expect(products.length).toBeGreaterThanOrEqual(1);
    const combined = products.map((c) => c.text).join('\n');
    expect(combined).toContain('Trottinette électrique à partir de 5 euros par mois');
  });

  // 7
  it('test 7: every chunk has meta.type = "react-source"', async () => {
    const all = await collect();
    for (const c of all) {
      expect(c.meta?.type).toBe('react-source');
    }
  });

  // 8
  it('test 8: sourcePath is the fixture-relative path with forward slashes', async () => {
    const all = await collect();
    for (const c of all) {
      const p = c.sourcePath ?? '';
      expect(p.length).toBeGreaterThan(0);
      expect(p.includes('\\')).toBe(false);
      // Path must be relative — never absolute (no Windows drive letter, no leading slash).
      expect(/^[A-Za-z]:/.test(p)).toBe(false);
      expect(p.startsWith('/')).toBe(false);
    }
    // And specific fixtures should resolve to the expected forward-slash form.
    const paths = new Set(all.map((c) => c.sourcePath));
    expect(paths.has('pages/Home.tsx')).toBe(true);
    expect(paths.has('pages/Quote.tsx')).toBe(true);
    expect(paths.has('data/products.ts')).toBe(true);
  });

  // 9
  it('test 9: dedup — a string repeated in one file appears once in its chunk', async () => {
    // Home.tsx has `<h1>Bonjour Assuryal</h1>` twice — the chunk should only
    // contain the literal once.
    const all = await collect();
    const home = chunksFor(all, 'pages/Home.tsx');
    const combined = home.map((c) => c.text).join('\n');
    const matches = combined.match(/Bonjour Assuryal/g) ?? [];
    expect(matches.length).toBe(1);
  });

  // 10
  it('test 10: chunking — a long file yields multiple chunks with the same sourcePath', async () => {
    const all = await collect();
    const long = chunksFor(all, 'pages/Long.tsx');
    expect(long.length).toBeGreaterThanOrEqual(2);
    // Each chunk stays under the soft cap (allowing a tiny overflow margin for
    // the line that pushed it over).
    for (const c of long) {
      expect(c.text.length).toBeLessThan(3300);
      expect(c.sourcePath).toBe('pages/Long.tsx');
      expect(c.meta?.type).toBe('react-source');
    }
  });
});
