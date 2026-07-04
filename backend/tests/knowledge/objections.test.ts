/**
 * Assuryal objection-handling playbook — ingestion smoke test.
 *
 * Drives the REAL cleaned objections file through the markdown adapter (no
 * DB, no embeddings) and asserts it chunks into the objection categories the
 * Sales Agent must be able to retrieve when a lead pushes back. Also guards
 * the cleanup invariants: no 'Oriafen' branding, no '**Exercice :**' human
 * training lines, no bare '[X]' placeholders (every bracket must carry
 * guidance the LLM can substitute). Same pattern as closing-rules.test.ts.
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
// tests/knowledge → backend → F16 root, where the playbook lives.
const objectionsPath = resolve(here, '../../../ASSURYAL objections agent.md');

async function collect(path: string): Promise<IngestableChunk[]> {
  const out: IngestableChunk[] = [];
  for await (const c of markdownFileAdapter.ingest({ name: 'assuryal_objections', path })) {
    out.push(c);
  }
  return out;
}

describe('assuryal objections playbook', () => {
  it('exists on disk at the F16-root path', () => {
    expect(existsSync(objectionsPath)).toBe(true);
  });

  it('bootstrap registers it with the markdown adapter', () => {
    __resetKnowledgeSourcesForTests();
    __resetBootstrapForTests();
    bootstrapKnowledgeSources();
    const src = getKnowledgeSource('assuryal_objections');
    expect(src).toBeDefined();
    expect(src!.adapter).toBe('markdown-file');
    expect(src!.scheduled).toBe(true);
    __resetKnowledgeSourcesForTests();
    __resetBootstrapForTests();
  });

  it('chunks into the objection categories (one H2 each)', async () => {
    const chunks = await collect(objectionsPath);
    const titles = chunks.map((c) => String(c.meta?.sectionTitle ?? ''));
    expect(titles.some((t) => /PRIX/i.test(t))).toBe(true);
    expect(titles.some((t) => /TIMING/i.test(t))).toBe(true);
    expect(titles.some((t) => /CONFIANCE/i.test(t))).toBe(true);
    expect(titles.some((t) => /BESOIN/i.test(t))).toBe(true);
    expect(titles.some((t) => /PROCRASTINATION/i.test(t))).toBe(true);
    expect(titles.some((t) => /DÉCISION/i.test(t))).toBe(true);
    expect(titles.some((t) => /EXPÉRIENCE NÉGATIVE/i.test(t))).toBe(true);
    expect(titles.some((t) => /SPÉCIFIQUES/i.test(t))).toBe(true);
  });

  it('carries all 31 objections', async () => {
    const chunks = await collect(objectionsPath);
    const blob = chunks.map((c) => c.text).join('\n');
    for (let n = 1; n <= 31; n++) {
      expect(blob, `objection #${n} missing`).toMatch(new RegExp(`### ${n}\\. `));
    }
  });

  it('is cleaned: no Oriafen branding, no training exercises, no bare [X] placeholders', async () => {
    const chunks = await collect(objectionsPath);
    const blob = chunks.map((c) => c.text).join('\n');
    expect(blob).not.toMatch(/Oriafen/i);
    expect(blob).not.toMatch(/\*\*Exercice/i);
    // Bracket placeholders must carry guidance, never a bare metavariable the
    // agent could parrot: [X], [date future], [noms], [âge + 5 ans], [X/30]…
    expect(blob).not.toMatch(/\[X(?:\/30)?\]/);
    expect(blob).not.toMatch(/\[(date future|noms|âge[^\]]*)\]/i);
  });

  it('keeps the compliance framing: real-monthly prices, no delay promises, RC obligatoire', async () => {
    const chunks = await collect(objectionsPath);
    const blob = chunks.map((c) => c.text).join('\n');
    expect(blob).toContain('mensualité réelle du devis');
    expect(blob).toMatch(/responsabilité civile/i);
    expect(blob).toMatch(/obligat/i); // obligation légale / obligatoire
    // Softened away: hard delay/callback promises from the original doc.
    expect(blob).not.toMatch(/30 jours après/);
    expect(blob).not.toMatch(/rappelle dans 24h/);
    expect(blob).not.toMatch(/moins de 15 minutes/);
  });
});
