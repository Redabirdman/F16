/**
 * Reporter Agent — choice executors (2026-07-06).
 *
 * Until now, resolving a human action only RECORDED the choice and posted a
 * closure line to the WA group — nothing actually executed it. Ridaa replied
 * "Retry the quote" on a QUOTE_FAILED and the customer kept waiting forever.
 *
 * This module closes that gap with a CHOICE-EXECUTOR REGISTRY: a map of
 * `${actionIntent}:${optionId}` → executor. When HUMAN_ACTION.RESOLVED lands
 * on the reporter, it calls `executeResolutionChoice`; if the resolved
 * (intent, option) pair has an executor, the side effect runs and an English
 * follow-up line for the management group is returned (posted right after the
 * closure message). Unregistered pairs are a silent no-op — approvals that
 * are informational-only keep behaving exactly as before.
 *
 * V1 registrations: QUOTE_FAILED:retry + QUOTE_STUCK:retry → re-launch the
 * Maxance quote. Future executors (e.g. SUBSCRIPTION_FAILED:retry) plug in
 * with one `registerChoiceExecutor` call.
 *
 * Hard rule: NEVER crash the resolution path. The closure message is already
 * posted when we run; a throw here would fail the RESOLVED envelope and make
 * BullMQ replay it (duplicate closure posts + duplicate retries). Every
 * executor error is caught, logged, and turned into a short English group
 * note so Ridaa/Achraf know to act manually.
 *
 * The quote retry mirrors `quote.request` (src/tools/builtins/quote-request.ts):
 *   - NEW quoteId (the failed/stuck row keeps its history; markQuote* and the
 *     operator correlate strictly by payload.quoteId, so reusing the old id
 *     would resurrect a dead row's state).
 *   - Same QUOTE.REQUESTED payload shape, toRole maxance-operator.
 *   - Same business-hours parking: when the Maxance portal is closed (nights
 *     20h-08h Moroccan + weekends) the delivery is DELAYED until reopening.
 *   - Same in-flight/parked idempotency guard (status='requested', no price,
 *     younger than 72h) — but EXCLUDING the action's own quote row: a
 *     QUOTE_STUCK quote is itself still sitting in 'requested', and without
 *     the exclusion every stuck-quote retry would self-block.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { customers, quotes } from '../../db/schema/index.js';
import type { HumanAction } from '../../db/schema/agent-runtime.js';
import { decryptPII } from '../../db/crypto.js';
import { insertQuote } from '../../db/repositories/quotes.js';
import { setLeadStatus } from '../../db/repositories/leads.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { msUntilMaxanceOpen } from '../maxance-operator/business-hours.js';
import { shortRef } from './humanize.js';
import { logger } from '../../logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ChoiceExecutorContext {
  db: Database;
  /** The resolved human_actions row (re-loaded by the reporter). */
  action: HumanAction;
  /** The chosen option's id (resolution payload `choice`). */
  chosenOptionId: string;
  /** Reporter role/instance — stamped as the QUOTE.REQUESTED sender. */
  fromRole: string;
  fromInstance: string;
}

export interface ChoiceExecutorResult {
  /**
   * English one-liner for the management WA group, posted after the closure
   * message. Null = the executor ran but has nothing worth saying.
   */
  groupNote: string | null;
  /** Diagnostic detail merged into the onMessage result envelope. */
  detail?: Record<string, unknown>;
}

export type ChoiceExecutor = (ctx: ChoiceExecutorContext) => Promise<ChoiceExecutorResult>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, ChoiceExecutor>();

function key(intent: string, optionId: string): string {
  return `${intent}:${optionId}`;
}

/** Plug in an executor for one (action intent, option id) pair. */
export function registerChoiceExecutor(
  intent: string,
  optionId: string,
  executor: ChoiceExecutor,
): void {
  registry.set(key(intent, optionId), executor);
}

/** Exposed for tests/diagnostics — is anything registered for this pair? */
export function hasChoiceExecutor(intent: string, optionId: string): boolean {
  return registry.has(key(intent, optionId));
}

/**
 * Run the executor registered for the resolved (intent, option) pair, if any.
 * Returns null when nothing is registered (the overwhelmingly common case).
 * NEVER throws — see the module header for why.
 */
