/**
 * Maxance Operator — SUBSCRIPTION.REQUESTED orchestration (M8.T7 task C2).
 *
 * The capstone that wires the closing pipeline together. Extracted from
 * `agent.ts` to keep that file under the 500-line budget; `agent.ts` registers
 * SUBSCRIPTION.REQUESTED → `handleSubscriptionRequested(ctx, envelope)`.
 *
 * Flow (design §5.2):
 *   1. Driver gate (chrome_extension only) — disabled → SUBSCRIPTION.FAILED.
 *   2. markSubscriptionRequested + read encrypted bank (getCustomerBankDetails)
 *      + customer name.
 *   3. ensureLoggedIn → resumeDevis (commission forced to 22) → in_progress.
 *   4. completeSubscription (dryRun gated by MAXANCE_SUBSCRIPTION_FORCE_DRYRUN,
 *      DEFAULT ON until P6 sign-off). RIB-rejected / any error → FAILED.
 *   5. Real success at the Paiement page → compute frais → Stripe link →
 *      markSubscriptionPendingInspector → emit SUBSCRIPTION.READY →
 *      CONTRACT.PENDING_HUMAN + human action (INSPECTOR_HANDOFF, severity 1)
 *      with the paiement screenshot pushed to the WA group.
 *      In dryRun: persist + emit READY (testable) but SKIP the inspector
 *      handoff (no real souscription to deblock).
 *
 * PII discipline: IBAN/BIC are read decrypted here to drive the portal but are
 * NEVER logged plaintext — only maskIban() forms reach the logger.
 */
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import { maskIban } from '../../lib/iban.js';
import { type MaxanceDriverClient, readErrorCode } from './driver-client.js';
import {
  markSubscriptionRequested,
  markSubscriptionInProgress,
  markSubscriptionPendingInspector,
  markSubscriptionFailed,
} from '../../db/repositories/quotes.js';
import { getCustomerById, getCustomerBankDetails } from '../../db/repositories/customers.js';
import { createAction } from '../../db/repositories/human-actions.js';
import { getStripeClientFromEnv } from '../../integrations/stripe/client.js';
import { FRAIS_DOSSIER_TOTAL_EUR, computeAssuryalFrais, type Formule } from './frais.js';

/** Session name on the driver — single-broker V1 (kept in sync with agent.ts). */
const SESSION_NAME = 'maxance-default';

/** Achraf's rule: commission is ALWAYS 22% on the closing path. */
const COMMISSION_PCT = 22;

/** N° de série placeholder — Achraf's rule (real papers mailed separately). */
const SERIAL_NUMBER = '1234567';

/**
 * Minimal sender for the inspector-handoff screenshot. The agent injects a
 * WAHA-backed impl built from env (HUMAN_ACTION_GROUP_CHAT_ID + WAHA_BASE_URL);
 * tests inject a recording stub. Best-effort — a send failure never fails the
 * (already-persisted) subscription.
 */
export interface InspectorScreenshotSender {
  /** base64 PNG bytes + a caption → the WA group. */
  send(input: { base64Png: string; caption: string }): Promise<void>;
}

/**
 * Context the agent hands the handler. Mirrors what the agent itself has:
 * the db, its identity, the driver-client resolver, and the optional
 * screenshot sender. Keeping this explicit means the handler is unit-testable
 * without standing up a full BaseAgent.
 */
export interface SubscriptionHandlerContext {
  db: Database;
  role: string;
  instanceId: string;
  /** Resolve the driver client (chrome_extension WS / legacy stagehand). */
  getClient(): Promise<MaxanceDriverClient>;
  /** Optional WA-group screenshot sender for the inspector handoff. */
  screenshotSender?: InspectorScreenshotSender | null;
}

/** Inbound SUBSCRIPTION.REQUESTED payload (validated upstream by the intent registry). */
interface SubscriptionRequestedPayload {
  quoteId: string;
  customerId: string;
  leadId?: string | null;
  devisNumber: string;
  formule: Formule;
  fractionnement: 'mensuel' | 'annuel';
  birthPlaceCity: string;
  bankRef: 'customer';
}

