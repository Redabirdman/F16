/**
 * `creative_learnings` (M12 P3 — intelligence).
 *
 * Durable, reusable brand/creative guidance the system DISTILS from Ridaa's
 * free-form feedback (via an LLM) and injects into every future creative
 * prompt — so a correction like "we insure stand-up electric kick-scooters,
 * never seated ones" becomes a permanent constraint, not a one-off note.
 *
 * `angle` null → global (applies to all creatives); else scoped to that angle.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

export const creativeLearnings = pgTable(
  'creative_learnings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Null = global guidance; otherwise the angle key (e.g. 'speed').
    angle: text('angle'),
    // The distilled, reusable instruction injected into prompts.
    guidance: text('guidance').notNull(),
    // The raw human feedback this was learned from (audit/provenance).
    sourceFeedback: text('source_feedback'),
    createdByAgent: text('created_by_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('creative_learnings_angle_idx').on(t.angle),
    index('creative_learnings_created_at_idx').on(sql`${t.createdAt} DESC`),
  ],
);

export type CreativeLearning = typeof creativeLearnings.$inferSelect;
export type NewCreativeLearning = typeof creativeLearnings.$inferInsert;
