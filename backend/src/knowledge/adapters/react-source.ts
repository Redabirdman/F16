/**
 * React source ingestion adapter (F16 M7.T2).
 *
 * Walks a React source tree (Assuryal's conversion-machine TSX site, in V1)
 * and extracts the user-facing copy from each file via a TypeScript AST
 * parse. Output is a stream of `IngestableChunk` rows, one (or several, for
 * very long files) per source file, suitable for the same embed + upsert
 * pipeline as the markdown adapter.
 *
 * What we extract:
 *   - JSX text nodes (`<h1>Bonjour</h1>` → "Bonjour")
 *   - A small allowlist of JSX attributes that carry user-visible strings
 *     (`title`, `description`, `placeholder`, `aria-label`, `alt`, `label`)
 *   - `<meta name|property="…" content="…">` content values
 *   - Top-level string literals from `data`/`content` files (e.g.
 *     `src/data/products.ts`, `src/content/faq.tsx`) — anything looking like
 *     prose (≥20 chars, contains a space + a letter)
 *
 * What we skip:
 *   - Directories: `node_modules`, `dist`, `.next`, `.cache`, `public`,
 *     `assets`
 *   - Files: `*.test.tsx`, `*.spec.tsx`, `*.config.tsx`, `*.d.ts`
 *   - Pure CSS-class strings, single-character labels, anything that isn't
 *     a letter-bearing word
 *
 * The adapter is read-only — it never mutates the source tree. Parse errors
 * are logged and the file is skipped so a single bad TSX file can't break
 * a 1000-file ingestion run.
 *
 * Chunking policy: one chunk per file under ~3000 chars. Files with more
 * strings split into multiple chunks that all share the same `sourcePath`
 * (the file's path relative to the ingestion root, forward-slashed), so
 * citations stay file-anchored.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, basename, extname, sep } from 'node:path';
import * as ts from 'typescript';
import type { IngestionAdapter } from './types.js';
import type { IngestionSource, IngestableChunk } from '../types.js';
import { logger } from '../../logger.js';

/** Soft target for a single chunk's text length (chars). */
const MAX_CHUNK_CHARS = 3000;

/** Min length for a JSX-text fragment to be considered user-facing. */
const MIN_JSX_TEXT_LEN = 3;

/** Min length for a "data prose" string literal in data/content files. */
const MIN_DATA_PROSE_LEN = 20;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.cache', 'public', 'assets']);

const SKIP_FILE_SUFFIXES = ['.test.tsx', '.spec.tsx', '.config.tsx', '.d.ts'];

const ALLOWED_EXTENSIONS = new Set(['.tsx', '.jsx', '.ts']);

/** JSX attributes whose string values are visible to humans. */
const USER_FACING_ATTRS = new Set([
  'title',
  'description',
  'placeholder',
  'aria-label',
  'alt',
  'label',
]);

/** Matches when a string contains at least one Unicode letter. */
const LETTER_RE = /\p{L}/u;

/**
 * Matches "kebab-case-identifier" style strings — all-lowercase letters/digits
 * joined by hyphens or underscores, with no whitespace. These are almost
 * always CSS class names, dev-only markers, or test fixtures that slipped
 * into JSX text; never user-facing prose.
 */
const KEBAB_IDENT_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;

export const reactSourceAdapter: IngestionAdapter = {
  id: 'react-source',
  async *ingest(source: IngestionSource): AsyncIterable<IngestableChunk> {
    if (!source.path) {
      throw new Error(`react-source adapter requires source.path (source.name=${source.name})`);
    }
    yield* walkAndExtract(source.path);
  },
};

// -----------------------------------------------------------------------------
// Walk
// -----------------------------------------------------------------------------

async function* walkAndExtract(rootDir: string): AsyncIterable<IngestableChunk> {
  for await (const filePath of walk(rootDir, rootDir)) {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      logger.warn(
        { filePath, err: err instanceof Error ? err.message : String(err) },
        'react-source: read failed, skipping',
      );
      continue;
    }
    let strings: string[];
    try {
      strings = extractStrings(filePath, raw);
    } catch (err) {
      logger.warn(
        { filePath, err: err instanceof Error ? err.message : String(err) },
        'react-source: parse failed, skipping',
      );
      continue;
    }
    if (strings.length === 0) continue;

    const relPath = relPosix(rootDir, filePath);
    yield* chunkStrings(relPath, filePath, strings);
  }
}

async function* walk(rootDir: string, dir: string): AsyncIterable<string> {
  let entries: Array<{ name: string; isDir: boolean; isFile: boolean }>;
  try {
    const raw = await readdir(dir, { withFileTypes: true });
    entries = raw.map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
      isFile: d.isFile(),
    }));
  } catch {
    // readdir without withFileTypes fallback (e.g. older fs) — uncommon, but cheap.
    try {
      const names = await readdir(dir);
      entries = [];
      for (const name of names) {
        const full = join(dir, name);
        const s = await stat(full);
        entries.push({ name, isDir: s.isDirectory(), isFile: s.isFile() });
      }
    } catch (err2) {
      logger.warn(
        { dir, err: err2 instanceof Error ? err2.message : String(err2) },
        'react-source: readdir failed, skipping',
      );
      return;
    }
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDir) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(rootDir, full);
      continue;
    }
    if (!entry.isFile) continue;
    if (!isProcessableFile(entry.name)) continue;
    yield full;
  }
}

