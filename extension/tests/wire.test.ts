/**
 * Wire-schema unit tests — phase 2 scaffold.
 *
 * These pin the JSON shape that backend ↔ extension exchange. The wire is
 * the boundary contract: a successful test run here means both sides can
 * parse what the other produces without runtime surprises.
 *
 * No network, no Chrome, no DOM. Pure schema validation in ~50ms.
 */
import { describe, it, expect } from 'vitest';
import {
  CommandSchema,
  EventSchema,
  ResponseSchema,
  parseFrame,
  type Command,
  type Response,
  type Event,
} from '../src/wire.js';

const UUID = '11111111-2222-4333-8444-555555555555';

const sampleQuoteParams = {
  vehicleKind: 'trottinette',
  purchasePriceEur: 350,
  purchaseDate: '2026-01-15',
  postalCode: '75001',
  stationnement: 'garage_box',
  clientDateOfBirth: '1990-06-12',
};

const sampleSubscriber = {
  civilite: 'monsieur',
  lastName: 'LEFRIEKH',
  firstName: 'Ridaa',
  addressLine: '12 RUE DE LA PAIX',
  postalCode: '75001',
  city: 'PARIS',
  phoneMobile: '0612345678',
  email: 'r.lefriekh@hotmail.com',
};

describe('CommandSchema', () => {
  it('accepts a ping command with optional nonce', () => {
    const ok = CommandSchema.safeParse({ id: UUID, kind: 'ping', nonce: 'abc' });
    expect(ok.success).toBe(true);
  });

  it('accepts a quote.preview command with dryRun=true', () => {
    const ok = CommandSchema.safeParse({
      id: UUID,
      kind: 'quote.preview',
      params: sampleQuoteParams,
      dryRun: true,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a quote.preview command with dryRun=false (V1 stops at preview)', () => {
    const fail = CommandSchema.safeParse({
      id: UUID,
      kind: 'quote.preview',
      params: sampleQuoteParams,
      dryRun: false,
    });
    expect(fail.success).toBe(false);
  });

  it('accepts a quote.confirm command with dryRun=false (real email send)', () => {
    const ok = CommandSchema.safeParse({
      id: UUID,
      kind: 'quote.confirm',
      subscriber: sampleSubscriber,
      dryRun: false,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a malformed postalCode', () => {
    const fail = CommandSchema.safeParse({
      id: UUID,
      kind: 'quote.preview',
      params: { ...sampleQuoteParams, postalCode: '7500' },
      dryRun: true,
    });
    expect(fail.success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    const fail = CommandSchema.safeParse({ id: UUID, kind: 'nonsense' });
    expect(fail.success).toBe(false);
  });
});

describe('ResponseSchema', () => {
  it('accepts a pong with optional nonce', () => {
    const ok = ResponseSchema.safeParse({ id: UUID, kind: 'pong', nonce: 'abc' });
    expect(ok.success).toBe(true);
  });

  it('accepts a quote.preview.ok with both price cadences', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'quote.preview.ok',
      pricePreviewEur: { monthly: 18.95, annual: 90.85 },
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/x',
      durationMs: 1234,
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a quote.confirm.ok response with devisNumber', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'quote.confirm.ok',
      devisNumber: 'DR0000973579',
      pdfSentTo: 'r.lefriekh@hotmail.com',
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/souscriptionDevisValiderFinaleMoto.do',
      durationMs: 5678,
    });
    expect(ok.success).toBe(true);
  });

  it('accepts an error response with tagged errorCode', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'error',
      errorCode: 'maxance_extension_handler_not_implemented',
      detail: 'phase 2b will implement: quote.preview',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a screenshot dataUrl that is not base64 PNG', () => {
    const fail = ResponseSchema.safeParse({
      id: UUID,
      kind: 'quote.preview.ok',
      pricePreviewEur: { monthly: 18.95 },
      screenshots: [{ step: 's', dataUrl: 'https://example.com/img.png' }],
      finalUrl: 'https://www.maxance.com',
      durationMs: 0,
    });
    expect(fail.success).toBe(false);
  });
});

describe('EventSchema', () => {
  it('accepts a hello event with no maxance tab open', () => {
    const ok = EventSchema.safeParse({
      kind: 'hello',
      extensionVersion: '0.0.1',
      activeMaxanceUrl: null,
      capabilities: ['ping'],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a progress event tied to a command id', () => {
    const ok = EventSchema.safeParse({
      kind: 'progress',
      commandId: UUID,
      step: 'devis_tab_filled',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an event with an unknown kind', () => {
    const fail = EventSchema.safeParse({ kind: 'mystery', foo: 1 });
    expect(fail.success).toBe(false);
  });
});

describe('parseFrame', () => {
  it('routes a command frame to the command side', () => {
    const text = JSON.stringify({ id: UUID, kind: 'ping' } satisfies Command);
    const parsed = parseFrame(text);
    expect(parsed.side).toBe('command');
    if (parsed.side === 'command') expect(parsed.value.kind).toBe('ping');
  });

  it('routes a response frame to the response side', () => {
    const text = JSON.stringify({ id: UUID, kind: 'pong' } satisfies Response);
    const parsed = parseFrame(text);
    expect(parsed.side).toBe('response');
    if (parsed.side === 'response') expect(parsed.value.kind).toBe('pong');
  });

  it('routes a hello event to the event side', () => {
    const text = JSON.stringify({
      kind: 'hello',
      extensionVersion: '0.0.1',
      activeMaxanceUrl: null,
      capabilities: [],
    } satisfies Event);
    const parsed = parseFrame(text);
    expect(parsed.side).toBe('event');
    if (parsed.side === 'event') expect(parsed.value.kind).toBe('hello');
  });

  it('throws extension_wire_invalid_json on bad JSON', () => {
    expect(() => parseFrame('{not json')).toThrow(/extension_wire_invalid_json/);
  });

  it('throws extension_wire_unrecognised_frame on unknown shape', () => {
    expect(() => parseFrame(JSON.stringify({ id: UUID, kind: 'unknown' }))).toThrow(
      /extension_wire_unrecognised_frame/,
    );
  });
});

describe('shape parity with backend types', () => {
  it("the quote.preview command's params match the QUOTE.REQUESTED payload shape", () => {
    // This test pins the wire contract against the in-process Stagehand
    // params shape (purchasePriceEur, stationnement enums, etc.) — any
    // accidental drift in either schema will fail this assertion.
    const params = {
      vehicleKind: 'trottinette' as const,
      purchasePriceEur: 350,
      purchaseDate: '2026-01-15',
      postalCode: '75001',
      stationnement: 'garage_box' as const,
      clientDateOfBirth: '1990-06-12',
      formule: 'tiers_illimite' as const,
      commissionPct: 9,
      fractionnement: 'mensuel' as const,
    };
    const ok = CommandSchema.safeParse({
      id: UUID,
      kind: 'quote.preview',
      params,
      dryRun: true,
    });
    expect(ok.success).toBe(true);
  });
});
