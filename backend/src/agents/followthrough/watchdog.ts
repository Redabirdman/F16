/**
 * Proactive pending-action follow-through watchdog.
 *
 * Agents only wake on inbound messages or dispatched intents — when a quote
 * flow dies mid-way (process kill, lost envelope, dead Maxance inbox relay)
 * the customer was told "je prépare votre devis" and then hears NOTHING
 * forever. This deterministic scheduler detects the two real stuck states
 * and follows through:
 *
 *   CHECK A — preview never arrived: quote stuck in 'requested' with no
 *   price after `previewStuckMin`. Escalate once (QUOTE_STUCK human action,
 *   WA-group notified) + ONE apologetic line to the customer. The action
 *   row IS the idempotency guard — a later tick sees it and skips.
 *
 *   CHECK B — devis confirmed but never delivered: quote 'ready' with a
 *   devis number but no `Réf. <DR>` outbound turn after `deliveryStuckMin`.
 *   PDF on disk → re-emit DEVIS.PDF_RECEIVED (the sales-agent handler is
 *   idempotent via the Réf-marker scan), self-healing a lost relay dispatch.
 *   PDF missing → the Maxance→contact@ relay itself is stuck; escalate
 *   (DEVIS_RELAY_STUCK). A re-emit may repeat next tick while delivery keeps
 *   failing silently — acceptable: the handler dedups, and a hard delivery
 *   failure creates DEVIS_DELIVERY_FAILED/PARTIAL which then stops us.
 *
 * Modeled on the engagement scheduler (setInterval, first tick immediate,
 * per-tick summary log). Ticks are serialized through a promise chain so the
 * boot tick and a test's `tickOnce()` can never race the idempotency guards.
 * 48h lookback floor: older rows predate the watchdog or were already
 * handled by a human — don't resurrect ancient escalations.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import { customers, humanActions, quotes } from '../../db/schema/index.js';
import { decryptPII } from '../../db/crypto.js';
import { listTurns } from '../../db/repositories/conversation-turns.js';
import { createAction } from '../../db/repositories/human-actions.js';
import { notifyHumanAction } from '../human-notify.js';
import { isMaxanceOpen, msUntilMaxanceOpen } from '../maxance-operator/business-hours.js';
import { sendViaChannel } from '../../channels/send.js';
import { preferInboundChannel } from '../../channels/registry.js';
import type { ChannelId, ContactRef } from '../../channels/types.js';
import { sendMessage } from '../../messaging/dispatcher.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_PREVIEW_STUCK_MIN = 8;
const DEFAULT_DELIVERY_STUCK_MIN = 15;
/** Only look back this far — older rows are not this watchdog's business. */
const LOOKBACK_MS = 48 * 3_600_000;
/** Per-check row cap — a backlog burst must not turn a tick into a stampede. */
const BATCH_LIMIT = 50;
/** Turn-scan window (matches the sales-agent's own Réf-marker scan). */
const TURN_SCAN_LIMIT = 50;

const ROLE = 'followthrough-watchdog';
const INSTANCE = 'singleton';

const APOLOGY_TEXT =
  'Le calcul de votre devis prend un peu plus de temps que prévu — nous ' +
  'revenons vers vous très rapidement. Merci de votre patience 🙏';

export interface FollowthroughWatchdogOptions {
  db: Database;
  /** Tick cadence in ms. Default 5 minutes. Tests pass large values. */
  intervalMs?: number;
  /** Minutes a 'requested' quote may sit priceless before CHECK A fires. Default 8. */
  previewStuckMin?: number;
  /** Minutes a 'ready' quote may sit undelivered before CHECK B fires. Default 15. */
  deliveryStuckMin?: number;
  /** Where devis PDFs live (devis-inbox writes `<DR>.pdf` here). Default `var/devis`. */
  devisDir?: string;
}

export interface FollowthroughWatchdogHandle {
  /** Stop the interval. Idempotent. */
  stop(): void;
  /** Test seam: run one tick (queued after any in-flight tick). */
  tickOnce(): Promise<void>;
}

interface TickCounters {
  previewChecked: number;
  previewEscalated: number;
  apologies: number;
  deliveryChecked: number;
  reemitted: number;
  relayEscalated: number;
  failures: number;
}

export function startFollowthroughWatchdog(
  opts: FollowthroughWatchdogOptions,
): FollowthroughWatchdogHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const previewStuckMin = opts.previewStuckMin ?? DEFAULT_PREVIEW_STUCK_MIN;
  const deliveryStuckMin = opts.deliveryStuckMin ?? DEFAULT_DELIVERY_STUCK_MIN;
  const devisDir = resolve(process.cwd(), opts.devisDir ?? 'var/devis');

  const tick = async (): Promise<void> => {
    const t0 = Date.now();
    const counters: TickCounters = {
      previewChecked: 0,
      previewEscalated: 0,
      apologies: 0,
      deliveryChecked: 0,
      reemitted: 0,
      relayEscalated: 0,
      failures: 0,
    };
    try {
      await checkPreviewStuck(opts.db, previewStuckMin, counters);
      await checkDeliveryStuck(opts.db, deliveryStuckMin, devisDir, counters);
      logger.info(
        { ...counters, durationMs: Date.now() - t0 },
        'followthrough-watchdog: tick complete',
      );
    } catch (err) {
      logger.error({ err: errMsg(err) }, 'followthrough-watchdog: tick failed');
    }
  };

  // Serialize ticks: the immediate boot tick and any tickOnce() caller share
  // one chain, so two ticks can never race past the same idempotency guard.
  let chain: Promise<void> = Promise.resolve();
  const runTick = (): Promise<void> => {
    chain = chain.then(tick);
    return chain;
  };

  void runTick();
  const interval = setInterval(() => {
    void runTick();
  }, intervalMs);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
    },
    tickOnce: runTick,
  };
}