function isProcessableFile(name: string): boolean {
  for (const suf of SKIP_FILE_SUFFIXES) {
    if (name.endsWith(suf)) return false;
  }
  const ext = extname(name);
  return ALLOWED_EXTENSIONS.has(ext);
}

function relPosix(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join('/');
}

// -----------------------------------------------------------------------------
// AST extraction
// -----------------------------------------------------------------------------

/**
 * Parse the file with the TS compiler API and harvest user-facing strings.
 * Exported so unit tests can drive it without filesystem setup.
 */
export function extractStrings(filePath: string, raw: string): string[] {
  const ext = extname(filePath).toLowerCase();
  const scriptKind = ext === '.tsx' || ext === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, raw, ts.ScriptTarget.Latest, true, scriptKind);

  const isDataFile = looksLikeDataFile(filePath);
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (s: string | undefined | null): void => {
    if (!s) return;
    const text = s.trim();
    if (text.length < MIN_JSX_TEXT_LEN) return;
    if (!LETTER_RE.test(text)) return;
    // Filter out kebab/snake-case identifiers — CSS class names, test markers,
    // dev-only attributes that leak into JSX text. Real user-facing copy never
    // looks like `text-red-500` or `should-not-extract`.
    if (KEBAB_IDENT_RE.test(text)) return;
    if (seen.has(text)) return;
    seen.add(text);
    out.push(text);
  };

  const visit = (node: ts.Node): void => {
    // 1. JSX text nodes.
    if (ts.isJsxText(node)) {
      push(node.text);
    }
    // 2. JSX attributes from the allowlist.
    else if (ts.isJsxAttribute(node)) {
      const name = jsxAttrName(node);
      if (name && USER_FACING_ATTRS.has(name)) {
        push(jsxAttrStringValue(node));
      }
    }
    // 3. <meta name|property="…" content="…">
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = jsxTagName(node);
      if (tag === 'meta') {
        const attrs = collectAttrs(node.attributes);
        const key = attrs.get('name') ?? attrs.get('property');
        const content = attrs.get('content');
        if (key && content) push(content);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  // 4. Data files: scan top-level string literals not already captured.
  if (isDataFile) {
    const visitData = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const text = node.text;
        if (text.length >= MIN_DATA_PROSE_LEN && /\s/.test(text) && LETTER_RE.test(text)) {
          push(text);
        }
      }
      ts.forEachChild(node, visitData);
    };
    visitData(sf);
  }

  return out;
}

function jsxAttrName(attr: ts.JsxAttribute): string | undefined {
  const name = attr.name;
  if (ts.isIdentifier(name)) return name.text;
  // JsxNamespacedName (e.g. xml:lang) — last segment is the local name.
  if ('name' in name && name.name && ts.isIdentifier(name.name)) return name.name.text;
  return undefined;
}

/** Extract a string from a JSX attribute initializer, handling both forms. */
function jsxAttrStringValue(attr: ts.JsxAttribute): string | undefined {
  const init = attr.initializer;
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const expr = init.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return expr.text;
    }
  }
  return undefined;
}

function jsxTagName(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string | undefined {
  const t = el.tagName;
  if (ts.isIdentifier(t)) return t.text;
  return undefined;
}

function collectAttrs(attrs: ts.JsxAttributes): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const name = jsxAttrName(a);
    if (!name) continue;
    const val = jsxAttrStringValue(a);
    if (val !== undefined) out.set(name, val);
  }
  return out;
}

function looksLikeDataFile(filePath: string): boolean {
  const norm = filePath.split(sep).join('/');
  if (norm.includes('/data/') || norm.includes('/content/')) return true;
  const name = basename(filePath).toLowerCase();
  if (name.startsWith('data.') || name.startsWith('content.')) return true;
  return false;
}

// -----------------------------------------------------------------------------
// Chunking
// -----------------------------------------------------------------------------

function* chunkStrings(
  relPath: string,
  filePath: string,
  strings: string[],
): Iterable<IngestableChunk> {
  const header = `Source: ${relPath}\n\n`;
  // Greedy pack lines into chunks under MAX_CHUNK_CHARS.
  const totalStrings = strings.length;
  let buf: string[] = [];
  let bufLen = header.length;

  const ext = extname(filePath).toLowerCase();
  const fileType =
    ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : ext === '.ts' ? 'ts' : 'unknown';

  const flush = function* (): Iterable<IngestableChunk> {
    if (buf.length === 0) return;
    const body = buf.join('\n');
    const text = `${header}${body}`;
    yield {
      text,
      sourcePath: relPath,
      meta: {
        filePath: relPath,
        fileType,
        stringCount: buf.length,
        totalStringCount: totalStrings,
        type: 'react-source',
      },
    };
    buf = [];
    bufLen = header.length;
  };

  for (const s of strings) {
    const line = `- ${s}`;
    // +1 for the newline join cost between lines.
    const addLen = line.length + (buf.length === 0 ? 0 : 1);
    if (bufLen + addLen > MAX_CHUNK_CHARS && buf.length > 0) {
      yield* flush();
    }
    buf.push(line);
    bufLen += addLen === 0 ? line.length : addLen;
  }
  yield* flush();
}