/**
 * Drive the full closing pipeline for one accepted quote.
 *
 * The driver client is resolved by the agent BEFORE calling this (so the
 * driver-gate failure surfaces as SUBSCRIPTION.FAILED with the same shape as
 * the quote handlers). The handler owns everything from
 * markSubscriptionRequested onward.
 */
export async function handleSubscriptionRequested(
  ctx: SubscriptionHandlerContext,
  envelope: AgentMessageEnvelope,
  client: MaxanceDriverClient,
): Promise<MessageHandlerResult> {
  const payload = envelope.payload as SubscriptionRequestedPayload;
  const { quoteId, customerId, formule, fractionnement, devisNumber } = payload;

  // Step 2: mark requested + read the encrypted bank details + customer name.
  await markSubscriptionRequested(ctx.db, quoteId);

  const bank = await getCustomerBankDetails(ctx.db, customerId);
  if (!bank || !bank.iban || !bank.bic || !bank.accountHolder) {
    await failSubscription(ctx, payload, 'maxance_subscription_missing_bank');
    return { ok: false, error: 'maxance_subscription_missing_bank' };
  }
  const customer = await getCustomerById(ctx.db, customerId);
  const { lastName, firstName } = splitName(customer?.fullName ?? '');
  const birthPlaceCity = payload.birthPlaceCity || bank.birthPlaceCity || 'Paris';

  // Step 3: ensure the session is alive, then resume the devis on Garanties.
  try {
    await client.ensureLoggedIn(SESSION_NAME);
  } catch (err) {
    const code = readErrorCode(err) ?? 'login_unknown';
    await failSubscription(ctx, payload, `subscription_login_failed:${code}`);
    return { ok: false, error: `subscription_login_failed:${code}` };
  }

  // The resume + completeSubscription methods live on ExtensionClient, not the
  // shared MaxanceDriverClient interface. Narrow structurally — the legacy
  // stagehand client doesn't implement them and is dead in prod anyway.
  const ext = client as MaxanceDriverClient & Partial<SubscriptionCapableClient>;
  if (typeof ext.resumeDevis !== 'function' || typeof ext.completeSubscription !== 'function') {
    await failSubscription(ctx, payload, 'maxance_subscription_driver_unsupported');
    return { ok: false, error: 'maxance_subscription_driver_unsupported' };
  }

  let resume: ResumeDevisResultShape;
  try {
    resume = await ext.resumeDevis(SESSION_NAME, {
      devisNumber,
      formule,
      commissionPct: COMMISSION_PCT,
      fractionnement,
    });
  } catch (err) {
    const code = readErrorCode(err) ?? 'resume_unknown';
    await failSubscription(ctx, payload, code, err);
    return { ok: false, error: code };
  }

  await markSubscriptionInProgress(ctx.db, quoteId);

  // Step 4: complete the souscription. dryRun is DEFAULT ON until P6 sign-off —
  // only an explicit MAXANCE_SUBSCRIPTION_FORCE_DRYRUN=0 runs a real souscription.
  const dryRun = process.env.MAXANCE_SUBSCRIPTION_FORCE_DRYRUN !== '0';

  let result: CompleteSubscriptionResultShape;
  try {
    result = await ext.completeSubscription(
      SESSION_NAME,
      {
        devisNumber,
        subscriber: { lastName, firstName },
        bank: { iban: bank.iban, bic: bank.bic, accountHolder: bank.accountHolder },
        birthPlaceCity,
        serialNumber: SERIAL_NUMBER,
      },
      { dryRun },
    );
  } catch (err) {
    // maxance_subscription_rib_rejected (or any error) → FAILED, no READY.
    const code = readErrorCode(err) ?? 'subscription_unknown';
    logger.error(
      { quoteId, code, iban: maskIban(bank.iban) },
      'maxance-operator: completeSubscription failed',
    );
    await failSubscription(ctx, payload, code, err);
    return { ok: false, error: code };
  }

  // ── Success ──────────────────────────────────────────────────────────────
  // The frais comptant (Maxance's own portion) comes from the souscription's
  // comptant breakdown, falling back to the resume breakdown when the
  // souscription run didn't re-surface it (dryRun stops earlier).
  const fraisComptantRaw =
    result.comptantBreakdown?.fraisDossierEur ?? resume.comptantBreakdown?.fraisComptantEur;
  const fraisComptantEur = Number.isFinite(fraisComptantRaw) ? (fraisComptantRaw as number) : 0;
  const fraisDossierTotalEur = FRAIS_DOSSIER_TOTAL_EUR[formule];
  const assuryalFraisEur = computeAssuryalFrais(formule, fraisComptantEur);
  const montantComptantEur = result.montantComptantEur ?? resume.comptantBreakdown?.comptantEur;

  // Stripe: mint the Assuryal-frais payment link when configured; null otherwise
  // (the SUBSCRIPTION.READY consumer has a human-action fallback for null).
  let paymentLinkUrl: string | null = null;
  const stripe = getStripeClientFromEnv();
  if (stripe) {
    try {
      const link = await stripe.createFraisPaymentLink({
        quoteId,
        customerId,
        formule,
        fraisComptantEur,
      });
      paymentLinkUrl = link.url;
    } catch (err) {
      logger.warn(
        { quoteId, err: err instanceof Error ? err.message : String(err) },
        'maxance-operator: Stripe payment link failed — emitting READY with null link',
      );
    }
  }

  await markSubscriptionPendingInspector(ctx.db, quoteId, {
    ...(result.souscripteurRef != null ? { souscripteurRef: result.souscripteurRef } : {}),
    ...(montantComptantEur != null ? { montantComptantEur } : {}),
    fraisBreakdown: { fraisComptantEur, fraisDossierTotalEur, assuryalFraisEur },
    stripePaymentLinkUrl: paymentLinkUrl,
  });

  // Emit SUBSCRIPTION.READY → sales-agent sends the payment-link message (D1).
  await sendMessage(
    { db: ctx.db },
    {
      fromRole: ctx.role,
      fromInstance: ctx.instanceId,
      toRole: 'sales-agent',
      intent: 'SUBSCRIPTION.READY',
      payload: {
        quoteId,
        customerId,
        ...(result.souscripteurRef != null ? { souscripteurRef: result.souscripteurRef } : {}),
        ...(montantComptantEur != null ? { montantComptantEur } : {}),
        fraisComptantEur,
        fraisDossierTotalEur,
        assuryalFraisEur,
        paymentLinkUrl,
        dryRun,
      },
      correlationId: quoteId,
    },
  );

  // INSPECTOR HANDOFF — only in real mode (dryRun has no souscription to deblock).
  if (!dryRun) {
    await raiseInspectorHandoff(ctx, payload, result);
  } else {
    logger.info(
      { quoteId },
      'maxance-operator: dryRun subscription — READY emitted, inspector handoff SKIPPED',
    );
  }

  logger.info(
    {
      quoteId,
      dryRun,
      assuryalFraisEur,
      hasPaymentLink: paymentLinkUrl !== null,
      durationMs: result.durationMs,
    },
    dryRun
      ? 'maxance-operator: subscription dry-run ready (no real contract)'
      : 'maxance-operator: subscription ready — pending inspector handoff',
  );

  return {
    ok: true,
    result: { quoteId, dryRun, assuryalFraisEur, paymentLinkUrl: paymentLinkUrl ?? null },
  };
}

