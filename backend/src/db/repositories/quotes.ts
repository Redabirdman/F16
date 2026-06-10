/**
 * Quotes repository — thin CRUD for the Maxance quote session lifecycle.
 *
 * No PII encryption: a quote carries product + price + a Maxance reference
 * number, none of which is PII. Customer linkage is by FK only; PII reads
 * still go through `repositories/customers.ts`.
 *
 * Concurrency note on `appendMaxanceAction`:
 *   `step_index` is a 0-based monotonic counter per `quote_id`. We compute
 *   the next value atomically inside the INSERT using a single
 *   `INSERT ... SELECT COALESCE(MAX(step_index), -1) + 1 FROM maxance_actions
 *   WHERE quote_id = $1` statement. Two concurrent appenders can still race
 *   and produce the same value (each sees the other's pre-insert MAX); the
 *   UNIQUE index on `(quote_id, step_index)` is the hard backstop — the
 *   loser sees a unique-violation and the caller (Operator) retries. In V1
 *   the BrowserPool serializes per-quote already, so the retry path is a
 *   defence-in-depth rather than a hot loop. Choosing the cheap single
 *   statement over a SERIALIZABLE transaction keeps the common path one
 *   round-trip.
 */
import { eq, asc, desc } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import { quotes, maxanceActions } from '../schema/index.js';
import type { Quote, MaxanceAction } from '../schema/quotes.js';
import { emitHubSpotSync } from './leads.js';

/** Input for `insertQuote` — only the fields a freshly-requested quote needs. */
export interface InsertQuoteInput {
  customerId: string;
  leadId?: string | null;
  product: 'scooter' | 'car';
  productVariant: string;
  sessionId: string;
  rawFormData?: Record<string, unknown> | null;
}

/** Insert a new quote in status='requested'. */
export async function insertQuote(db: Database, input: InsertQuoteInput): Promise<Quote> {
  const [row] = await db
    .insert(quotes)
    .values({
      customerId: input.customerId,
      leadId: input.leadId ?? null,
      product: input.product,
      productVariant: input.productVariant,
      sessionId: input.sessionId,
      rawFormData: input.rawFormData ?? null,
      // status defaults to 'requested' via the schema default; we rely on it.
    })
    .returning();

  if (!row) throw new Error('insertQuote: insert returned no row');
  return row;
}

/** Payload accepted by `markQuoteReady` — all pricing/output fields. */
export interface MarkQuoteReadyInput {
  /** € as decimal string; numeric(10,2) round-trips as string in postgres-js. */
  monthlyPremium: string;
  /** € as decimal string. */
  comptantDue: string;
  /** Maxance's own reference (e.g. "DR0000971882"). */
  devisNumber: string;
  pdfUrl: string;
  rawResponse: Record<string, unknown>;
}

/** Flip a quote from in_progress/requested to ready and stamp the outputs. */
export async function markQuoteReady(
  db: Database,
  quoteId: string,
  input: MarkQuoteReadyInput,
): Promise<Quote> {
  const [row] = await db
    .update(quotes)
    .set({
      status: 'ready',
      readyAt: new Date(),
      monthlyPremium: input.monthlyPremium,
      comptantDue: input.comptantDue,
      maxanceDevisNumber: input.devisNumber,
      pdfUrl: input.pdfUrl,
      rawResponse: input.rawResponse,
    })
    .where(eq(quotes.id, quoteId))
    .returning();

  if (!row) throw new Error(`markQuoteReady: no quote with id=${quoteId}`);

  // Mirror the updated price + devis number to HubSpot. The reconciler will
  // pick up the new amount / f16_devis_number from the latest quote row.
  // Non-blocking — a HubSpot hiccup must not break the quote flow.
  if (row.leadId) {
    await emitHubSpotSync(db, row.leadId);
  }

  return row;
}

/** Fields known at Maxance confirm time. Premium/comptant are NOT re-surfaced
 *  by Maxance at confirm (they came from the earlier PREVIEW_READY), so this
 *  helper only stamps the devis number + PDF + ready status. */
export interface MarkQuoteConfirmedInput {
  /** Maxance's own reference (e.g. "DR0000971882"). */
  devisNumber: string;
  /** Where Maxance emailed the devis PDF (recorded; not PII-logged). */
  pdfUrl?: string | null;
  rawResponse?: Record<string, unknown> | null;
}

