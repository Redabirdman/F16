/**
 * Stripe REST client (M8.T7 closing — design §5.4).
 *
 * Minimal wrapper over the Stripe REST API, scoped to ONE job: mint a Payment
 * Link that collects Assuryal's share of the frais de dossier (the total for
 * the formule minus the "frais comptant" portion Maxance already collects in
 * the prélèvement). Speaks Stripe's form-encoded API, knows nothing about
 * BullMQ / drizzle / quote semantics — those live in the maxance-operator.
 *
 * Auth:
 *   - `Authorization: Bearer <secretKey>` on every call. The secret key is
 *     passed in via constructor (never read from env here) so tests can swap
 *     it; the env-gated factory `getStripeClientFromEnv()` is the boot seam.
 *
 * PII / secret discipline:
 *   - The secret key is NEVER logged and NEVER included in a thrown error.
 *     Stripe's own error replies don't echo the key, but we additionally wrap
 *     every failure in `StripeApiError` carrying only method + path + status +
 *     a short, sanitized message — no headers, no key.
 *
 * Payment-link mechanics (two Stripe calls, both form-encoded):
 *   1. POST /v1/prices with inline `product_data[name]`, `unit_amount` (cents),
 *      `currency` → returns a one-off Price id.
 *   2. POST /v1/payment_links with `line_items[0][price]=<priceId>`,
 *      `line_items[0][quantity]=1`, and `metadata[quoteId]/[customerId]` →
 *      returns the hosted `url` the customer pays at.
 */
import { computeAssuryalFrais, type Formule } from '../../agents/maxance-operator/frais.js';
import { logger } from '../../logger.js';

const DEFAULT_BASE_URL = 'https://api.stripe.com/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
/** Stripe error bodies are small JSON; cap to keep logs/errors bounded + secret-safe. */
const ERROR_BODY_PREFIX_LEN = 200;

export interface StripeClientOptions {
  /** Stripe secret key (sk_live_… / sk_test_…). NEVER logged. */
  secretKey: string;
  /** Default https://api.stripe.com/v1 — overridden for the test stub. */
  baseUrl?: string;
  /** Injection point for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface CreateFraisPaymentLinkInput {
  /** F16 quote id — round-trips back via the webhook metadata. */
  quoteId: string;
  /** F16 customer id — round-trips back via the webhook metadata. */
  customerId: string;
  /** Drives the frais total (50 / 60 / 65 €). */
  formule: Formule;
  /** "frais comptant" portion Maxance collects, read live from the portal. */
  fraisComptantEur: number;
  /** ISO-4217 lowercase code; Stripe wants lowercase. Defaults to 'eur'. */
  currency?: string;
}

export interface CreateFraisPaymentLinkOutput {
  /** Hosted Stripe Payment Link the customer pays at. */
  url: string;
  /** Stripe Payment Link id (plink_…) — persisted for reconciliation. */
  paymentLinkId: string;
  /** The amount the link charges, in EUR (== Assuryal's frais share). */
  amountEur: number;
}

interface StripeErrorBody {
  error?: { message?: string; type?: string; code?: string };
}

/**
 * Wraps any Stripe failure. Carries method + path + status + a short,
 * sanitized message. The secret key is structurally absent — we only ever
 * build this from Stripe's response body (which never contains the key) and
 * the request path (which never contains the key).
 */
export class StripeApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(opts: {
    method: string;
    path: string;
    status: number;
    body: string;
    code?: string | null;
  }) {
    const prefix = opts.body.slice(0, ERROR_BODY_PREFIX_LEN);
    super(`Stripe ${opts.method} ${opts.path} -> ${opts.status}: ${prefix}`);
    this.name = 'StripeApiError';
    this.status = opts.status;
    this.code = opts.code ?? null;
  }
}

