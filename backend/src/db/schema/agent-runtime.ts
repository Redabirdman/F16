/**
 * Agent runtime + memory + admin surface schema (design §6.2 + §7.2 + §13 + §14).
 *
 * Five tables that together form the agent operating system:
 *
 *   agent_messages    — the inter-agent bus. Every cross-role intent
 *                       (QUOTE.REQUESTED, LEAD.SCORED, …) lands here as a
 *                       row, picked up by the addressed role's worker via
 *                       claimNext() (SKIP LOCKED). NOTIFY trigger fans out
 *                       inserts to the realtime channel.
 *
 *   agent_patterns    — learned heuristics ("if user says X, try Y"). Each
 *                       role accumulates a corpus of openers, objection
 *                       handlers, and recovery patterns. Embedded for kNN
 *                       recall at prompt-build time.
 *
 *   human_actions     — the human-in-the-loop queue. When an agent needs
 *                       approval (refund > €X, ambiguous lead, off-script
 *                       request), it creates a row here. The admin UI +
 *                       WhatsApp escalation channel both subscribe.
 *
 *   audit_log         — append-only ledger of every state-changing action
 *                       taken by an agent, human, or system process.
 *                       Compliance + forensic surface.
 *
 *   knowledge_chunks  — RAG corpus (website pages, product catalogs, ops
 *                       runbooks). Content-addressed (sha256 UNIQUE) so
 *                       re-ingestion is idempotent. HNSW-indexed for kNN.
 *
 * Realtime fan-out:
 *   The 0004_realtime_triggers migration installs LISTEN/NOTIFY triggers on
 *   agent_messages (insert) and human_actions (insert + status update).
 *   Drizzle does not model triggers; the SQL is hand-written.
 *
 * Enum vs text choice:
 *   `intent`, `pattern_type`, `actor_type`, `action`, `source` are all kept
 *   as `text` columns — they are open-ended namespaces (e.g. new intents
 *   appear with every M3+ agent). zod at the boundary handles strict typing
 *   where needed; the DB stays additive.
 *
 * Cascade rules:
 *   None of these tables has FKs to anything else — they reference business
 *   entities by free-text `correlation_id` only. Rationale: a customer can
 *   be GDPR-erased without nuking the audit_log or agent_messages history
 *   that referenced them (the correlation_id becomes a dangling pointer,
 *   which is correct — proof-of-action survives erasure of subject data).
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  boolean,
  real,
  jsonb,
  timestamp,
  vector,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// agent_messages — inter-agent bus (design §6.2)
// ---------------------------------------------------------------------------

export const agentMessages = pgTable(
  'agent_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    fromRole: text('from_role').notNull(),
    fromInstance: text('from_instance'),

    toRole: text('to_role').notNull(),
    // null = any instance of toRole can pick it up.
    toInstance: text('to_instance'),

    // Open-ended namespace, e.g. 'QUOTE.REQUESTED', 'LEAD.SCORED'. zod at
    // the boundary keeps known intents typed; the DB stays additive.
    intent: text('intent').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    // Free-form correlation key — lead_id, campaign_id, customer_id, …
    correlationId: text('correlation_id'),

    requiresHuman: boolean('requires_human').notNull().default(false),
    // 0 = critical, 9 = background. claimNext orders by priority ASC then
    // created_at ASC so high-priority oldest pending wins.
    priority: smallint('priority').notNull().default(5),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),

    // Claim lifecycle — set atomically by claimNext() under FOR UPDATE
    // SKIP LOCKED.
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedBy: text('consumed_by'),

    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
  },
  (t) => [
    // Hot path: "what's pending for me?" — partial index on the open
    // queue only (consumedAt IS NULL). Keeps the index tiny even as
    // consumed rows accumulate in the millions.
    index('agent_messages_pending_by_role_idx')
      .on(t.toRole, t.consumedAt)
      .where(sql`${t.consumedAt} IS NULL`),
    // Correlation lookup — "all messages for lead X".
    index('agent_messages_correlation_idx').on(t.correlationId),
    // Admin timeline default order — newest first.
    index('agent_messages_created_at_idx').on(sql`${t.createdAt} DESC`),
  ],
);

// ---------------------------------------------------------------------------
// agent_patterns — learned heuristics (design §7.2)
// ---------------------------------------------------------------------------

export const agentPatterns = pgTable(
  'agent_patterns',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    agentRole: text('agent_role').notNull(),
    // Free-form: 'heuristic' | 'objection-handler' | 'opener' | …
    // M3+ agents can introduce new types without a migration.
    patternType: text('pattern_type').notNull(),

    triggerSummary: text('trigger_summary').notNull(),
    recommendedAction: text('recommended_action').notNull(),

    evidenceCount: integer('evidence_count').notNull().default(0),
    // 0..1 — null until first win/loss is recorded.
    winRate: real('win_rate'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),

    // 1536-dim embedding of triggerSummary — recalled via kNN at
    // prompt-build time. HNSW with cosine ops to match the conventions
    // used by conversation_turns + customer_facts.
    embedding: vector('embedding', { dimensions: 1536 }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('agent_patterns_agent_role_idx').on(t.agentRole),
    index('agent_patterns_last_used_at_idx').on(sql`${t.lastUsedAt} DESC`),
    index('agent_patterns_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

// ---------------------------------------------------------------------------
// human_actions — human-in-the-loop queue (design §13)
// ---------------------------------------------------------------------------

/** Shape of an option offered to the human resolver. */
export interface HumanActionOption {
  id: string;
  label: string;
  kind: 'approve' | 'reject' | 'revise' | 'callback' | 'custom';
}