/**
 * Persist the confirm-flow outputs onto the quote row, then mirror to HubSpot.
 *
 * The Maxance confirm path produces a real devis number but does NOT re-surface
 * the premium/comptant (those were captured at PREVIEW_READY). This helper
 * writes the devis number + PDF + ready status and THEN emits the HubSpot sync,
 * guaranteeing the reconciler reads a quote row that already carries
 * `maxanceDevisNumber` — so the deal's f16_devis_number populates with the real
 * value rather than blank. Returns the updated row.
 */
export async function markQuoteConfirmed(
  db: Database,
  quoteId: string,
  input: MarkQuoteConfirmedInput,
): Promise<Quote> {
  const [row] = await db
    .update(quotes)
    .set({
      status: 'ready',
      readyAt: new Date(),
      maxanceDevisNumber: input.devisNumber,
      ...(input.pdfUrl != null ? { pdfUrl: input.pdfUrl } : {}),
      ...(input.rawResponse != null ? { rawResponse: input.rawResponse } : {}),
    })
    .where(eq(quotes.id, quoteId))
    .returning();

  if (!row) throw new Error(`markQuoteConfirmed: no quote with id=${quoteId}`);

  // Emit AFTER the devis number is persisted so the reconciler mirrors the
  // real f16_devis_number, not a blank. Non-blocking — emitHubSpotSync never
  // throws and a HubSpot hiccup must not break the quote flow.
  if (row.leadId) {
    await emitHubSpotSync(db, row.leadId);
  }

  return row;
}

/** Optional fields on a Maxance action append. `actionText` is required. */
export interface AppendMaxanceActionInput {
  actionText: string;
  stepName?: string | null;
  screenshotBeforeUrl?: string | null;
  screenshotAfterUrl?: string | null;
  durationMs?: number | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

/**
 * Atomically appends an action to a quote with the next step_index.
 * Returns the inserted row. See "Concurrency note" at the top of the file.
 */
export async function appendMaxanceAction(
  db: Database,
  quoteId: string,
  sessionId: string,
  input: AppendMaxanceActionInput,
): Promise<MaxanceAction> {
  // Single round-trip: compute next step_index inside the INSERT via a SELECT
  // that scans only this quote's actions (covered by the unique composite
  // index on (quote_id, step_index)).
  const rows = (await db.execute(sql`
    INSERT INTO maxance_actions (
      quote_id,
      session_id,
      action_text,
      step_index,
      step_name,
      screenshot_before_url,
      screenshot_after_url,
      duration_ms,
      result,
      error
    )
    SELECT
      ${quoteId}::uuid,
      ${sessionId},
      ${input.actionText},
      COALESCE(MAX(step_index), -1) + 1,
      ${input.stepName ?? null},
      ${input.screenshotBeforeUrl ?? null},
      ${input.screenshotAfterUrl ?? null},
      ${input.durationMs ?? null},
      ${input.result ? JSON.stringify(input.result) : null}::jsonb,
      ${input.error ?? null}
    FROM maxance_actions
    WHERE quote_id = ${quoteId}::uuid
    RETURNING
      id,
      quote_id    AS "quoteId",
      session_id  AS "sessionId",
      action_text AS "actionText",
      step_index  AS "stepIndex",
      step_name   AS "stepName",
      screenshot_before_url AS "screenshotBeforeUrl",
      screenshot_after_url  AS "screenshotAfterUrl",
      duration_ms AS "durationMs",
      result,
      error,
      occurred_at AS "occurredAt"
  `)) as unknown as MaxanceAction[];

  const inserted = rows[0];
  if (!inserted)
    throw new Error(`appendMaxanceAction: insert returned no row (quoteId=${quoteId})`);
  return inserted;
}

/** Combined view: the quote + all its actions, ordered by step_index ASC. */
export async function getQuoteWithActions(
  db: Database,
  quoteId: string,
): Promise<{ quote: Quote; actions: MaxanceAction[] } | null> {
  const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  if (!quote) return null;

  const actions = await db
    .select()
    .from(maxanceActions)
    .where(eq(maxanceActions.quoteId, quoteId))
    .orderBy(asc(maxanceActions.stepIndex));

  return { quote, actions };
}

/** Newest quote for a lead, or null. Used by the HubSpot mirror for amount + devis number. */
export async function getLatestQuoteForLead(
  db: Database,
  leadId: string,
): Promise<typeof quotes.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(quotes)
    .where(eq(quotes.leadId, leadId))
    .orderBy(desc(quotes.requestedAt))
    .limit(1);
  return row ?? null;
}
