/**
 * Unit tests for the `quote.request` tool (Option A / M8.T8 follow-up).
 *
 * Two surfaces tested without touching DB or Redis:
 *   1. The pure `buildQuoteRequestedPayload` helper — pins the wire shape
 *      the Maxance Operator consumes (matches QuoteRequestedPayload from
 *      intents/quote.ts).
 *   2. The registered tool's INPUT schema — accept the happy-path, reject
 *      each malformed field. The handler itself (DB inserts + sendMessage)
 *      is covered by the integration test in tests/tools/builtins.test.ts
 *      when DB+Redis are available.
 */
import { describe, expect, it } from 'vitest';
import { buildQuoteRequestedPayload } from '../../src/tools/builtins/quote-request.js';
// Triggers tool registration as a side effect.
import '../../src/tools/index.js';
import { getTool } from '../../src/tools/registry.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const LEAD_ID = '22222222-2222-4222-8222-222222222222';

const validFormData = {
  vehicleKind: 'trottinette' as const,
  purchasePriceEur: 350,
  purchaseDate: '2026-01-15',
  postalCode: '75001',
  stationnement: 'garage_box' as const,
  clientDateOfBirth: '1990-06-12',
};

describe('buildQuoteRequestedPayload', () => {
  it('maps trottinette input to product=scooter + productVariant=trottinette', () => {
    const out = buildQuoteRequestedPayload({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: validFormData,
    });
    expect(out.product).toBe('scooter');
    expect(out.productVariant).toBe('trottinette');
  });

  it('carries the customerId + leadId verbatim', () => {
    const out = buildQuoteRequestedPayload({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: validFormData,
    });
    expect(out.customerId).toBe(CUSTOMER_ID);
    expect(out.leadId).toBe(LEAD_ID);
  });

  it('generates a fresh UUID per call', () => {
    const a = buildQuoteRequestedPayload({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: validFormData,
    });
    const b = buildQuoteRequestedPayload({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: validFormData,
    });
    expect(a.quoteId).not.toBe(b.quoteId);
    expect(a.quoteId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('forwards all formData fields including optional ones', () => {
    const formData = {
      ...validFormData,
      city: 'PARIS',
      formule: 'tiers_illimite' as const,
      commissionPct: 12,
      fractionnement: 'annuel' as const,
    };
    const out = buildQuoteRequestedPayload({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData,
    });
    expect(out.formData).toMatchObject({
      city: 'PARIS',
      formule: 'tiers_illimite',
      commissionPct: 12,
      fractionnement: 'annuel',
    });
  });
});

describe('quote.request — registered tool input schema', () => {
  const tool = getTool('quote.request');

  it('is registered on the tools registry barrel', () => {
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('quote.request');
  });

  it('accepts a valid trottinette quote request', () => {
    const res = tool!.inputSchema.safeParse({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: validFormData,
    });
    expect(res.success).toBe(true);
  });

  it('rejects a malformed postal code (4 digits)', () => {
    const res = tool!.inputSchema.safeParse({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: { ...validFormData, postalCode: '7501' },
    });
    expect(res.success).toBe(false);
  });

  it('rejects an unknown stationnement value', () => {
    const res = tool!.inputSchema.safeParse({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: { ...validFormData, stationnement: 'sous_voiture' },
    });
    expect(res.success).toBe(false);
  });

  it('rejects a vehicleKind other than trottinette (V1 scope)', () => {
    const res = tool!.inputSchema.safeParse({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: { ...validFormData, vehicleKind: 'auto' },
    });
    expect(res.success).toBe(false);
  });

  it('rejects a non-ISO date (DD/MM/YYYY)', () => {
    const res = tool!.inputSchema.safeParse({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: { ...validFormData, purchaseDate: '15/01/2026' },
    });
    expect(res.success).toBe(false);
  });

  it('rejects a non-UUID customerId', () => {
    const res = tool!.inputSchema.safeParse({
      customerId: 'not-a-uuid',
      leadId: LEAD_ID,
      formData: validFormData,
    });
    expect(res.success).toBe(false);
  });

  it('rejects a negative purchasePriceEur', () => {
    const res = tool!.inputSchema.safeParse({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: { ...validFormData, purchasePriceEur: -50 },
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown extra fields on the formData (strict)', () => {
    const res = tool!.inputSchema.safeParse({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: { ...validFormData, somethingExtra: 'foo' },
    });
    expect(res.success).toBe(false);
  });

  it('declares an outputSchema with quoteId + queued=true', () => {
    expect(tool!.outputSchema).toBeDefined();
    const ok = tool!.outputSchema!.safeParse({
      quoteId: '33333333-3333-4333-8333-333333333333',
      queued: true,
    });
    expect(ok.success).toBe(true);
    const bad = tool!.outputSchema!.safeParse({ quoteId: 'no', queued: true });
    expect(bad.success).toBe(false);
  });
});

describe('quote.request — wire shape parity with intents/quote.ts', () => {
  it("the payload's product field is one of the registered enum values", () => {
    const out = buildQuoteRequestedPayload({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: validFormData,
    });
    // QuoteRequestedPayload in intents/quote.ts: product: z.enum(['scooter', 'car']).
    expect(['scooter', 'car']).toContain(out.product);
  });

  it('the payload validates against the QUOTE.REQUESTED intent schema', async () => {
    // Sourcing the actual intent schema for the strongest possible round-trip.
    const { QuoteRequestedPayload } = await import('../../src/intents/quote.js');
    const out = buildQuoteRequestedPayload({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: validFormData,
    });
    const res = QuoteRequestedPayload.safeParse(out);
    expect(res.success).toBe(true);
  });
});