/** Shape of the chosen resolution. */
export interface HumanActionResolution {
  chosenOptionId: string;
  notes?: string;
  by: string;
  source: 'admin' | 'whatsapp';
}

export const humanActions = pgTable(
  'human_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    createdByAgent: text('created_by_agent').notNull(),
    correlationId: text('correlation_id'),

    // Short machine name, e.g. 'APPROVE_CREATIVE', 'CONFIRM_REFUND'.
    intent: text('intent').notNull(),

    // Per design §13.3: 1 = critical (red), 2 = standard (yellow), 3 = info (green).
    severity: smallint('severity').notNull(),

    // Human-readable French summary surfaced in admin UI + WhatsApp.
    summary: text('summary').notNull(),

    options: jsonb('options').$type<HumanActionOption[]>().notNull(),

    // 'pending' | 'resolved' | 'cancelled' | 'expired' — kept as text so
    // operational lifecycle additions (e.g. 'snoozed') don't need a
    // migration.
    status: text('status').notNull().default('pending'),

    resolution: jsonb('resolution').$type<HumanActionResolution>(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    // 'admin' | 'whatsapp'.
    resolvedSource: text('resolved_source'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // SLA deadline — the escalator worker bumps unresolved items past dueAt.
    dueAt: timestamp('due_at', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  },
  (t) => [
    // Inbox query default — pending first.
    index('human_actions_status_idx').on(t.status),
    // Sort by severity (1 first = most critical).
    index('human_actions_severity_idx').on(sql`${t.severity} DESC`),
    index('human_actions_due_at_idx').on(t.dueAt),
    index('human_actions_correlation_idx').on(t.correlationId),
    index('human_actions_created_at_idx').on(sql`${t.createdAt} DESC`),
  ],
);

// ---------------------------------------------------------------------------
// audit_log — append-only ledger (design §14)
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // 'agent' | 'human' | 'system'.
    actorType: text('actor_type').notNull(),
    // Agent role+instance, human user id, or 'system'.
    actorId: text('actor_id').notNull(),

    // Free-form action namespace, e.g. 'agent.prompt.update',
    // 'integration.toggle', 'human.action.resolve', 'config.change'.
    action: text('action').notNull(),

    targetType: text('target_type'),
    targetId: text('target_id'),

    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    meta: jsonb('meta').$type<Record<string, unknown>>(),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('audit_log_actor_id_idx').on(t.actorId),
    index('audit_log_action_idx').on(t.action),
    // "all events about target X" — composite covers both target_type and
    // target_type+target_id lookups.
    index('audit_log_target_idx').on(t.targetType, t.targetId),
    // Forensics default order — newest first.
    index('audit_log_occurred_at_idx').on(sql`${t.occurredAt} DESC`),
  ],
);

// ---------------------------------------------------------------------------
// knowledge_chunks — RAG corpus (design §14)
// ---------------------------------------------------------------------------

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Free-form, e.g. 'assuryalconseil.fr' | 'maxance.product-catalog' | 'manual'.
    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    // Logical path within the source, e.g. '/pricing.html'.
    sourcePath: text('source_path'),

    chunkText: text('chunk_text').notNull(),
    // Content-addressed dedup key — re-ingestion is idempotent.
    chunkSha256: text('chunk_sha256').notNull(),

    tokenCount: integer('token_count'),

    embedding: vector('embedding', { dimensions: 1536 }).notNull(),

    // e.g. { pageTitle, lastModified, lang }.
    meta: jsonb('meta').$type<Record<string, unknown>>(),

    ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('knowledge_chunks_source_idx').on(t.source),
    uniqueIndex('knowledge_chunks_chunk_sha256_uniq').on(t.chunkSha256),
    // kNN over the full corpus.
    index('knowledge_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    // "all chunks from page X" — used during re-ingest diffs.
    index('knowledge_chunks_source_path_idx').on(t.source, t.sourcePath),
  ],
);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type AgentMessage = typeof agentMessages.$inferSelect;
export type NewAgentMessage = typeof agentMessages.$inferInsert;
export type AgentPattern = typeof agentPatterns.$inferSelect;
export type NewAgentPattern = typeof agentPatterns.$inferInsert;
export type HumanAction = typeof humanActions.$inferSelect;
export type NewHumanAction = typeof humanActions.$inferInsert;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;
export type NewKnowledgeChunk = typeof knowledgeChunks.$inferInsert;
