/**
 * Markdown file ingestion adapter (F16 M7.T1).
 *
 * Splits a single Markdown file by H2 (`## `) headings into sections, then
 * sub-splits anything too large by H3 or paragraph boundaries. Each emitted
 * chunk is prefixed with its section heading so the embedding carries topical
 * context independently of position.
 *
 * Chunk size policy (rough character budget — embeddings tokenize at ~4 chars
 * per token for French prose):
 *   < 600 chars    → keep single chunk (small sections shouldn't fragment).
 *   600..3500 chars → keep single chunk (within budget).
 *   > 3500 chars   → split by H3 (`### `). Each sub-chunk re-prefixed with
 *                    parent H2 heading.
 *   > 3500 after H3 → split by paragraph boundaries (blank-line pairs).
 *
 * TOC heuristic: a section whose heading contains "TABLE DES MATIÈRES" / "TABLE
 * OF CONTENTS" is skipped. These are pure navigation — embedding them poisons
 * the corpus with link-bag chunks that match every query.
 *
 * Anchor slugs: section headings are slugified (strip leading "N. " numbering,
 * accents → ASCII, non-alnum → "-") to produce stable URL fragments used as
 * `source_path` on each chunk. Two chunks coming from the same H2 share the
 * H2 slug; H3-split sub-chunks suffix with `--<h3-slug>` or `--p<n>` for the
 * paragraph fallback.
 *
 * NB: this adapter is filesystem-only. It does not fetch remote MD files
 * (that's the `http-html` adapter's job, M7.T3).
 */
import { readFile } from 'node:fs/promises';
import type { IngestionAdapter } from './types.js';
import type { IngestionSource, IngestableChunk } from '../types.js';

/** Lower / upper bounds in characters. */
const MIN_KEEP_WHOLE = 600;
const MAX_KEEP_WHOLE = 3500;

/** Heuristic markers — any section heading containing one of these is skipped. */
const TOC_MARKERS = ['table des matières', 'table des matieres', 'table of contents'];

export const markdownFileAdapter: IngestionAdapter = {
  id: 'markdown-file',
  async *ingest(source: IngestionSource): AsyncIterable<IngestableChunk> {
    if (!source.path) {
      throw new Error(`markdown-file adapter requires source.path (source.name=${source.name})`);
    }
    const raw = await readFile(source.path, 'utf8');
    yield* chunkMarkdown(raw);
  },
};

/**
 * Exported for unit tests — turn a raw markdown string into chunks without
 * touching the filesystem.
 */
export function* chunkMarkdown(raw: string): Iterable<IngestableChunk> {
  if (!raw.trim()) return;

  const sections = splitByH2(raw);

  // Special case: no H2 at all → emit the whole document as one chunk.
  // The H1 (if any) is preserved verbatim inside `text` so context survives.
  const first = sections[0];
  if (sections.length === 1 && first && first.title === '') {
    yield {
      text: first.body.trim(),
      meta: { sectionTitle: '', anchorId: 'document', type: 'markdown-section' },
      sourcePath: 'document',
    };
    return;
  }

  for (const sec of sections) {
    if (!sec.title) continue; // pre-first-H2 preamble — skip (it's H1 + intro)
    if (isTocSection(sec.title, sec.body)) continue;

    const anchor = slugify(sec.title);
    const fullText = `## ${sec.title}\n\n${sec.body.trim()}`.trim();

    if (fullText.length <= MAX_KEEP_WHOLE) {
      yield {
        text: fullText,
        meta: {
          sectionTitle: sec.title,
          anchorId: anchor,
          type: 'markdown-section',
        },
        sourcePath: anchor,
      };
      continue;
    }

    // Too long → try H3 split.
    const h3Parts = splitByH3(sec.body);
    if (h3Parts.length >= 2) {
      for (const part of h3Parts) {
        const subText = renderH3Chunk(sec.title, part);
        if (subText.length <= MAX_KEEP_WHOLE) {
          yield {
            text: subText,
            meta: {
              sectionTitle: sec.title,
              subsectionTitle: part.title,
              anchorId: `${anchor}--${slugify(part.title)}`,
              type: 'markdown-subsection',
            },
            sourcePath: `${anchor}--${slugify(part.title)}`,
          };
          continue;
        }
        // Even the H3 chunk is too big — fall back to paragraph split.
        yield* paragraphSplit(subText, {
          sectionTitle: sec.title,
          subsectionTitle: part.title,
          baseAnchor: `${anchor}--${slugify(part.title)}`,
        });
      }
      continue;
    }

    // No (or single) H3 → paragraph fallback over the whole section.
    yield* paragraphSplit(fullText, { sectionTitle: sec.title, baseAnchor: anchor });
  }
}