/**
 * CHECK A — preview never arrived. The customer asked for a quote, the
 * operator never came back with a price, and nobody told anyone.
 */
async function checkPreviewStuck(
  db: Database,
  previewStuckMin: number,
  counters: TickCounters,
): Promise<void> {
  const now = Date.now();
  // Business window (2026-07-05): quotes queued while the Maxance portal is
  // closed (nights 20h-8h Moroccan + weekends) are PARKED delayed jobs, not
  // stuck flows — paging humans about them would cry wolf all weekend.
  // Skip the check while closed, and give freshly-reopened mornings
  // `previewStuckMin` of grace before judging (the parked backlog needs
  // time to drain through the single Maxance tab).
  if (!isMaxanceOpen()) return;
  if (msUntilMaxanceOpen(new Date(now - previewStuckMin * 60_000)) > 0) return;
  const rows = await db
    .select()
    .from(quotes)
    .where(
      and(
        eq(quotes.status, 'requested'),
        isNull(quotes.monthlyPremium),
        isNull(quotes.comptantDue),
        isNotNull(quotes.leadId),
        gte(quotes.requestedAt, new Date(now - LOOKBACK_MS)),
        lte(quotes.requestedAt, new Date(now - previewStuckMin * 60_000)),
      ),
    )
    .limit(BATCH_LIMIT);

  for (const q of rows) {
    counters.previewChecked += 1;
    try {
      if (!q.leadId) continue; // query already filters; type narrowing
      // Failure/stall already surfaced by the sales-agent or a prior tick.
      if (await hasAction(db, q.id, ['QUOTE_FAILED', 'QUOTE_STUCK'])) continue;
      // Price menu was delivered (only the price persist failed) — the
      // PREVIEW_READY message embeds `#<quoteId8>`.
      const turns = await listTurns(db, {
        customerId: q.customerId,
        leadId: q.leadId,
        limit: TURN_SCAN_LIMIT,
      });
      const menuMarker = `#${q.id.slice(0, 8)}`;
      if (turns.some((t) => t.direction === 'outbound' && (t.content ?? '').includes(menuMarker))) {
        continue;
      }

      const stuckMin = Math.round((now - q.requestedAt.getTime()) / 60_000);
      // Action row FIRST — it is the at-most-once guard for the apology too.
      const action = await createAction(db, {
        createdByAgent: `${ROLE}#${INSTANCE}`,
        correlationId: q.id,
        intent: 'QUOTE_STUCK',
        severity: 2,
        summary:
          `Devis en préparation depuis ${stuckMin} min sans résultat ` +
          `(quote ${q.id.slice(0, 8)}, lead ${q.leadId.slice(0, 8)}). ` +
          `Le flux Maxance semble bloqué — vérifier l'extension/le backend.`,
        // English labels — these render verbatim in the management WA group.
        options: [
          { id: 'retry', label: 'Retry the quote', kind: 'approve' },
          { id: 'manual', label: 'Do it manually', kind: 'approve' },
          { id: 'abandon', label: 'Abandon', kind: 'reject' },
        ],
      });
      await notifyHumanAction(
        db,
        { id: action.id, severity: 2, summary: action.summary },
        { role: ROLE, instanceId: INSTANCE, correlationId: q.id },
      );
      counters.previewEscalated += 1;

      const channel = preferInboundChannel(turns);
      const contactRef = await resolveContact(db, q.customerId, channel);
      if (!contactRef) {
        logger.warn(
          { quoteId: q.id, leadId: q.leadId, channel },
          'followthrough-watchdog: no contact address — escalation logged, apology skipped',
        );
        continue;
      }
      await sendViaChannel({
        db,
        customerId: q.customerId,
        leadId: q.leadId,
        to: contactRef,
        body: [{ type: 'text', text: APOLOGY_TEXT }],
        agentRole: ROLE,
        agentInstance: INSTANCE,
        correlationId: q.id,
      });
      counters.apologies += 1;
      logger.warn(
        { quoteId: q.id, leadId: q.leadId, stuckMin, humanActionId: action.id, channel },
        'followthrough-watchdog: stuck preview escalated + customer apologized',
      );
    } catch (err) {
      counters.failures += 1;
      logger.warn(
        { err: errMsg(err), quoteId: q.id },
        'followthrough-watchdog: preview-stuck handling failed',
      );
    }
  }
}

