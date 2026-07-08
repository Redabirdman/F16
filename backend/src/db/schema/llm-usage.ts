/**
 * `llm_usage` — per-call Anthropic token accounting (admin costs, 2026-07-08).
 *
 * Every `callClaude` / `callClaudeWithTools` completion records one row via
 * the usage sink (src/llm/usage-log.ts). The row stores raw token counts —
 * NEVER a computed price: prices change and are applied at query time by the
 * admin costs router (src/admin/costs.ts price map), so historical rows stay
 * correct when pricing moves.
 *
 * Volume: one row per LLM call ≈ a few hundred rows/day at current traffic.
 * The month-bucket queries scope on occurred_at, covered by the DESC index.
 *
 * No PII: model id, tier, agent role and token counters only.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

export const llmUsage = pgTable(
  'llm_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Raw Anthropic model id, e.g. 'claude-sonnet-4-6'. */
    model: text('model').notNull(),
    /** F16 routing tier at call time: haiku | sonnet | opus. */
    tier: text('tier').notNull(),
    /** Calling agent role when known (from logContext), e.g. 'sales-agent'. */
    agentRole: text('agent_role'),
    /** Free-form purpose tag when the caller provides one, e.g. 'reply', 'sentry'. */
    purpose: text('purpose'),

    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),

    /** Wall-clock duration of the call (all iterations for tool loops). */
    durationMs: integer('duration_ms'),
    /** Tool-loop iterations (1 for plain callClaude). */
    iterations: integer('iterations').notNull().default(1),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('llm_usage_occurred_at_idx').on(sql`${t.occurredAt} DESC`),
    index('llm_usage_model_idx').on(t.model),
  ],
);

export type LlmUsageRow = typeof llmUsage.$inferSelect;
export type NewLlmUsageRow = typeof llmUsage.$inferInsert;