/**
 * Emit CONTRACT.PENDING_HUMAN + raise the INSPECTOR_HANDOFF human action, then
 * push the paiement screenshot to the WA group.
 *
 * The human-action row + HUMAN_ACTION.REQUESTED dispatch reach BOTH the admin
 * UI (realtime trigger) AND the WA group (reporter-agent posts the text). The
 * screenshot is attached by sending it directly to HUMAN_ACTION_GROUP_CHAT_ID
 * via the injected sender (mirrors reporter-agent's sendImage pattern) — chosen
 * over enlarging the human-action row because the data URL is operator-only PII
 * and WAHA can't fetch our in-memory screenshot.
 */
async function raiseInspectorHandoff(
  ctx: SubscriptionHandlerContext,
  payload: SubscriptionRequestedPayload,
  result: CompleteSubscriptionResultShape,
): Promise<void> {
  const { quoteId } = payload;

  // CONTRACT.PENDING_HUMAN — the closing lifecycle's inspector-handoff signal.
  await sendMessage(
    { db: ctx.db },
    {
      fromRole: ctx.role,
      fromInstance: ctx.instanceId,
      toRole: 'sales-agent',
      intent: 'CONTRACT.PENDING_HUMAN',
      payload: { quoteId },
      correlationId: quoteId,
    },
  );

  // Human action (severity 1) → admin UI + WA group via the reporter-agent.
  const summary =
    `Souscription Maxance prête (devis ${payload.devisNumber}) — ` +
    `merci de transmettre la capture de l'état souscription/paiement à ` +
    `l'inspecteur Maxance pour débloquer le contrat` +
    (result.souscripteurRef ? ` (réf ${result.souscripteurRef}).` : '.');

  let humanActionId: string | null = null;
  try {
    const action = await createAction(ctx.db, {
      createdByAgent: `${ctx.role}#${ctx.instanceId}`,
      intent: 'INSPECTOR_HANDOFF',
      severity: 1,
      summary,
      options: [{ id: 'done', label: 'Contrat débloqué', kind: 'custom' }],
      correlationId: quoteId,
    });
    humanActionId = action.id;

    const sendInput: Parameters<typeof sendMessage>[1] = {
      fromRole: ctx.role,
      fromInstance: ctx.instanceId,
      toRole: 'human-router',
      intent: 'HUMAN_ACTION.REQUESTED',
      payload: { humanActionId: action.id, severity: 1, summary },
      requiresHuman: true,
      correlationId: quoteId,
    };
    await sendMessage({ db: ctx.db }, sendInput);
  } catch (err) {
    // The pending_inspector state + READY are already persisted/emitted; a
    // human-action hiccup must not turn a successful souscription into a failure.
    logger.error(
      { quoteId, err: err instanceof Error ? err.message : String(err) },
      'maxance-operator: failed to raise INSPECTOR_HANDOFF human action (non-fatal)',
    );
  }

  // Attach the paiement screenshot to the WA group (best-effort).
  await sendInspectorScreenshot(ctx, payload, result, humanActionId);
}

