/**
 * Model tier → Anthropic model id mapping (F16 design doc §16).
 *
 * F16 routes by tier — not by raw model id — so a single env-driven flip can
 * upgrade Sonnet 4.6 → 4.7 across every agent without touching call sites.
 *
 * R2 routing decision (Ridaa, design doc §16): Claude traffic goes Anthropic-direct,
 * NOT through OpenRouter, because OpenRouter does not preserve prompt caching.
 * Caching is the whole point of R2 for sales/support agents — the brand voice +
 * playbook system prompt is ~3-5k tokens and must be cached cross-turn.
 */
import type { ModelTier } from '../agents/base.js';

/** Single source of truth for which Anthropic model serves each tier. */
export const MODEL_IDS: Readonly<Record<ModelTier, string>> = Object.freeze({
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
});

/** Reverse lookup — useful for logging the tier given a raw model id. */
export function tierForModel(modelId: string): ModelTier | undefined {
  for (const [tier, id] of Object.entries(MODEL_IDS) as [ModelTier, string][]) {
    if (id === modelId) return tier;
  }
  return undefined;
}

/** Throws if the tier is unknown — guards typos at call sites. */
export function modelIdForTier(tier: ModelTier): string {
  const id = MODEL_IDS[tier];
  if (!id) throw new Error(`Unknown model tier: ${tier}`);
  return id;
}
