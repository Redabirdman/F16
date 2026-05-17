/**
 * Prompt-cache helpers — unit tests. No network.
 *
 * Anthropic's prompt cache uses a SINGLE breakpoint per request: marking one
 * block as cached implicitly caches every block before it. So `buildSystemPrompt`
 * only stamps `cache_control` on the LAST fragment marked `cache: true`.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, cacheable } from '../../src/llm/cache.js';

describe('llm/cache', () => {
  describe('cacheable', () => {
    it('returns a SystemFragment with cache: true', () => {
      expect(cacheable('hello world')).toEqual({ text: 'hello world', cache: true });
    });
  });

  describe('buildSystemPrompt', () => {
    it('returns [] for an empty fragment list', () => {
      expect(buildSystemPrompt([])).toEqual([]);
    });

    it('stamps cache_control on a single cached fragment', () => {
      const blocks = buildSystemPrompt([{ text: 'A', cache: true }]);
      expect(blocks).toEqual([{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }]);
    });

    it('leaves non-cached fragments as plain text blocks', () => {
      const blocks = buildSystemPrompt([{ text: 'A' }, { text: 'B' }]);
      expect(blocks).toEqual([
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
      ]);
      blocks.forEach((b) => expect(b.cache_control).toBeUndefined());
    });

    it('cached + uncached: only the cached fragment carries cache_control', () => {
      const blocks = buildSystemPrompt([{ text: 'A', cache: true }, { text: 'B' }]);
      expect(blocks).toEqual([
        { type: 'text', text: 'A', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'B' },
      ]);
    });

    it('multiple cache markers: only the LAST one carries cache_control', () => {
      // Anthropic caches everything before the breakpoint, so we put the marker
      // on the last cacheable fragment — A is cached implicitly because it sits
      // in front of B's breakpoint. C is dynamic (after the breakpoint).
      const blocks = buildSystemPrompt([
        { text: 'A', cache: true },
        { text: 'B', cache: true },
        { text: 'C' },
      ]);
      expect(blocks).toEqual([
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'C' },
      ]);
    });

    it('integrates with cacheable() helper', () => {
      const blocks = buildSystemPrompt([cacheable('prefix'), { text: 'dynamic' }]);
      expect(blocks).toEqual([
        { type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'dynamic' },
      ]);
    });
  });
});
