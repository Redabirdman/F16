import { z } from 'zod';
import { registerIntent } from './_registry.js';

export const KnowledgeReindexRequestedPayload = registerIntent(
  'KNOWLEDGE.REINDEX_REQUESTED',
  z.object({
    source: z.string(),
    force: z.boolean().optional(),
  }),
);

export const KnowledgeReindexedPayload = registerIntent(
  'KNOWLEDGE.REINDEXED',
  z.object({
    source: z.string(),
    chunkCount: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
);

export const KnowledgeDriftDetectedPayload = registerIntent(
  'KNOWLEDGE.DRIFT_DETECTED',
  z.object({
    source: z.string(),
    kind: z.enum(['price_change', 'new_product', 'removed_product', 'other']),
    details: z.record(z.string(), z.unknown()),
  }),
);
