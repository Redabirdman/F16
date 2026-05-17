/**
 * Markdown → HTML / plain-text helpers for the email channel (M4.T4).
 *
 * Backed by the `marked` package (small, well-maintained, zero deps for the
 * core renderer). We expose two functions:
 *   - `renderMarkdownToHtml(src)` — for the email `html` part
 *   - `stripMarkdownToText(src)` — for the email `text` part (plain fallback)
 *
 * We configure `marked` synchronously (`async: false`) and disable GFM tables
 * because none of the agent-generated content uses them; this also keeps the
 * HTML output tight for email clients.
 */
import { marked } from 'marked';

// Configure marked once at module load. We need:
//   - sync mode so callers don't need to await (keeps the adapter readable)
//   - line breaks honored (agents put soft wraps in their output)
//   - no mangling/headerIds — those produce id attrs that email clients ignore
marked.setOptions({
  async: false,
  gfm: true,
  breaks: true,
  pedantic: false,
});

/**
 * Render a markdown string to HTML. Block-level — wraps paragraphs in `<p>`,
 * bold in `<strong>`, links in `<a>`, etc.
 *
 * Note: marked already HTML-escapes raw text in the source, so we don't need
 * a separate sanitizer for the trusted (agent-generated) markdown we put in.
 * If we ever start accepting user-authored markdown for emails we should add
 * DOMPurify-equivalent on top.
 */
export function renderMarkdownToHtml(src: string): string {
  const out = marked.parse(src, { async: false });
  // With async:false marked.parse returns string synchronously; cast for TS.
  return (out as string).trim();
}

/**
 * Strip markdown syntax to produce a plain-text version suitable for the
 * email `text` part. We do not try to round-trip via HTML — instead we run
 * a few cheap regex passes for the small subset we emit:
 *   - bold/italic markers
 *   - link `[text](url)` → `text (url)`
 *   - inline code backticks
 *   - heading hashes / leading list markers
 */
export function stripMarkdownToText(src: string): string {
  return (
    src
      // Links: [text](url) → text (url)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      // Images: ![alt](url) → alt (url)
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
      // Bold **x** / __x__
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      // Italic *x* / _x_  (avoid mid-word underscores)
      .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1$2')
      .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')
      // Inline code `x`
      .replace(/`([^`]+)`/g, '$1')
      // Leading heading hashes
      .replace(/^#{1,6}\s+/gm, '')
      // Leading bullet markers
      .replace(/^\s*[-*+]\s+/gm, '- ')
      // Leading ordered list markers (1. 2. …)
      .replace(/^\s*\d+\.\s+/gm, '')
      .trim()
  );
}
