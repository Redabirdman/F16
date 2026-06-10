/**
 * Maxance Operator Agent (M8.T4 + M8.T8 phase 1 gate).
 *
 * 🚨 PRODUCTION DRIVER STATUS (2026-05-23 lock, see memory/project_hosting_pivot.md):
 *
 * Stagehand+Playwright CANNOT drive Maxance in production — Cloudflare
 * Turnstile blocks every Playwright-launched Chrome regardless of stealth
 * treatment (proven by 3 live attempts in M8.T2/T3). The only viable driver
 * is a Chrome extension running inside Ridaa's daily Chrome — the V1 path
 * is M8.T8 phase 2 (not yet built).
 *
 * Until M8.T8 phase 2 lands, this agent is GATED by the MAXANCE_DRIVER env:
 *   - unset / wrong value  → handler returns maxance_driver_disabled +
 *                             emits QUOTE.FAILED. Prevents anyone from
 *                             accidentally turning on the broken Stagehand
 *                             path in prod.
 *   - 'chrome_extension'   → V1 target. Currently throws
 *                             maxance_driver_chrome_extension_not_implemented
 *                             because the extension client isn't built yet.
 *   - 'stagehand_legacy_DO_NOT_USE_IN_PROD' → explicit opt-in to the legacy
 *                             Stagehand-HTTP path. Cloudflare WILL block it.
 *                             Used only for selector regression tests against
 *                             a non-Cloudflare staging environment if one ever
 *                             exists. PRODUCTION NEVER.
 *
 * The Stagehand step-planner code (stagehand/src/maxance/*.ts) survives as
 * the canonical selectors + field-mappings reference — the extension will
 * import those constants when phase 2 lands.
 *
 * Original (pre-gate) flow, kept for documentation:
 *   1. Translate the QUOTE.REQUESTED payload into a MaxanceQuoteParams.
 *   2. Make sure a logged-in session exists (`ensureLoggedIn`).
 *   3. Drive the trottinette quote with dryRun=true.
 *   4. Emit QUOTE.PREVIEW_READY → Sales Agent surfaces the price.
 *   5. On failure → QUOTE.FAILED with tagged errorCode.
 *
 * The agent does NOT touch the customer-facing channel directly — the
 * Sales Agent owns that surface (M6.T3).
 *
 * Concurrency: BaseAgent gives per-instance serialisation (concurrency=1).
 * Only one Maxance session is logged in at a time on the PC; two concurrent
 * quote runs would race on the same Chrome. M8.T5 (pre-warm pool) skipped
 * per Ridaa's V1 decision.
 */
import { BaseAgent } from '../base.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';
import type { StagehandQuoteParams, StagehandSubscriberInfo } from './stagehand-client.js';
import {
  type MaxanceDriverClient,
  getDefaultMaxanceDriverClient,
  readErrorCode,
} from './driver-client.js';
import { emitHubSpotSync } from '../../db/repositories/leads.js';

/** Recognised MAXANCE_DRIVER values. Anything else → driver disabled. */
type MaxanceDriver = 'chrome_extension' | 'stagehand_legacy_DO_NOT_USE_IN_PROD';

/**
 * Read MAXANCE_DRIVER from the environment and return the typed value, or
 * throw `maxance_driver_disabled` if unset / invalid. Called at the top of
 * every handler so the failure surfaces as a tagged QUOTE.FAILED rather
 * than a dropped message.
 */
function readDriverFromEnv(): MaxanceDriver {
  const v = process.env.MAXANCE_DRIVER;
  if (v === 'chrome_extension') return v;
  if (v === 'stagehand_legacy_DO_NOT_USE_IN_PROD') return v;
  throw new Error(
    'maxance_driver_disabled: set MAXANCE_DRIVER=chrome_extension (V1 prod, M8.T8 phase 2) ' +
      'or MAXANCE_DRIVER=stagehand_legacy_DO_NOT_USE_IN_PROD (broken on prod — Cloudflare blocks)',
  );
}

/**
 * Per-broker session name on the Stagehand pool. V1 is single-broker
 * (Achraf's account); when we onboard a second broker we'll partition
 * by broker id.
 */