/** Push the last paiement screenshot to the WA group via the injected sender. */
async function sendInspectorScreenshot(
  ctx: SubscriptionHandlerContext,
  payload: SubscriptionRequestedPayload,
  result: CompleteSubscriptionResultShape,
  humanActionId: string | null,
): Promise<void> {
  const sender = ctx.screenshotSender;
  if (!sender) {
    logger.info(
      { quoteId: payload.quoteId },
      'maxance-operator: no screenshot sender configured — inspector screenshot not posted',
    );
    return;
  }
  const shot = pickPaiementScreenshot(result.screenshots);
  if (!shot) {
    logger.info(
      { quoteId: payload.quoteId },
      'maxance-operator: souscription produced no screenshot to hand off',
    );
    return;
  }
  const base64 = dataUrlToBase64(shot.url);
  if (!base64) return;
  const caption =
    `🖥️ Capture souscription/paiement — devis ${payload.devisNumber}` +
    (humanActionId ? ` (action ${humanActionId})` : '');
  try {
    await sender.send({ base64Png: base64, caption });
  } catch (err) {
    logger.warn(
      { quoteId: payload.quoteId, err: err instanceof Error ? err.message : String(err) },
      'maxance-operator: inspector screenshot send failed (non-fatal)',
    );
  }
}