export class StripeClient {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: StripeClientOptions) {
    if (!opts.secretKey) {
      throw new Error('StripeClient: secretKey is required');
    }
    this.secretKey = opts.secretKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Create a Payment Link for Assuryal's frais share.
   *
   * amountEur = computeAssuryalFrais(formule, fraisComptantEur) — floored at 0,
   * 2dp. Charged amount in cents = Math.round(amountEur * 100).
   *
   * Two Stripe calls: a one-off Price (inline product), then the Payment Link
   * referencing that price + metadata for webhook reconciliation.
   */
  async createFraisPaymentLink(
    input: CreateFraisPaymentLinkInput,
  ): Promise<CreateFraisPaymentLinkOutput> {
    if (!input.quoteId) throw new Error('createFraisPaymentLink: quoteId is required');
    if (!input.customerId) throw new Error('createFraisPaymentLink: customerId is required');

    const currency = (input.currency ?? 'eur').toLowerCase();
    // Throws on a non-finite / negative fraisComptant (scrape bug) — that's
    // intentional and predates this client (frais.ts).
    const amountEur = computeAssuryalFrais(input.formule, input.fraisComptantEur);
    const unitAmount = Math.round(amountEur * 100);

    // 1. One-off Price with an inline product.
    const priceBody = new URLSearchParams();
    priceBody.set('unit_amount', String(unitAmount));
    priceBody.set('currency', currency);
    priceBody.set('product_data[name]', `Frais de dossier Assuryal (${input.formule})`);
    const price = await this.request<{ id?: string }>('POST', '/prices', priceBody);
    if (!price.id) throw new Error('Stripe createFraisPaymentLink: no price id in response');

    // 2. Payment Link referencing that price + metadata for reconciliation.
    const linkBody = new URLSearchParams();
    linkBody.set('line_items[0][price]', price.id);
    linkBody.set('line_items[0][quantity]', '1');
    linkBody.set('metadata[quoteId]', input.quoteId);
    linkBody.set('metadata[customerId]', input.customerId);
    const link = await this.request<{ id?: string; url?: string }>(
      'POST',
      '/payment_links',
      linkBody,
    );
    if (!link.id || !link.url) {
      throw new Error('Stripe createFraisPaymentLink: no payment link id/url in response');
    }

    logger.info(
      { quoteId: input.quoteId, paymentLinkId: link.id, amountEur },
      'stripe: frais payment link created',
    );
    return { url: link.url, paymentLinkId: link.id, amountEur };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * One form-encoded request. Returns parsed JSON. Throws `StripeApiError` on
   * any non-2xx — sanitized, never carrying the secret key.
   */
  private async request<T>(method: string, path: string, body: URLSearchParams): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      // Network-layer failure. Sanitize: message only, never the key/headers.
      const detail = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Stripe ${method} ${path} network error: ${detail}`);
    }

    const text = await this.safeReadText(res);
    if (res.status >= 200 && res.status < 300) {
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return {} as T;
      }
    }

    const code = this.tryParseErrorCode(text);
    throw new StripeApiError({ method, path, status: res.status, body: text, code });
  }

  private async safeReadText(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      return '';
    }
  }

  /** Best-effort pull of Stripe's `error.code` for logs. Failing leaves it null. */
  private tryParseErrorCode(text: string): string | null {
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as StripeErrorBody;
      return parsed.error?.code ?? parsed.error?.type ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * Env-gated factory. Returns a `StripeClient` when `STRIPE_SECRET_KEY` is set,
 * `null` otherwise — mirroring how `channels/bootstrap.ts` registers a channel
 * only when its config var is present. Callers treat `null` as "Stripe
 * feature off" (design §5.4: SUBSCRIPTION.READY still emits with a null link +
 * human-action fallback).
 *
 * The secret key is read here and passed in; it is never logged.
 */
export function getStripeClientFromEnv(env: NodeJS.ProcessEnv = process.env): StripeClient | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  return new StripeClient({ secretKey });
}
