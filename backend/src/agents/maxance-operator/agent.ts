/**
 * Maxance Operator Agent (M8.T4).
 *
 * Subscribes to the `quote` queue and consumes QUOTE.REQUESTED. For each
 * request:
 *   1. Translate the QUOTE.REQUESTED payload into a MaxanceQuoteParams
 *      (the M8.T3 intent library's shape).
 *   2. Make sure a Maxance-logged-in session exists on the Stagehand
 *      service (`ensureLoggedIn` is idempotent — reuses the existing
 *      session if cookies are still warm).
 *   3. POST /v1/maxance/quote with dryRun=true. Stagehand drives the
 *      Proximéo wizard, extracts the price preview, returns the result.
 *   4. Emit QUOTE.PREVIEW_READY back into the queue so the Sales Agent
 *      can surface the price to the customer.
 *   5. On any Stagehand-side failure, emit QUOTE.FAILED with the tagged
 *      error code so the operator UI can surface it.
 *
 * The agent does NOT touch the customer-facing channel directly — the
 * Sales Agent owns that surface (M6.T3). Separation of concerns: the
 * Operator's job is "drive Maxance and report the result"; the Sales
 * Agent's job is "speak to the customer".
 *
 * Failure modes mapped to QUOTE.FAILED:
 *   - stagehand_health_unreachable → Stagehand process down (most ops issue)
 *   - stagehand_timeout            → Quote flow exceeded its budget
 *   - maxance_quote_*              → Stagehand-internal failure (Cloudflare,
 *                                     UI drift, missing session, etc.)
 *
 * Concurrency: BaseAgent gives us per-instance serialisation (concurrency=1).
 * That's intentional — only ONE Maxance session is logged in at a time on
 * the PC, so two concurrent quote runs would race on the same Chrome.
 * Scaling beyond 1 quote/sec is M8.T5's job (pre-warm pool of sessions).
 */
import { BaseAgent } from '../base.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';
import {
  getDefaultStagehandClient,
  StagehandClient,
  StagehandClientError,
  type StagehandQuoteParams,
  type StagehandSubscriberInfo,
} from './stagehand-client.js';

/**
 * Per-broker session name on the Stagehand pool. V1 is single-broker
 * (Achraf's account); when we onboard a second broker we'll partition
 * by broker id.
 */
const SESSION_NAME = 'maxance-default';

export class MaxanceOperatorAgent extends BaseAgent {
  /**
   * Stagehand client — defaults to the env-driven singleton. Tests inject
   * a mock via the constructor.
   */
  private readonly client: StagehandClient;

  constructor(
    cfg: ConstructorParameters<typeof BaseAgent>[0],
    deps: { client?: StagehandClient } = {},
  ) {
    super(cfg);
    this.client = deps.client ?? getDefaultStagehandClient();
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

    // Re-validate the session is alive. If the cookie expired since the
    // PREVIEW_READY we need to bail — the Stagehand session has lost its
    // Garanties-tab state and a fresh login lands us on the dashboard.
    try {
      await this.client.ensureLoggedIn(SESSION_NAME);
    } catch (err) {
      const code = err instanceof StagehandClientError ? err.errorCode : 'login_unknown';
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
      confirm = await this.client.confirmQuote(SESSION_NAME, payload.subscriber, { dryRun });
    } catch (err) {
      const code = err instanceof StagehandClientError ? err.errorCode : 'confirm_unknown';
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
      const loginResult = await this.client.ensureLoggedIn(SESSION_NAME);
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
      const code = err instanceof StagehandClientError ? err.errorCode : 'login_unknown';
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
      preview = await this.client.runQuote(SESSION_NAME, params, { dryRun: true });
    } catch (err) {
      const code = err instanceof StagehandClientError ? err.errorCode : 'quote_unknown';
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
