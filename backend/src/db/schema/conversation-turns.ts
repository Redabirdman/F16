/**
 * `conversation_turns` — every inbound + outbound message across all channels
 * (design §7.1 + §8). One row per message; voice transcripts land as turns
 * the same as WhatsApp text.
 *
 * `content` is intentionally NOT encrypted in V1:
 *   - the LLM agent loop reads this on every turn; column-level decrypt on
 *     every read would dominate latency,
 *   - the design positions these rows as "proof of conversation" surfaced
 *     to humans in the admin UI,
 *   - revisit in M16 with envelope encryption + a per-conversation DEK if
 *     compliance review demands it.
 *
 * `lead_id` is nullable because conversation turns can predate the lead
 * (e.g. a returning customer pings WhatsApp before a lead row exists yet).
 *
 * Cascade behavior: deleting a customer wipes their turns (GDPR erasure).
 * Deleting a lead nulls the lead_id but keeps the turns attached to the
 * customer — the conversation history is customer-scoped, not lead-scoped.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, timestamp, vector, index } from 'drizzle-orm/pg-core';
import { channelEnum, directionEnum } from './_enums.js';
import { customers } from './customers.js';
import { leads } from './leads.js';

export const conversationTurns = pgTable(
  'conversation_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .references(() => customers.id, { onDelete: 'cascade' })
      .notNull(),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    channel: channelEnum('channel').notNull(),
    direction: directionEnum('direction').notNull(),
    agentRole: text('agent_role'), // null for inbound human messages
    agentInstance: text('agent_instance'),
    content: text('content').notNull(),
    // Attachments: [{ url, type, size, sha256 }, ...]
    attachments:
      jsonb('attachments').$type<
        Array<{ url: string; type: string; size?: number; sha256?: string }>
      >(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
  },
  (t) => [
    // Per-customer timeline.
    index('conversation_turns_customer_id_idx').on(t.customerId),
    // Per-lead conversation log (when scoped).
    index('conversation_turns_lead_id_idx').on(t.leadId),
    // Default ordering: most recent turn first.
    index('conversation_turns_occurred_at_idx').on(sql`${t.occurredAt} DESC`),
    // Channel filter (e.g. "show me voice transcripts only").
    index('conversation_turns_channel_idx').on(t.channel),
    // Semantic recall across turns (Mem0 path).
    index('conversation_turns_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export type ConversationTurn = typeof conversationTurns.$inferSelect;
export type NewConversationTurn = typeof conversationTurns.$inferInsert;
