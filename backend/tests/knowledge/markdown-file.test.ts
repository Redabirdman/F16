/**
 * Markdown adapter — pure unit tests (no DB, no embeddings, no fs).
 *
 * Validates the chunking heuristics against in-memory MD strings so the test
 * doesn't depend on the live Assuryal file (which is large and may evolve).
 */
import { describe, it, expect } from 'vitest';
import { chunkMarkdown, slugify } from '../../src/knowledge/adapters/markdown-file.js';

function collect(md: string) {
  return Array.from(chunkMarkdown(md));
}

describe('markdown-file adapter — chunking', () => {
  // ---------------------------------------------------------------------------
  // 1. Three short H2 sections → three chunks, each prefixed with its heading.
  // ---------------------------------------------------------------------------
  it('test 1: three H2 sections yield three chunks with heading prefix', () => {
    const md = [
      '# Top heading',
      '',
      '## Section One',
      'First section body.',
      '',
      '## Section Two',
      'Second section body.',
      '',
      '## Section Three',
      'Third section body.',
    ].join('\n');
    const chunks = collect(md);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.text).toMatch(/^## Section One/);
    expect(chunks[1]!.text).toMatch(/^## Section Two/);
    expect(chunks[2]!.text).toMatch(/^## Section Three/);
    expect(chunks[0]!.meta?.sectionTitle).toBe('Section One');
    expect(chunks[0]!.sourcePath).toBe('section-one');
  });

  // ---------------------------------------------------------------------------
  // 2. A long H2 with two H3 sub-sections splits along H3.
  // ---------------------------------------------------------------------------
  it('test 2: long H2 with two H3s splits into two sub-chunks', () => {
    const longPara = 'lorem '.repeat(400).trim(); // ~2400 chars per H3
    const md = [
      '## Big Topic',
      'Intro paragraph.',
      '',
      '### Subtopic Alpha',
      longPara,
      '',
      '### Subtopic Beta',
      longPara,
    ].join('\n');
    const chunks = collect(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.meta?.subsectionTitle).toBe('Subtopic Alpha');
    expect(chunks[1]!.meta?.subsectionTitle).toBe('Subtopic Beta');
    // Both keep the parent H2 at the top.
    expect(chunks[0]!.text).toMatch(/^## Big Topic/);
    expect(chunks[0]!.text).toContain('### Subtopic Alpha');
    expect(chunks[1]!.text).toContain('### Subtopic Beta');
    expect(chunks[0]!.meta?.type).toBe('markdown-subsection');
  });

  // ---------------------------------------------------------------------------
  // 3. A long H2 with NO H3 falls back to paragraph splitting.
  // ---------------------------------------------------------------------------
  it('test 3: long H2 without H3 splits by paragraph boundaries', () => {
    const para = 'sentence body. '.repeat(80).trim(); // ~1200 chars
    const md = ['## Monolith', para, '', para, '', para, '', para].join('\n');
    const chunks = collect(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      // Each piece is heading-anchored.
      expect(c.text.startsWith('## Monolith')).toBe(true);
      // Each piece respects the size budget (with a small overflow margin
      // since sentence-level splitting is best-effort, not exact).
      expect(c.text.length).toBeLessThan(4500);
      expect(c.meta?.type).toBe('markdown-subsection');
      expect(typeof c.meta?.partIndex).toBe('number');
    }
  });

  // ---------------------------------------------------------------------------
  // 4. TOC section is skipped.
  // ---------------------------------------------------------------------------
  it('test 4: TABLE DES MATIÈRES section is skipped', () => {
    const md = [
      '## TABLE DES MATIÈRES',
      '',
      '1. [Section One](#section-one)',
      '1. [Section Two](#section-two)',
      '',
      '## Section One',
      'Real content here.',
    ].join('\n');
    const chunks = collect(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.meta?.sectionTitle).toBe('Section One');
  });

  // ---------------------------------------------------------------------------
  // 5. meta.sectionTitle matches the H2 heading text (without `##`).
  // ---------------------------------------------------------------------------
  it('test 5: meta.sectionTitle drops the `##` prefix', () => {
    const md = '## 7. TROTTINETTE ÉLECTRIQUE (EDPM)\n\nBody.';
    const chunks = collect(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.meta?.sectionTitle).toBe('7. TROTTINETTE ÉLECTRIQUE (EDPM)');
    expect(chunks[0]!.meta?.anchorId).toBe('7-trottinette-electrique-edpm');
    expect(chunks[0]!.sourcePath).toBe('7-trottinette-electrique-edpm');
  });

  // ---------------------------------------------------------------------------
  // 6. Empty file → zero chunks, no throw.
  // ---------------------------------------------------------------------------
  it('test 6: empty file yields zero chunks', () => {
    expect(collect('')).toHaveLength(0);
    expect(collect('   \n\n  \n')).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 7. File without H2 → one chunk with the whole document.
  // ---------------------------------------------------------------------------
  it('test 7: file with no H2 yields one whole-document chunk', () => {
    const md =
      '# Solo H1\n\nJust a plain document with no H2 sections at all.\n\nSecond paragraph.';
    const chunks = collect(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain('Solo H1');
    expect(chunks[0]!.text).toContain('Second paragraph');
    expect(chunks[0]!.sourcePath).toBe('document');
  });

  // ---------------------------------------------------------------------------
  // Bonus: slugify spec for the anchor format we promise.
  // ---------------------------------------------------------------------------
  it('slugify strips accents and lowercases', () => {
    expect(slugify('7. TROTTINETTE ÉLECTRIQUE (EDPM)')).toBe('7-trottinette-electrique-edpm');
    expect(slugify('Résiliation et Droits')).toBe('resiliation-et-droits');
    expect(slugify('   ')).toBe('section');
  });
});
