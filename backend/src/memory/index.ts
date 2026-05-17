/**
 * Memory facade (Mem0-shape) — F16 M6.T6.
 *
 * Two responsibilities:
 *   1. RECORD — embed a fact and persist it to `customer_facts` (M2.T3 table,
 *      HNSW + cosine on the `embedding` column).
 *   2. RECALL — embed a query, run kNN bounded to a single customer, return
 *      the top-N facts so the Sales Agent can splice them into its prompt
 *      context (`SalesAgentTurnContext.recalledFacts`).
 *
 * Why a facade and not direct repo calls everywhere:
 *   M16 may swap the local pgvector store for Mem0 SaaS. The signatures
 *   below are the seam — callers (`sales-agent/agent.ts`, the
 *   `customer.remember_fact` tool) speak only this module. The current
 *   implementation is "pgvector + OpenRouter embeddings"; M16 can drop in a
 *   Mem0 HTTP client behind the same names.
 *
 * Why raw SQL for the kNN read path:
 *   drizzle-orm renders array bindings as `int4[]` literals, which the
 *   pgvector `<=>` operator does NOT accept — it wants the `[a,b,c]::vector`
 *   shape. `searchSimilar` in `db/repositories/knowledge.ts` already solved
 *   this by building the literal string-side; we follow the same recipe.
 *
 * Failure handling:
 *   `recordCustomerFact` / `recordFactsBatch` bubble embedding-API errors
 *   verbatim — the caller (typically the `customer.remember_fact` tool)
 *   decides whether to surface the failure to the model.
 *
 *   `recallCustomerFacts` does NOT swallow errors either — but the Sales
 *   Agent wraps it in try/catch and degrades to "no recalled facts" so a
 *   transient embeddings outage never blocks a customer reply.
 */
import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { customerFacts } from '../db/schema/index.js';
import { getDefaultEmbeddingClient, type EmbeddingClient } from '../llm/embeddings.js';

/** Fact taxonomy mirrors the `fact_type` pg enum (see schema/_enums.ts). */
export type FactType = 'observation' | 'preference' | 'objection' | 'event';

export interface RecordFactInput {
  customerId: string;
  factType: FactType;
  content: string;
  /** 0..1; default 0.5 when omitted. Calibration is the caller's job. */
  confidence?: number;
  /** Free-form agent identifier, e.g. `sales-agent#abc123`. Optional. */
  recordedBy?: string;
}

export interface RecordedFact {
  id: string;
  customerId: string;
  factType: FactType;
  content: string;
  /** Always populated as a number, even though the column is nullable. */
  confidence: number;
  recordedBy: string | null;
  recordedAt: Date;
}

export interface RecallOptions {
  /** Top-N. Default 5. */
  limit?: number;
  /** Filter out facts with confidence below this (inclusive). Default 0. */
  minConfidence?: number;
  /** Optional client override (mainly for tests; production uses the default). */
  embeddingClient?: EmbeddingClient;
}

export interface RecalledFact extends RecordedFact {
  /** Cosine distance (0 = identical, 2 = opposite). */
  distance: number;
}

/**
 * Embed and persist a single fact. Returns the inserted row's RecordedFact
 * projection. Embedding failures throw — the caller decides recovery.
 */
export async function recordCustomerFact(
  db: Database,
  input: RecordFactInput,
  embeddingClient?: EmbeddingClient,
): Promise<RecordedFact> {
  const ec = embeddingClient ?? getDefaultEmbeddingClient();
  const embedding = await ec.embed(input.content);
  const [row] = await db
    .insert(customerFacts)
    .values({
      customerId: input.customerId,
      factType: input.factType,
      content: input.content,
      confidence: input.confidence ?? 0.5,
      recordedBy: input.recordedBy ?? null,
      embedding,
    })
    .returning();
  if (!row) throw new Error('recordCustomerFact: insert returned no row');
  return rowToFact(row);
}

