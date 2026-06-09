/**
 * `prompt_overrides` (M14.T6).
 *
 * Per-key override of an agent prompt, editable from the admin. The key is a
 * stable dotted id registered in `src/prompts/registry.ts` (e.g.
 * `sales-agent.system`). When a row exists, `resolvePrompt` returns its
 * `content` instead of the code default; deleting the row reverts to the
 * default. Process-wide (not per-instance). Every edit is audited.
 */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const promptOverrides = pgTable('prompt_overrides', {
  key: text('key').primaryKey(),
  content: text('content').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type PromptOverride = typeof promptOverrides.$inferSelect;
export type NewPromptOverride = typeof promptOverrides.$inferInsert;