export async function executeResolutionChoice(
  ctx: ChoiceExecutorContext,
): Promise<ChoiceExecutorResult | null> {
  const executor = registry.get(key(ctx.action.intent, ctx.chosenOptionId));
  if (!executor) return null;
  try {
    return await executor(ctx);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        humanActionId: ctx.action.id,
        intent: ctx.action.intent,
        choice: ctx.chosenOptionId,
      },
      'choice-executors: executor threw — resolution path continues',
    );
    return {
      groupNote: 'Automatic follow-through hit an error — please handle it from the admin.',
      detail: { executorError: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// Quote retry executor (QUOTE_FAILED:retry + QUOTE_STUCK:retry)
// ---------------------------------------------------------------------------

const NO_DATA_NOTE = 'Could not retry automatically — no stored form data; run it from the admin.';

/** First name for the group note, best-effort. Falls back to 'this customer'. */
async function customerFirstName(db: Database, customerId: string): Promise<string> {
  try {
    const [cust] = await db
      .select({ fullName: customers.fullName })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    if (!cust) return 'this customer';
    const full = decryptPII(cust.fullName) ?? '';
    const first = (full.split(' ')[0] ?? '').trim();
    return first || 'this customer';
  } catch {
    // PII key unavailable / row gone — the note degrades, the retry doesn't.
    return 'this customer';
  }
}

const retryQuote: ChoiceExecutor = async (ctx) => {
  const { db, action } = ctx;

  // 1. The action's correlationId IS the failed/stuck quote id (both creation
  //    sites: sales-agent handlers/quote.ts + followthrough/watchdog.ts).
  const quoteId = action.correlationId;
  const original =
    quoteId && UUID_RE.test(quoteId)
      ? (await db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1))[0]
      : undefined;

  const formData = (original?.rawFormData ?? null) as Record<string, unknown> | null;
  if (!original || !original.leadId || !formData || Object.keys(formData).length === 0) {
    logger.warn(
      {
        humanActionId: action.id,
        intent: action.intent,
        correlationId: quoteId,
        quoteFound: Boolean(original),
        hasLeadId: Boolean(original?.leadId),
        hasFormData: Boolean(formData && Object.keys(formData).length > 0),
      },
      'choice-executors: quote retry impossible — quote/lead/formData missing',
    );
    return { groupNote: NO_DATA_NOTE, detail: { retried: false, reason: 'no_stored_form_data' } };
  }

  // 2. Idempotency — same shape as quote.request's in-flight/parked guards
  //    (72h covers both the 3-min live-flow window and a weekend-parked job),
  //    minus the action's own row: a QUOTE_STUCK quote is still 'requested'
  //    itself and must not block its own retry.
  const seventyTwoHAgo = new Date(Date.now() - 72 * 3_600_000);
  const [inFlight] = await db
    .select({ id: quotes.id })
    .from(quotes)
    .where(
      and(
        eq(quotes.leadId, original.leadId),
        eq(quotes.status, 'requested'),
        // No price yet = the Maxance flow is still pending for that row.
        isNull(quotes.monthlyPremium),
        gt(quotes.requestedAt, seventyTwoHAgo),
        ne(quotes.id, original.id),
      ),
    )
    .orderBy(desc(quotes.requestedAt))
    .limit(1);
  if (inFlight) {
    logger.info(
      { humanActionId: action.id, originalQuoteId: original.id, inFlightQuoteId: inFlight.id },
      'choice-executors: quote retry skipped — another quote already in flight for this lead',
    );
    return {
      groupNote: 'A retry is already running for this customer.',
      detail: { retried: false, reason: 'retry_in_flight', inFlightQuoteId: inFlight.id },
    };
  }

  // 3. Re-launch — mirror of quote.request: fresh quoteId, canonical quotes
  //    row FIRST, then QUOTE.REQUESTED to the maxance-operator with the
  //    original run's exact formData + the business-hours parking.
  const newQuoteId = randomUUID();
  const payload = {
    quoteId: newQuoteId,
    customerId: original.customerId,
    leadId: original.leadId,
    product: original.product,
    productVariant: original.productVariant,
    formData,
  };
  await insertQuote(db, {
    id: newQuoteId,
    customerId: original.customerId,
    leadId: original.leadId,
    product: original.product,
    productVariant: original.productVariant,
    sessionId: randomUUID(),
    rawFormData: formData,
  });

  const closedDelayMs = msUntilMaxanceOpen();
  await sendMessage(
    { db },
    {
      fromRole: ctx.fromRole,
      fromInstance: ctx.fromInstance,
      toRole: 'maxance-operator',
      toInstance: 'singleton',
      intent: 'QUOTE.REQUESTED',
      payload,
      ...(closedDelayMs > 0 ? { delayMs: closedDelayMs } : {}),
    },
  );
  if (closedDelayMs > 0) {
    logger.info(
      { quoteId: newQuoteId, delayMs: closedDelayMs },
      'choice-executors: portal closed — retry QUOTE.REQUESTED parked until reopening',
    );
  }

  // 4. Lifecycle, best-effort (same contract as quote.request step 4).
  try {
    await setLeadStatus(db, original.leadId, 'quoting');
  } catch (err) {
    logger.warn(
      { leadId: original.leadId, err: err instanceof Error ? err.message : String(err) },
      'choice-executors: setLeadStatus(quoting) failed (non-fatal)',
    );
  }

  const who = await customerFirstName(db, original.customerId);
  const parked = closedDelayMs > 0 ? ' (portal closed — it will run at reopening)' : '';
  logger.info(
    {
      humanActionId: action.id,
      originalQuoteId: original.id,
      newQuoteId,
      parked: closedDelayMs > 0,
    },
    'choice-executors: quote retry launched',
  );
  return {
    groupNote: `Retrying the quote for ${who} — new ref ${shortRef(newQuoteId)}.${parked}`,
    detail: { retried: true, newQuoteId, parked: closedDelayMs > 0 },
  };
};

registerChoiceExecutor('QUOTE_FAILED', 'retry', retryQuote);
registerChoiceExecutor('QUOTE_STUCK', 'retry', retryQuote);