/**
 * Mark FAILED + emit SUBSCRIPTION.FAILED. The screenshots (if any) ride along
 * for operator diagnosis; never echoed to the customer (sales-agent contract).
 */
async function failSubscription(
  ctx: SubscriptionHandlerContext,
  payload: SubscriptionRequestedPayload,
  errorCode: string,
  err?: unknown,
): Promise<void> {
  try {
    await markSubscriptionFailed(ctx.db, payload.quoteId, { errorCode });
  } catch (markErr) {
    logger.error(
      {
        quoteId: payload.quoteId,
        err: markErr instanceof Error ? markErr.message : String(markErr),
      },
      'maxance-operator: markSubscriptionFailed threw (non-fatal)',
    );
  }
  const detail = err instanceof Error ? err.message : undefined;
  await sendMessage(
    { db: ctx.db },
    {
      fromRole: ctx.role,
      fromInstance: ctx.instanceId,
      toRole: 'sales-agent',
      intent: 'SUBSCRIPTION.FAILED',
      payload: {
        quoteId: payload.quoteId,
        customerId: payload.customerId,
        errorCode,
        ...(detail ? { detail } : {}),
        screenshots: [],
      },
      correlationId: payload.quoteId,
    },
  );
}

// ── pure helpers ──────────────────────────────────────────────────────────

/** Split a stored full name into {lastName, firstName} (best-effort). */
function splitName(fullName: string): { lastName: string; firstName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { lastName: '', firstName: '' };
  if (parts.length === 1) return { lastName: parts[0] as string, firstName: '' };
  // Convention: first token = firstName, remainder = lastName.
  const [firstName, ...rest] = parts;
  return { lastName: rest.join(' '), firstName: firstName as string };
}

/** Last screenshot is the terminal (paiement) state; fall back to any. */
function pickPaiementScreenshot(
  shots: Array<{ step: string; url: string }> | undefined,
): { step: string; url: string } | null {
  if (!shots || shots.length === 0) return null;
  const paiement = [...shots].reverse().find((s) => /paiement|souscription/i.test(s.step));
  return paiement ?? shots[shots.length - 1] ?? null;
}

/** Strip the `data:image/...;base64,` prefix → raw base64, or null if not a data URL. */
function dataUrlToBase64(url: string): string | null {
  const m = /^data:[^;]+;base64,(.+)$/.exec(url);
  return m ? (m[1] as string) : null;
}

// Structural shapes for the ExtensionClient closing methods (resumeDevis /
// completeSubscription live on ExtensionClient, not the shared driver iface).
interface ResumeDevisResultShape {
  durationMs: number;
  screenshots: Array<{ step: string; url: string }>;
  comptantBreakdown?: { fraisComptantEur?: number | null; comptantEur?: number };
}

interface CompleteSubscriptionResultShape {
  durationMs: number;
  screenshots: Array<{ step: string; url: string }>;
  dryRun: boolean;
  souscripteurRef?: string;
  montantComptantEur?: number;
  comptantBreakdown: { fraisDossierEur: number | null } | null;
}

interface SubscriptionCapableClient {
  resumeDevis(
    sessionName: string,
    args: {
      devisNumber: string;
      formule?: Formule;
      commissionPct?: number;
      fractionnement?: 'mensuel' | 'annuel';
    },
    opts?: { timeoutMs?: number },
  ): Promise<ResumeDevisResultShape>;
  completeSubscription(
    sessionName: string,
    args: {
      devisNumber: string;
      subscriber: { lastName: string; firstName: string };
      bank: { iban: string; bic: string; accountHolder: string };
      birthPlaceCity: string;
      serialNumber?: string;
    },
    opts?: { dryRun?: boolean; timeoutMs?: number },
  ): Promise<CompleteSubscriptionResultShape>;
}