// -----------------------------------------------------------------------------
// Internal: splitting helpers
// -----------------------------------------------------------------------------

interface H2Section {
  /** Heading text without the leading `## `. Empty string for any pre-H2 preamble. */
  title: string;
  /** Body following the heading, up to (but not including) the next H2. */
  body: string;
}

function splitByH2(raw: string): H2Section[] {
  const lines = raw.split(/\r?\n/);
  const sections: H2Section[] = [];
  let current: H2Section = { title: '', body: '' };
  const bodyLines: string[] = [];

  const flush = () => {
    current.body = bodyLines.join('\n');
    sections.push(current);
    bodyLines.length = 0;
  };

  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    // H1 (`# `) and deeper (`### `) are not delimiters — they stay in the body.
    // Only `## ` (exactly two hashes followed by a space) starts a new section.
    if (m && m[1] !== undefined && !line.startsWith('### ')) {
      flush();
      current = { title: m[1].trim(), body: '' };
      continue;
    }
    bodyLines.push(line);
  }
  flush();
  return sections;
}

interface H3Part {
  /** H3 heading text without leading `### `. */
  title: string;
  /** Body following the H3 heading. */
  body: string;
}

function splitByH3(sectionBody: string): H3Part[] {
  const lines = sectionBody.split(/\r?\n/);
  const parts: H3Part[] = [];
  let current: H3Part | null = null;
  const bodyLines: string[] = [];

  const flush = () => {
    if (current) {
      current.body = bodyLines.join('\n').trim();
      parts.push(current);
    }
    bodyLines.length = 0;
  };

  for (const line of lines) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (m && m[1] !== undefined) {
      flush();
      current = { title: m[1].trim(), body: '' };
      continue;
    }
    if (current) bodyLines.push(line);
  }
  flush();
  return parts;
}

function renderH3Chunk(parentTitle: string, part: H3Part): string {
  // Keep the parent H2 at the top so the chunk is self-contained.
  return `## ${parentTitle}\n\n### ${part.title}\n\n${part.body}`.trim();
}

interface ParaSplitContext {
  sectionTitle: string;
  subsectionTitle?: string;
  baseAnchor: string;
}

/**
 * Greedy paragraph packing. Splits the chunk on blank lines, then re-packs
 * paragraphs into chunks that stay under `MAX_KEEP_WHOLE`. Each emitted chunk
 * keeps the heading on top, so even chunk #4 of a long section is contextually
 * grounded.
 */
