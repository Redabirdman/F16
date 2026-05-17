/**
 * Prompt-caching helpers — F16 design doc §16.
 *
 * Anthropic's prompt cache works by marking a single "cache breakpoint" in the
 * system content. Everything from the start of the system prompt up to and
 * including that breakpoint is cached server-side; subsequent calls that share
 * the same cached prefix pay ~10% of the input-token cost for that prefix.
 *
 * The raw Anthropic SDK exposes this via per-block `cache_control: { type:
 * 'ephemeral' }` on system content blocks. (Prior to M6.T1 we routed through
 * `@anthropic-ai/claude-agent-sdk`, which used a `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
 * sentinel inside a `string[]`; the raw SDK uses the native Anthropic shape.)
 *
 * Our helpers build a `SystemFragment[]` (a richer in-app representation) and
 * emit `TextBlockParam`-shaped `SystemBlock`s consumed directly by `claude.ts`.
 * This keeps the surface area testable without requiring a live API call.
 *
 * Design rule: only ONE cache breakpoint per system prompt — the LAST fragment
 * marked `cache: true`. Anything before is cached implicitly (Anthropic caches
 * the entire prefix up to the breakpoint), anything after stays dynamic.
 */

/** A logical chunk of system prompt + whether it ends a cacheable prefix. */
export interface SystemFragment {
  text: string;
  cache?: boolean;
}

/**
 * A system-content "block" — a plain text string with an optional cache marker.
 *
 * Mirrors the shape Anthropic's Messages API accepts for system content blocks:
 *   `{ type: 'text', text, cache_control?: { type: 'ephemeral' } }`
 *
 * This is directly assignable to `TextBlockParam` from `@anthropic-ai/sdk` —
 * no translation required at the call site.
 */
export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/**
 * Mark a single chunk of text as a cacheable system-prompt fragment.
 *
 * Use for: brand voice / product knowledge / playbook prompt sections that stay
 * stable for the lifetime of a customer thread.
 */
export function cacheable(text: string): SystemFragment {
  return { text, cache: true };
}

/**
 * Compose a system prompt from an ordered list of fragments.
 *
 * Returns an array of `SystemBlock`s where only the LAST fragment marked
 * `cache: true` carries `cache_control`. Anthropic's prompt cache uses a single
 * breakpoint per request — marking one block as cached implicitly caches every
 * block before it. Earlier `cache: true` fragments are emitted as plain text;
 * they still benefit from the cache because they sit in front of the breakpoint.
 *
 * Fragments AFTER the last cache marker are emitted as plain text and are NOT
 * cached — use these for per-turn dynamic content (current customer state,
 * scratch notes, etc.).
 */
export function buildSystemPrompt(fragments: readonly SystemFragment[]): SystemBlock[] {
  if (fragments.length === 0) return [];

  // Find the LAST cache marker. Everything up to and including it is part of
  // the cacheable prefix; only the marker itself carries cache_control.
  let lastCacheIdx = -1;
  fragments.forEach((f, i) => {
    if (f.cache) lastCacheIdx = i;
  });

  return fragments.map((f, i): SystemBlock => {
    const block: SystemBlock = { type: 'text', text: f.text };
    if (i === lastCacheIdx) {
      block.cache_control = { type: 'ephemeral' };
    }
    return block;
  });
}
