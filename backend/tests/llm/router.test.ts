/**
 * Model-tier router — unit tests. No network.
 */
import { describe, it, expect } from 'vitest';
import { MODEL_IDS, modelIdForTier, tierForModel } from '../../src/llm/router.js';
import type { ModelTier } from '../../src/agents/base.js';

describe('llm/router', () => {
  describe('modelIdForTier', () => {
    it('haiku → claude-haiku-4-5-20251001', () => {
      expect(modelIdForTier('haiku')).toBe('claude-haiku-4-5-20251001');
    });

    it('sonnet → claude-sonnet-4-6', () => {
      expect(modelIdForTier('sonnet')).toBe('claude-sonnet-4-6');
    });

    it('opus → claude-opus-4-7', () => {
      expect(modelIdForTier('opus')).toBe('claude-opus-4-7');
    });

    it('throws on unknown tier', () => {
      expect(() => modelIdForTier('gpt5' as unknown as ModelTier)).toThrow(/Unknown model tier/);
    });
  });

  describe('tierForModel', () => {
    it('is the inverse of modelIdForTier for all known tiers', () => {
      (Object.keys(MODEL_IDS) as ModelTier[]).forEach((tier) => {
        const id = modelIdForTier(tier);
        expect(tierForModel(id)).toBe(tier);
      });
    });

    it('returns undefined for unknown model ids', () => {
      expect(tierForModel('claude-3-opus-20240229')).toBeUndefined();
      expect(tierForModel('')).toBeUndefined();
    });
  });

  describe('MODEL_IDS', () => {
    it('exposes exactly three tiers', () => {
      expect(Object.keys(MODEL_IDS).sort()).toEqual(['haiku', 'opus', 'sonnet']);
    });

    it('is frozen — cannot be mutated at runtime', () => {
      expect(() => {
        (MODEL_IDS as Record<string, string>).haiku = 'tampered';
      }).toThrow();
    });
  });
});