function* paragraphSplit(fullText: string, ctx: ParaSplitContext): Iterable<IngestableChunk> {
  // Strip the heading-prefix lines so we don't double-print them.
  const lines = fullText.split(/\r?\n/);
  let headerLines: string[] = [];
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (i < 4 && (line.startsWith('## ') || line.startsWith('### ') || line.trim() === '')) {
      headerLines.push(line);
      bodyStart = i + 1;
    } else {
      break;
    }
  }
  // Header reconstruction — always anchor each split with the H2; include H3
  // only if the caller provided a subsectionTitle.
  const headerOut = ctx.subsectionTitle
    ? `## ${ctx.sectionTitle}\n\n### ${ctx.subsectionTitle}`
    : `## ${ctx.sectionTitle}`;
  // If the existing header lines already covered both, prefer them so the
  // caller-provided text isn't re-extracted incorrectly.
  if (!headerLines.length) headerLines = [headerOut];

  const bodyText = lines.slice(bodyStart).join('\n').trim();
  // Drop rule-only paragraphs (`-----`, `***`) — they're visual separators in
  // the source, not content. Without this filter a long section whose final
  // separator lands after a flush emits a near-empty trailing chunk.
  const paragraphs = bodyText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^[-*_=]{3,}\s*$/.test(p));

  // Allowance for the header prefix — keep each packed body under
  // MAX_KEEP_WHOLE minus the header length so the total stays in budget.
  const budget = Math.max(MIN_KEEP_WHOLE, MAX_KEEP_WHOLE - headerOut.length - 4);

  let buf: string[] = [];
  let bufLen = 0;
  let partIndex = 1;

  const emit = function* (): Iterable<IngestableChunk> {
    if (buf.length === 0) return;
    const text = `${headerOut}\n\n${buf.join('\n\n')}`.trim();
    const meta: Record<string, unknown> = {
      sectionTitle: ctx.sectionTitle,
      anchorId: `${ctx.baseAnchor}--p${partIndex}`,
      type: 'markdown-subsection',
      partIndex,
    };
    if (ctx.subsectionTitle) meta.subsectionTitle = ctx.subsectionTitle;
    yield {
      text,
      meta,
      sourcePath: `${ctx.baseAnchor}--p${partIndex}`,
    };
    buf = [];
    bufLen = 0;
    partIndex += 1;
  };

  for (const para of paragraphs) {
    const paraLen = para.length;
    if (bufLen > 0 && bufLen + paraLen + 2 > budget) {
      yield* emit();
    }
    if (paraLen > budget) {
      // Single mega-paragraph that exceeds budget on its own. Hard-split on
      // sentence boundaries; this is the last-resort cut.
      const sentences = para.split(/(?<=[.!?])\s+(?=\S)/);
      for (const s of sentences) {
        if (bufLen > 0 && bufLen + s.length + 1 > budget) {
          yield* emit();
        }
        buf.push(s);
        bufLen += s.length + 1;
      }
      continue;
    }
    buf.push(para);
    bufLen += paraLen + 2;
  }
  yield* emit();
}

// -----------------------------------------------------------------------------
// Internal: classification + slug helpers
// -----------------------------------------------------------------------------

function isTocSection(title: string, body: string): boolean {
  const lc = title.toLowerCase();
  for (const m of TOC_MARKERS) if (lc.includes(m)) return true;
  // Fallback: if the body is overwhelmingly bullet links (`1. [text](#anchor)`
  // lines) and short overall, treat it as TOC. Threshold: >=60% of non-blank
  // lines are markdown-link bullets.
  const nonBlank = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (nonBlank.length === 0) return false;
  const linkLines = nonBlank.filter((l) => /^\s*[-*\d+.]+\s*\[.+\]\(#.+\)\s*$/.test(l));
  return linkLines.length / nonBlank.length >= 0.6;
}

/**
 * Slugify a section heading into a URL anchor. Strips leading "N." numbering,
 * lowercases, removes accents, collapses non-alnum to hyphens. Truncates to
 * 80 chars (DB column has no hard limit but URLs hate marathons).
 *
 * Examples:
 *   "7. TROTTINETTE ÉLECTRIQUE (EDPM)" → "7-trottinette-electrique-edpm"
 *   "1.4 Facteurs déterminant la prime" → "1-4-facteurs-determinant-la-prime"
 */
export function slugify(text: string): string {
  // 1. Decompose accents and strip combining marks.
  // 2. Lowercase.
  // 3. Replace any run of non-[a-z0-9] with a single hyphen.
  // 4. Trim hyphens from edges.
  // `\p{M}` matches any Unicode "Mark" — exactly the combining diacritics
  // NFD splits off from precomposed Latin-1 accents (é → e + U+0301, etc.).
  const ascii = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const slug = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'section';
}