/**
 * CHECK B — devis confirmed in Maxance but the PDF never reached the
 * customer (relay dispatch lost, or the Maxance→contact@ email never came).
 */
async function checkDeliveryStuck(
  db: Database,
  deliveryStuckMin: number,
  devisDir: string,
  counters: TickCounters,
): Promise<void> {
  const now = Date.now();
  const rows = await db
    .select()
    .from(quotes)
    .where(
      and(
        eq(quotes.status, 'ready'),
        isNotNull(quotes.maxanceDevisNumber),
        isNotNull(quotes.readyAt),
        gte(quotes.readyAt, new Date(now - LOOKBACK_MS)),
        lte(quotes.readyAt, new Date(now - deliveryStuckMin * 60_000)),
      ),
    )
    .limit(BATCH_LIMIT);

  for (const q of rows) {
    counters.deliveryChecked += 1;
    try {
      const devisNumber = q.maxanceDevisNumber;
      if (!devisNumber || !q.readyAt) continue; // query already filters; type narrowing
      const turns = await listTurns(db, {
        customerId: q.customerId,
        ...(q.leadId ? { leadId: q.leadId } : {}),
        limit: TURN_SCAN_LIMIT,
      });
      // Delivered — the sales-agent's delivery message embeds `Réf. <DR>`.
      const refMarker = `Réf. ${devisNumber}`;
      if (turns.some((t) => t.direction === 'outbound' && (t.content ?? '').includes(refMarker))) {
        continue;
      }
      // Delivery failure already escalated (by the handler or a prior tick).
      if (
        await hasAction(db, q.id, [
          'DEVIS_DELIVERY_FAILED',
          'DEVIS_DELIVERY_PARTIAL',
          'DEVIS_RELAY_STUCK',
        ])
      ) {
        continue;
      }

      const pdfPath = resolve(devisDir, `${devisNumber}.pdf`);
      if (existsSync(pdfPath)) {
        // PDF landed but the DEVIS.PDF_RECEIVED dispatch was lost — re-emit.
        await sendMessage(
          { db },
          {
            fromRole: ROLE,
            fromInstance: INSTANCE,
            toRole: 'sales-agent',
            intent: 'DEVIS.PDF_RECEIVED',
            payload: { devisNumber, pdfPath, filename: `${devisNumber}.pdf` },
            correlationId: q.id,
          },
        );
        counters.reemitted += 1;
        logger.info(
          { quoteId: q.id, devisNumber, pdfPath },
          'followthrough-watchdog: re-emitted DEVIS.PDF_RECEIVED for undelivered devis',
        );
      } else {
        const stuckMin = Math.round((now - q.readyAt.getTime()) / 60_000);
        const action = await createAction(db, {
          createdByAgent: `${ROLE}#${INSTANCE}`,
          correlationId: q.id,
          intent: 'DEVIS_RELAY_STUCK',
          severity: 2,
          summary:
            `Devis ${devisNumber} confirmé il y a ${stuckMin} min mais le PDF n'est ` +
            `jamais arrivé sur contact@ (relais Maxance). Vérifier la boîte mail / ` +
            `renvoyer depuis Maxance.`,
          // English labels — these render verbatim in the management WA group.
          options: [
            { id: 'sent_manually', label: 'Sent manually', kind: 'approve' },
            { id: 'investigate', label: 'Investigate the relay', kind: 'approve' },
            { id: 'abandon', label: 'Abandon', kind: 'reject' },
          ],
        });
        await notifyHumanAction(
          db,
          { id: action.id, severity: 2, summary: action.summary },
          { role: ROLE, instanceId: INSTANCE, correlationId: q.id },
        );
        counters.relayEscalated += 1;
        logger.warn(
          { quoteId: q.id, devisNumber, stuckMin, humanActionId: action.id },
          'followthrough-watchdog: devis relay stuck — escalated',
        );
      }
    } catch (err) {
      counters.failures += 1;
      logger.warn(
        { err: errMsg(err), quoteId: q.id },
        'followthrough-watchdog: delivery-stuck handling failed',
      );
    }
  }
}

/** Any human_actions row (any status) for this quote with one of the intents. */
async function hasAction(db: Database, correlationId: string, intents: string[]): Promise<boolean> {
  const rows = await db
    .select({ id: humanActions.id })
    .from(humanActions)
    .where(
      and(eq(humanActions.correlationId, correlationId), inArray(humanActions.intent, intents)),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Resolve the customer's ContactRef for a channel — same shape as the
 * engagement agent's helper, replicated to avoid a cross-agent import.
 */
async function resolveContact(
  db: Database,
  customerId: string,
  channel: ChannelId,
): Promise<ContactRef | null> {
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
  if (!customer) return null;
  let address: string | null = null;
  switch (channel) {
    case 'whatsapp':
    case 'sms':
    case 'voice':
      address = decryptPII(customer.phone);
      break;
    case 'email':
      address = decryptPII(customer.email);
      break;
  }
  if (!address) return null;
  const fullName = decryptPII(customer.fullName);
  return { channel, address, ...(fullName ? { displayName: fullName } : {}) };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