/**
 * Bulk-record facts for one customer. Uses a single embeddings API call so
 * three facts cost one round-trip rather than three.
 */
export async function recordFactsBatch(
  db: Database,
  customerId: string,
  facts: Array<Omit<RecordFactInput, 'customerId'>>,
  embeddingClient?: EmbeddingClient,
): Promise<RecordedFact[]> {
  if (facts.length === 0) return [];
  const ec = embeddingClient ?? getDefaultEmbeddingClient();
  const embeddings = await ec.embedBatch(facts.map((f) => f.content));
  const rows = await db
    .insert(customerFacts)
    .values(
      facts.map((f, i) => ({
        customerId,
        factType: f.factType,
        content: f.content,
        confidence: f.confidence ?? 0.5,
        recordedBy: f.recordedBy ?? null,
        embedding: embeddings[i],
      })),
    )
    .returning();
  return rows.map(rowToFact);
}

/**
 * kNN over `customer_facts.embedding` bounded to one customer. Returns the
 * top-N most-similar facts ordered nearest-first.
 *
 * The query embedding is built once per call. We hand the vector to pg as a
 * `[a,b,c]::vector` literal so the cosine operator (`<=>`) parses it
 * correctly — drizzle's array bindings render as `int4[]` which pgvector
 * rejects (same trick as `searchSimilar` in repositories/knowledge.ts).
 */
export async function recallCustomerFacts(
  db: Database,
  customerId: string,
  query: string,
  opts: RecallOptions = {},
): Promise<RecalledFact[]> {
  const ec = opts.embeddingClient ?? getDefaultEmbeddingClient();
  const queryVec = await ec.embed(query);
  const limit = opts.limit ?? 5;
  const minConfidence = opts.minConfidence ?? 0;
  const literal = `[${queryVec.join(',')}]`;

  const rows = (await db.execute(sql`
    SELECT
      id,
      customer_id   AS "customerId",
      fact_type     AS "factType",
      content,
      confidence,
      recorded_by   AS "recordedBy",
      recorded_at   AS "recordedAt",
      embedding <=> ${literal}::vector AS distance
    FROM customer_facts
    WHERE customer_id = ${customerId}
      AND COALESCE(confidence, 0) >= ${minConfidence}
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${limit}
  `)) as unknown as Array<{
    id: string;
    customerId: string;
    factType: FactType;
    content: string;
    confidence: number | string | null;
    recordedBy: string | null;
    recordedAt: Date | string;
    distance: number | string;
  }>;

  return rows.map((r) => ({
    ...rowToFact(r),
    distance: typeof r.distance === 'string' ? parseFloat(r.distance) : r.distance,
  }));
}

/**
 * Most-recent N facts for a customer — no semantic search, just
 * `ORDER BY recorded_at DESC`. Useful for admin views and tests that want a
 * deterministic listing without going through the embeddings API.
 */
export async function listRecentFacts(
  db: Database,
  customerId: string,
  limit = 10,
): Promise<RecordedFact[]> {
  const rows = await db
    .select()
    .from(customerFacts)
    .where(eq(customerFacts.customerId, customerId))
    .orderBy(desc(customerFacts.recordedAt))
    .limit(limit);
  return rows.map(rowToFact);
}

/** Normalize a row (drizzle-shape OR raw-SQL-shape) into RecordedFact. */
function rowToFact(row: {
  id: string;
  customerId: string;
  factType: FactType | string;
  content: string;
  confidence: number | string | null;
  recordedBy: string | null;
  recordedAt: Date | string;
}): RecordedFact {
  const conf = row.confidence;
  return {
    id: row.id,
    customerId: row.customerId,
    factType: row.factType as FactType,
    content: row.content,
    confidence:
      conf === null || conf === undefined ? 0 : typeof conf === 'string' ? parseFloat(conf) : conf,
    recordedBy: row.recordedBy ?? null,
    recordedAt: row.recordedAt instanceof Date ? row.recordedAt : new Date(row.recordedAt),
  };
}
