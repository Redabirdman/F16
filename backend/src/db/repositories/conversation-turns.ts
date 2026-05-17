/**
 * `conversation_turns` repository (design §7.1, §8 / M4.T7).
 *
 * Single insert path for both inbound (WAHA webhook -> `direction='inbound'`)
 * and outbound (`sendViaChannel` wrapper -> `direction='outbound'`) message
 * audit. This is the only place application code writes to the table; agents
 * and adapters never compose Drizzle inserts themselves so the row shape
 * stays consistent across channels.
 *
 * Read side exposes `listTurns` for the admin timeline view (M14); the filter
 * surface is small on purpose — adding new filters here is cheaper than
 * letting callers compose ad-hoc Drizzle queries.
 *
 * `content` is stored in cleartext (see schema header comment for the
 * rationale). `embedding` is left null in V1; M7 will backfill via an async
 * worker that reads recent rows and writes the vector column.
 */
import { desc, eq, and } from 'drizzle-orm';
import type { Database } from '../index.js';
import { conversationTurns } from '../schema/index.js';
import type { ChannelId } from '../../channels/types.js';

/** Plaintext input shape — exactly what callers hand in. */
export interface InsertTurnInput {
  customerId: string;
  leadId?: string | null;
  channel: ChannelId;
  direction: 'inbound' | 'outbound';
  /** Inbound rows have no agent attribution; outbound rows fill these. */
  agentRole?: string | null;
  agentInstance?: string | null;
  content: string;
  /** Per-channel attachment metadata (URL + type + optional size/sha256). */
  attachments?: Array<{ url: string; type: string; size?: number; sha256?: string }>;
  /** Defaults to `new Date()` when omitted. */
  occurredAt?: Date;
  /** Optional pgvector embedding — M7 wires real values; null in V1. */
  embedding?: number[];
}

/** Output shape returned by the repo. Mirrors the Drizzle row plus a typed channel. */
export interface ConversationTurn {
  id: string;
  customerId: string;
  leadId: string | null;
  channel: ChannelId;
  direction: 'inbound' | 'outbound';
  agentRole: string | null;
  agentInstance: string | null;
  content: string;
  attachments: Array<{ url: string; type: string; size?: number; sha256?: string }> | null;
  occurredAt: Date;
}

/**
 * Insert a single conversation turn. Throws if the insert returns no row
 * (would only happen on a driver-level failure — the schema guarantees the
 * row is produced on success).
 */
export async function insertTurn(db: Database, input: InsertTurnInput): Promise<ConversationTurn> {
  const [row] = await db
    .insert(conversationTurns)
    .values({
      customerId: input.customerId,
      leadId: input.leadId ?? null,
      channel: input.channel,
      direction: input.direction,
      agentRole: input.agentRole ?? null,
      agentInstance: input.agentInstance ?? null,
      content: input.content,
      attachments: input.attachments ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      embedding: input.embedding ?? null,
    })
    .returning();
  if (!row) throw new Error('insertTurn: conversation_turns insert returned no row');
  return rowToTurn(row);
}

/**
 * List turns, most recent first. Filters compose with AND; pass none to get
 * the global tail (used by the admin /timeline panel before scoping).
 *
 * Default limit is 100 — enough for a customer's full chat history in
 * practice, small enough to keep the response payload bounded.
 */
export async function listTurns(
  db: Database,
  opts: {
    customerId?: string;
    leadId?: string;
    channel?: ChannelId;
    limit?: number;
  } = {},
): Promise<ConversationTurn[]> {
  const conditions = [];
  if (opts.customerId) conditions.push(eq(conversationTurns.customerId, opts.customerId));
  if (opts.leadId) conditions.push(eq(conversationTurns.leadId, opts.leadId));
  if (opts.channel) conditions.push(eq(conversationTurns.channel, opts.channel));

  const rows = await db
    .select()
    .from(conversationTurns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(conversationTurns.occurredAt))
    .limit(opts.limit ?? 100);

  return rows.map(rowToTurn);
}

/** Map a Drizzle row to the repo's plaintext output shape. */
function rowToTurn(row: typeof conversationTurns.$inferSelect): ConversationTurn {
  return {
    id: row.id,
    customerId: row.customerId,
    leadId: row.leadId,
    channel: row.channel,
    direction: row.direction,
    agentRole: row.agentRole,
    agentInstance: row.agentInstance,
    content: row.content,
    attachments: row.attachments ?? null,
    occurredAt: row.occurredAt,
  };
}
