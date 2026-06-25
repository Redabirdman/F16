/**
 * StripeClient unit tests (M8.T7 closing — design §5.4).
 *
 * Pure, no DB/network: the Stripe REST API is stubbed via the `fetchImpl`
 * injection seam. The secret key is a fake string; we NEVER hit api.stripe.com.
 *
 * Coverage:
 *   - createFraisPaymentLink mints a Price (correct unit_amount in cents) then
 *     a Payment Link referencing that price + metadata, for all three formules.
 *   - amount floors at 0 when frais comptant >= total.
 *   - errors are wrapped and NEVER leak the secret key.
 */
import { describe, it, expect } from 'vitest';
import {
  StripeClient,
  StripeApiError,
  getStripeClientFromEnv,
} from '../../../src/integrations/stripe/client.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Build a fetch stub from a per-call responder. Records every call. */
function stubFetch(
  responder: (call: RecordedCall, n: number) => { status: number; body: unknown },
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? String(init.body) : null,
    };
    calls.push(call);
    const { status, body } = responder(call, calls.length);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Default happy-path responder: first call -> price, second -> payment link. */
function happyResponder() {
  return (call: RecordedCall) => {
    if (call.url.endsWith('/prices')) {
      return { status: 200, body: { id: 'price_test_1', object: 'price' } };
    }
    if (call.url.endsWith('/payment_links')) {
      return {
        status: 200,
        body: {
          id: 'plink_test_1',
          object: 'payment_link',
          url: 'https://buy.stripe.com/test_abc123',
        },
      };
    }
    return { status: 404, body: { error: { message: 'not found' } } };
  };
}

/** Decode a form-encoded body into a key->value map. */
function parseForm(body: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body) return out;
  for (const [k, v] of new URLSearchParams(body).entries()) out[k] = v;
  return out;
}

describe('StripeClient.createFraisPaymentLink', () => {
  it('tiers_illimite: 50 - 17 = 33.00 -> unit_amount 3300, then links the price + metadata', async () => {
    const { fetchImpl, calls } = stubFetch(happyResponder());
    const client = new StripeClient({ secretKey: 'sk_test_FAKE', fetchImpl });

    const out = await client.createFraisPaymentLink({
      quoteId: 'Q1',
      customerId: 'C1',
      formule: 'tiers_illimite',
      fraisComptantEur: 17,
    });

    expect(out).toEqual({
      url: 'https://buy.stripe.com/test_abc123',
      paymentLinkId: 'plink_test_1',
      amountEur: 33,
    });

    expect(calls).toHaveLength(2);

    // 1. Price call.
    const priceCall = calls[0]!;
    expect(priceCall.method).toBe('POST');
    expect(priceCall.url).toMatch(/\/prices$/);
    expect(priceCall.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const priceForm = parseForm(priceCall.body);
    expect(priceForm.unit_amount).toBe('3300');
    expect(priceForm.currency).toBe('eur');
    expect(priceForm['product_data[name]']).toContain('tiers_illimite');

    // 2. Payment-link call references the returned price + carries metadata.
    const linkCall = calls[1]!;
    expect(linkCall.method).toBe('POST');
    expect(linkCall.url).toMatch(/\/payment_links$/);
    const linkForm = parseForm(linkCall.body);
    expect(linkForm['line_items[0][price]']).toBe('price_test_1');
    expect(linkForm['line_items[0][quantity]']).toBe('1');
    expect(linkForm['metadata[quoteId]']).toBe('Q1');
    expect(linkForm['metadata[customerId]']).toBe('C1');
  });

  it('vol_incendie: 60 - 17 = 43.00 -> unit_amount 4300', async () => {
    const { fetchImpl, calls } = stubFetch(happyResponder());
    const client = new StripeClient({ secretKey: 'sk_test_FAKE', fetchImpl });

    const out = await client.createFraisPaymentLink({
      quoteId: 'Q2',
      customerId: 'C2',
      formule: 'vol_incendie',
      fraisComptantEur: 17,
    });

    expect(out.amountEur).toBe(43);
    expect(parseForm(calls[0]!.body).unit_amount).toBe('4300');
  });

  it('dommages_tous_accidents: 65 - 17 = 48.00 -> unit_amount 4800', async () => {
    const { fetchImpl, calls } = stubFetch(happyResponder());
    const client = new StripeClient({ secretKey: 'sk_test_FAKE', fetchImpl });

    const out = await client.createFraisPaymentLink({
      quoteId: 'Q3',
      customerId: 'C3',
      formule: 'dommages_tous_accidents',
      fraisComptantEur: 17,
    });

    expect(out.amountEur).toBe(48);
    expect(parseForm(calls[0]!.body).unit_amount).toBe('4800');
  });

  it('floors at 0 when frais comptant >= total -> unit_amount 0', async () => {
    const { fetchImpl, calls } = stubFetch(happyResponder());
    const client = new StripeClient({ secretKey: 'sk_test_FAKE', fetchImpl });

    const out = await client.createFraisPaymentLink({
      quoteId: 'Q4',
      customerId: 'C4',
      formule: 'tiers_illimite',
      fraisComptantEur: 80, // > 50 total
    });

    expect(out.amountEur).toBe(0);
    expect(parseForm(calls[0]!.body).unit_amount).toBe('0');
  });

  it('wraps a Stripe API error without leaking the secret key', async () => {
    const secret = 'sk_test_SUPER_SECRET_KEY';
    const { fetchImpl } = stubFetch(() => ({
      status: 401,
      body: { error: { type: 'invalid_request_error', code: 'api_key_invalid', message: 'bad' } },
    }));
    const client = new StripeClient({ secretKey: secret, fetchImpl });

    let caught: unknown;
    try {
      await client.createFraisPaymentLink({
        quoteId: 'Q5',
        customerId: 'C5',
        formule: 'tiers_illimite',
        fraisComptantEur: 17,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StripeApiError);
    const e = caught as StripeApiError;
    expect(e.status).toBe(401);
    expect(e.code).toBe('api_key_invalid');
    // The secret key must never appear in the error message.
    expect(e.message).not.toContain(secret);
  });
});

describe('getStripeClientFromEnv', () => {
  it('returns null when STRIPE_SECRET_KEY is unset', () => {
    expect(getStripeClientFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns a StripeClient when STRIPE_SECRET_KEY is set', () => {
    const client = getStripeClientFromEnv({
      STRIPE_SECRET_KEY: 'sk_test_FAKE',
    } as unknown as NodeJS.ProcessEnv);
    expect(client).toBeInstanceOf(StripeClient);
  });
});