const SESSION_NAME = 'maxance-default';

export class MaxanceOperatorAgent extends BaseAgent {
  /**
   * Driver client — interface is shared by StagehandClient (legacy) and
   * ExtensionClient (V1 prod). The concrete instance is picked at the
   * first handler invocation based on MAXANCE_DRIVER env. Tests inject
   * a mock via the constructor.
   */
  private client: MaxanceDriverClient | null;

  constructor(
    cfg: ConstructorParameters<typeof BaseAgent>[0],
    deps: { client?: MaxanceDriverClient } = {},
  ) {
    super(cfg);
    this.client = deps.client ?? null;
  }

  /**
   * Lazily resolve the driver client based on `driver`. Caches the
   * resolved client so the WS server doesn't restart on every handler
   * call. Tests bypass this by injecting `deps.client` in the constructor.
   */
  private async getClient(driver: MaxanceDriver): Promise<MaxanceDriverClient> {
    if (this.client) return this.client;
    this.client = await getDefaultMaxanceDriverClient(driver);
    return this.client;
  }

  protected async onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    switch (envelope.intent) {
      case 'QUOTE.REQUESTED':
        return this.handleQuoteRequested(envelope);
      case 'QUOTE.CONFIRM_REQUESTED':
        return this.handleQuoteConfirmRequested(envelope);
      default:
        logger.debug(
          { intent: envelope.intent, instanceId: this.instanceId },
          'maxance-operator: ignoring unhandled intent',
        );
        return { ok: true, result: { skipped: 'unhandled-intent', intent: envelope.intent } };
    }
  }

  /**
   * QUOTE.CONFIRM_REQUESTED handler (M8.T6).
   *
   * Pre-condition: a prior QUOTE.REQUESTED on the same session left Stagehand
   * sitting on the Garanties tab with a price preview. The Sales Agent has
   * since gathered the customer's full subscriber info (Civilité, Nom, etc.)
   * and emitted this envelope.
   *
   * Pipeline:
   *   1. Sanity-check session is still alive (ensureLoggedIn — cheap on warm).
   *   2. POST /v1/maxance/quote/confirm with the subscriber payload.
   *   3. On success → emit QUOTE.READY with the devisNumber + pdfSentTo.
   *   4. On failure → emit QUOTE.FAILED (same envelope shape as M8.T4 path)
   *      with the tagged errorCode + escalation to human.
   *
   * dryRun: defaults to FALSE here — the customer just said yes, they're
   * expecting an email. Production-ready by default once Achraf signs off
   * on the live email path. To force dry-run for testing, set the env
   * `MAXANCE_CONFIRM_FORCE_DRYRUN=1` on the backend process.
   */
  private async handleQuoteConfirmRequested(
    envelope: AgentMessageEnvelope,
  ): Promise<MessageHandlerResult> {
    const payload = envelope.payload as {
      quoteId: string;
      customerId: string;
      leadId: string;
      subscriber: StagehandSubscriberInfo;
    };

    // M8.T8 phase 1 driver gate. See file header for the full rationale.
    let driver: MaxanceDriver;
    try {
      driver = readDriverFromEnv();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { quoteId: payload.quoteId, err: msg },
        'maxance-operator: driver gate refused — emitting QUOTE.FAILED',
      );
      await this.emitFailed(
        payload.quoteId,
        payload.customerId,
        payload.leadId,
        'maxance_driver_disabled',
        msg,
      );
      return { ok: false, error: 'maxance_driver_disabled' };
    }
    // M8.T8 phase 2c: resolve the driver client. ExtensionClient is the
    // V1 prod path (WS server bound to 127.0.0.1:9223; Chrome extension
    // connects outbound). StagehandClient is the legacy path.
    let client: MaxanceDriverClient;
    try {
      client = await this.getClient(driver);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.emitFailed(
        payload.quoteId,
        payload.customerId,
        payload.leadId,
        'maxance_driver_init_failed',
        msg,
      );
      return { ok: false, error: 'maxance_driver_init_failed' };
    }

    // Re-validate the session is alive. If the cookie expired since the
    // PREVIEW_READY we need to bail — the Stagehand session has lost its
    // Garanties-tab state and a fresh login lands us on the dashboard.
    try {
      await client.ensureLoggedIn(SESSION_NAME);
    } catch (err) {
      const code = readErrorCode(err) ?? 'login_unknown';
      await this.emitFailed(
        payload.quoteId,
        payload.customerId,
        payload.leadId,
        `confirm_login_failed:${code}`,
      );
      return { ok: false, error: `confirm_login_failed:${code}` };
    }

    const dryRun = process.env.MAXANCE_CONFIRM_FORCE_DRYRUN === '1';
    let confirm;
    try {
      confirm = await client.confirmQuote(SESSION_NAME, payload.subscriber, { dryRun });
    } catch (err) {
      const code = readErrorCode(err) ?? 'confirm_unknown';
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { quoteId: payload.quoteId, code, err: msg },
        'maxance-operator: confirm flow failed',
      );
      await this.emitFailed(payload.quoteId, payload.customerId, payload.leadId, code, msg);
      return { ok: false, error: code };
    }

    // Emit QUOTE.READY. The Sales Agent picks this up and confirms to the
    // customer that the devis was emailed. We pass through monthlyPremium=0
    // and comptantDue=0 because the schema requires non-negative numbers
    // and the actual price is part of the upstream PREVIEW_READY envelope
    // the customer already saw — Maxance doesn't surface monthly/comptant
    // again at this stage. Downstream consumers should reference the
    // earlier PREVIEW_READY for the headline figures.
    await sendMessage(
      { db: this.db },
      {
        fromRole: this.role,
        fromInstance: this.instanceId,
        toRole: 'sales-agent',
        toInstance: `lead-${payload.leadId}`,
        intent: 'QUOTE.READY',
        payload: {
          quoteId: payload.quoteId,
          customerId: payload.customerId,
          monthlyPremium: 0,
          comptantDue: 0,
          devisNumber: confirm.devisNumber,
          pdfSentTo: confirm.pdfSentTo,
        },
        correlationId: payload.quoteId,
      },
    );

    // Mirror devisNumber + price to HubSpot — the reconciler picks up the
    // latest quote row (now containing the devis number) to fill the deal's
    // amount / f16_devis_number. Non-blocking: HubSpot hiccup ≠ quote failure.
    await emitHubSpotSync(this.db, payload.leadId);

    logger.info(
      {
        quoteId: payload.quoteId,
        devisNumber: confirm.devisNumber,
        pdfSentTo: confirm.pdfSentTo,
        durationMs: confirm.durationMs,
        dryRun,
      },
      dryRun
        ? 'maxance-operator: confirm dry-run (no email sent)'
        : 'maxance-operator: quote saved + email sent',
    );

    return {
      ok: true,
      result: {
        quoteId: payload.quoteId,
        devisNumber: confirm.devisNumber,
        pdfSentTo: confirm.pdfSentTo,
        dryRun,
      },
    };
  }

  private async handleQuoteRequested(
    envelope: AgentMessageEnvelope,
  ): Promise<MessageHandlerResult> {
    const payload = envelope.payload as {
      quoteId: string;
      customerId: string;
      leadId: string;
      product: 'scooter' | 'car';
      productVariant: string;
      formData: Record<string, unknown>;
    };

    // M8.T8 phase 1 driver gate. See file header for the full rationale.
    let driver: MaxanceDriver;
    try {
      driver = readDriverFromEnv();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { quoteId: payload.quoteId, err: msg },
        'maxance-operator: driver gate refused — emitting QUOTE.FAILED',
      );
      await this.emitFailed(
        payload.quoteId,
        payload.customerId,
        payload.leadId,
        'maxance_driver_disabled',
        msg,
      );
      return { ok: false, error: 'maxance_driver_disabled' };
    }
    // M8.T8 phase 2c: resolve the driver client. ExtensionClient is the
    // V1 prod path (WS server bound to 127.0.0.1:9223; Chrome extension
    // connects outbound). StagehandClient is the legacy path.
    let client: MaxanceDriverClient;
    try {
      client = await this.getClient(driver);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.emitFailed(
        payload.quoteId,
        payload.customerId,
        payload.leadId,
        'maxance_driver_init_failed',
        msg,
      );
      return { ok: false, error: 'maxance_driver_init_failed' };
    }

    // Product/variant guard — M8 ships ONLY trottinette. Other products
    // (car, full moto, NVEI variants) will land as their own agents or
    // a dispatch on productVariant in V1.1.
    if (payload.product !== 'scooter' || payload.productVariant !== 'trottinette') {
      logger.warn(
        {
          quoteId: payload.quoteId,
          product: payload.product,
          productVariant: payload.productVariant,
        },
        'maxance-operator: unsupported product/variant — skipping',
      );
      await this.emitFailed(
        payload.quoteId,
        payload.customerId,
        payload.leadId,
        'unsupported_product_variant',
      );
      return { ok: true, result: { skipped: 'unsupported-product-variant' } };
    }

    // Translate the free-shape `formData` into the deterministic Stagehand
    // params. Validate eagerly so a malformed envelope dies with a tagged
    // error code instead of deep inside Stagehand.
    let params: StagehandQuoteParams;
    try {
      params = this.toQuoteParams(payload.formData);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ quoteId: payload.quoteId, err: msg }, 'maxance-operator: invalid form data');
      await this.emitFailed(
        payload.quoteId,
        payload.customerId,
        payload.leadId,
        `invalid_form_data:${msg}`,
      );
      return { ok: true, result: { skipped: 'invalid-form-data' } };
    }

    // Step 1: ensure login. Cheap on the warm path (~150ms); up to 15s
    // cold (SMS bootstrap once per ~30 days).
    try {
      const loginResult = await client.ensureLoggedIn(SESSION_NAME);
      logger.info(
        {
          quoteId: payload.quoteId,
          sessionId: loginResult.sessionId,
          alreadyLoggedIn: loginResult.alreadyLoggedIn,
          requiredHumanAction: loginResult.requiredHumanAction,
          durationMs: loginResult.durationMs,
        },
        'maxance-operator: session ready',
      );
    } catch (err) {
      const code = readErrorCode(err) ?? 'login_unknown';
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ quoteId: payload.quoteId, code, err: msg }, 'maxance-operator: login failed');
      await this.emitFailed(
        payload.quoteId,
        payload.customerId,
        payload.leadId,
        `login_failed:${code}`,
      );
      return { ok: false, error: `login_failed:${code}` };
    }

    // Step 2: drive the quote. dryRun=true — M8.T6 will add the Valider path.
    let preview;
    try {
      preview = await client.runQuote(SESSION_NAME, params, { dryRun: true });
    } catch (err) {
      const code = readErrorCode(err) ?? 'quote_unknown';
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { quoteId: payload.quoteId, code, err: msg },
        'maxance-operator: quote flow failed',
      );
      await this.emitFailed(payload.quoteId, payload.customerId, payload.leadId, code, msg);
      return { ok: false, error: code };
    }

    // Step 3: emit QUOTE.PREVIEW_READY. Routed to the sales-agent instance
    // for this lead, which decides how to surface the price to the customer.
    await sendMessage(
      { db: this.db },
      {
        fromRole: this.role,
        fromInstance: this.instanceId,
        toRole: 'sales-agent',
        toInstance: `lead-${payload.leadId}`,
        intent: 'QUOTE.PREVIEW_READY',
        payload: {
          quoteId: payload.quoteId,
          customerId: payload.customerId,
          pricePreviewEur: {
            ...(preview.pricePreviewEur.monthly !== undefined
              ? { monthly: preview.pricePreviewEur.monthly }
              : {}),
            ...(preview.pricePreviewEur.annual !== undefined
              ? { annual: preview.pricePreviewEur.annual }
              : {}),
          },
          // Maxance's default formule per Achraf — Stagehand uses this when
          // params.formule isn't set. M8.T6 will let callers toggle.
          formule: params.formule ?? 'tiers_illimite',
          finalUrl: preview.finalUrl,
          screenshots: preview.screenshots,
          durationMs: preview.durationMs,
        },
        correlationId: payload.quoteId,
      },
    );

    logger.info(
      {
        quoteId: payload.quoteId,
        monthly: preview.pricePreviewEur.monthly,
        annual: preview.pricePreviewEur.annual,
        durationMs: preview.durationMs,
        screenshotCount: preview.screenshots.length,
      },
      'maxance-operator: preview ready',
    );

    return {
      ok: true,
      result: {
        quoteId: payload.quoteId,
        monthly: preview.pricePreviewEur.monthly ?? null,
        annual: preview.pricePreviewEur.annual ?? null,
        durationMs: preview.durationMs,
      },
    };
  }

  /**
   * Translate a free-shape `formData` from QUOTE.REQUESTED into the
   * deterministic Stagehand quote params. Validates required fields
   * eagerly so a malformed envelope dies before we burn a Stagehand call.
   *
   * Accepted keys (must all be present unless noted):
   *   - purchasePriceEur (number, > 0)
   *   - purchaseDate (ISO date string or Date)
   *   - postalCode (5-digit string)
   *   - stationnement ('garage_box' | 'parking_prive_clos' | 'parking_prive_non_clos' | 'rue')
   *   - clientDateOfBirth (ISO date string or Date)
   *   - city (optional)
   *   - formule (optional)
   *   - commissionPct (optional, number 9-22)
   *   - fractionnement (optional, 'mensuel' | 'annuel')
   */
  private toQuoteParams(formData: Record<string, unknown>): StagehandQuoteParams {
    const num = (k: string): number => {
      const v = formData[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`missing_or_invalid_${k}`);
      }
      return v;
    };
    const str = (k: string): string => {
      const v = formData[k];
      if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`missing_or_invalid_${k}`);
      }
      return v;
    };
    const dateLike = (k: string): string | Date => {
      const v = formData[k];
      if (v instanceof Date) return v;
      if (typeof v === 'string' && v.length > 0) return v;
      throw new Error(`missing_or_invalid_${k}`);
    };
    const stationnement = str('stationnement');
    const allowedSt = ['garage_box', 'parking_prive_clos', 'parking_prive_non_clos', 'rue'];
    if (!allowedSt.includes(stationnement)) {
      throw new Error('invalid_stationnement');
    }
    const params: StagehandQuoteParams = {
      vehicleKind: 'trottinette',
      purchasePriceEur: num('purchasePriceEur'),
      purchaseDate: dateLike('purchaseDate'),
      postalCode: str('postalCode'),
      stationnement: stationnement as StagehandQuoteParams['stationnement'],
      clientDateOfBirth: dateLike('clientDateOfBirth'),
    };
    if (typeof formData.city === 'string' && formData.city.length > 0) {
      params.city = formData.city;
    }
    const formule = formData.formule;
    if (
      typeof formule === 'string' &&
      ['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents'].includes(formule)
    ) {
      params.formule = formule as NonNullable<StagehandQuoteParams['formule']>;
    }
    if (typeof formData.commissionPct === 'number' && Number.isFinite(formData.commissionPct)) {
      params.commissionPct = formData.commissionPct;
    }
    const fractionnement = formData.fractionnement;
    if (typeof fractionnement === 'string' && ['mensuel', 'annuel'].includes(fractionnement)) {
      params.fractionnement = fractionnement as NonNullable<StagehandQuoteParams['fractionnement']>;
    }
    return params;
  }

  /** Emit QUOTE.FAILED with a tagged error code so the operator UI can surface it. */
  private async emitFailed(
    quoteId: string,
    customerId: string,
    leadId: string,
    errorCode: string,
    detail?: string,
  ): Promise<void> {
    await sendMessage(
      { db: this.db },
      {
        fromRole: this.role,
        fromInstance: this.instanceId,
        toRole: 'sales-agent',
        toInstance: `lead-${leadId}`,
        intent: 'QUOTE.FAILED',
        payload: {
          quoteId,
          customerId,
          errorCode,
          ...(detail ? { detail } : {}),
          screenshots: [],
        },
        correlationId: quoteId,
      },
    );
  }
}
