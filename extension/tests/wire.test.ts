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

  // M8.T7 B2 — devis.resume command.
  it('accepts a devis.resume command with just a devisNumber', () => {
    const ok = CommandSchema.safeParse({
      id: UUID,
      kind: 'devis.resume',
      devisNumber: 'DR0000976146',
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a devis.resume command with garanties overrides', () => {
    const ok = CommandSchema.safeParse({
      id: UUID,
      kind: 'devis.resume',
      devisNumber: 'DR0000976146',
      formule: 'tiers_illimite',
      commissionPct: 22,
      fractionnement: 'mensuel',
      timeoutMs: 360000,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a devis.resume command missing the devisNumber', () => {
    const fail = CommandSchema.safeParse({ id: UUID, kind: 'devis.resume' });
    expect(fail.success).toBe(false);
  });

  // M8.T7 B3 — subscription.complete command.
  const sampleSubscription = {
    id: UUID,
    kind: 'subscription.complete' as const,
    devisNumber: 'DR0000976146',
    subscriber: { lastName: 'LEFRIEKH', firstName: 'Ridaa' },
    bank: {
      iban: 'FR7630006000011234567890189',
      bic: 'AGRIFRPP',
      accountHolder: 'Ridaa LEFRIEKH',
    },
    birthPlaceCity: 'Paris',
  };

  it('accepts a subscription.complete command and defaults dryRun=true + serial', () => {
    const parsed = CommandSchema.safeParse(sampleSubscription);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'subscription.complete') {
      expect(parsed.data.dryRun).toBe(true);
      expect(parsed.data.serialNumber).toBe('1234567');
    }
  });

  it('accepts subscription.complete with explicit dryRun=false + serial override', () => {
    const ok = CommandSchema.safeParse({
      ...sampleSubscription,
      dryRun: false,
      serialNumber: '7654321',
      timeoutMs: 360000,
    });
    expect(ok.success).toBe(true);
    if (ok.success && ok.data.kind === 'subscription.complete') {
      expect(ok.data.dryRun).toBe(false);
      expect(ok.data.serialNumber).toBe('7654321');
    }
  });

  it('rejects subscription.complete missing the bank block', () => {
    const fail = CommandSchema.safeParse({
      id: UUID,
      kind: 'subscription.complete',
      devisNumber: 'DR0000976146',
      subscriber: { lastName: 'X', firstName: 'Y' },
      birthPlaceCity: 'Paris',
    });
    expect(fail.success).toBe(false);
  });

  it('rejects subscription.complete with a too-short BIC', () => {
    const fail = CommandSchema.safeParse({
      ...sampleSubscription,
      bank: { ...sampleSubscription.bank, bic: 'AGRI' },
    });
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

  // M8.T7 B1 — Garanties comptant breakdown threading.
  it('accepts a quote.preview.ok carrying a comptantBreakdown', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'quote.preview.ok',
      pricePreviewEur: { monthly: 83.71, annual: 95.71 },
      comptantBreakdown: {
        fractionnement: 'mensuel',
        comptantEur: 21.58,
        termeSuivantEur: 7.97,
        coutAnnuelBrutEur: 95.71,
        fraisComptantEur: 17,
      },
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/x',
      durationMs: 1234,
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a comptantBreakdown with null fraisComptantEur (popup absent)', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'quote.preview.ok',
      pricePreviewEur: { monthly: 83.71 },
      comptantBreakdown: { fraisComptantEur: null },
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/x',
      durationMs: 1234,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a comptantBreakdown missing the required fraisComptantEur field', () => {
    const fail = ResponseSchema.safeParse({
      id: UUID,
      kind: 'quote.preview.ok',
      pricePreviewEur: { monthly: 83.71 },
      comptantBreakdown: { comptantEur: 21.58 },
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/x',
      durationMs: 1234,
    });
    expect(fail.success).toBe(false);
  });

  it('accepts a quote.confirm.ok carrying a comptantBreakdown (reserved for B2/B3)', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'quote.confirm.ok',
      devisNumber: 'DR0000973579',
      pdfSentTo: 'r.lefriekh@hotmail.com',
      comptantBreakdown: { fractionnement: 'annuel', fraisComptantEur: 17 },
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/souscriptionDevisValiderFinaleMoto.do',
      durationMs: 5678,
    });
    expect(ok.success).toBe(true);
  });

  it('round-trips a quote.preview.ok with breakdown through parseFrame', () => {
    const frame: Response = {
      id: UUID,
      kind: 'quote.preview.ok',
      pricePreviewEur: { monthly: 83.71 },
      comptantBreakdown: { fractionnement: 'mensuel', comptantEur: 21.58, fraisComptantEur: null },
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/x',
      durationMs: 1,
    };
    const parsed = parseFrame(JSON.stringify(frame));
    expect(parsed.side).toBe('response');
    if (parsed.side === 'response' && parsed.value.kind === 'quote.preview.ok') {
      expect(parsed.value.comptantBreakdown).toEqual(frame.comptantBreakdown);
    }
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

  // M8.T8 phase 2e — navigation-aware response variants.
  it('accepts a quote.preview.navigating response (mid-flow handoff)', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'quote.preview.navigating',
      fromScreen: 'vehicle_picker',
      expectedScreen: 'vehicule_tab',
      screenshots: [],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a quote.confirm.navigating response (mid-flow handoff)', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'quote.confirm.navigating',
      fromScreen: 'devis_tab_pre',
      expectedScreen: 'edition_imprimer',
      screenshots: [],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a quote.preview.navigating missing the fromScreen field', () => {
    const fail = ResponseSchema.safeParse({
      id: UUID,
      kind: 'quote.preview.navigating',
      expectedScreen: 'vehicule_tab',
      screenshots: [],
    });
    expect(fail.success).toBe(false);
  });

  // M8.T7 B2 — devis.resume responses.
  it('accepts a devis.resume.ok with prices + comptant breakdown', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'devis.resume.ok',
      devisNumber: 'DR0000976146',
      pricePreviewEur: { monthly: 83.71, annual: 95.71 },
      comptantBreakdown: {
        fractionnement: 'mensuel',
        comptantEur: 21.58,
        termeSuivantEur: 7.97,
        coutAnnuelBrutEur: 95.71,
        fraisComptantEur: 17,
      },
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/souscriptionNaviguerOngletVehicule.do',
      durationMs: 12345,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a devis.resume.ok missing the required comptantBreakdown', () => {
    const fail = ResponseSchema.safeParse({
      id: UUID,
      kind: 'devis.resume.ok',
      devisNumber: 'DR0000976146',
      pricePreviewEur: { monthly: 83.71 },
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/x',
      durationMs: 1,
    });
    expect(fail.success).toBe(false);
  });

  it('accepts a devis.resume.navigating response (mid-flow handoff)', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'devis.resume.navigating',
      fromScreen: 'visualisation',
      expectedScreen: 'reprise_vehicule',
      screenshots: [],
    });
    expect(ok.success).toBe(true);
  });

  it('round-trips a devis.resume.ok through parseFrame', () => {
    const frame: Response = {
      id: UUID,
      kind: 'devis.resume.ok',
      devisNumber: 'DR0000976146',
      pricePreviewEur: { monthly: 83.71 },
      comptantBreakdown: { fractionnement: 'mensuel', comptantEur: 21.58, fraisComptantEur: null },
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/x',
      durationMs: 1,
    };
    const parsed = parseFrame(JSON.stringify(frame));
    expect(parsed.side).toBe('response');
    if (parsed.side === 'response' && parsed.value.kind === 'devis.resume.ok') {
      expect(parsed.value.devisNumber).toBe('DR0000976146');
    }
  });

  // M8.T7 B3 — subscription.complete responses.
  it('accepts a dryRun subscription.complete.ok (stopped before valider, garanties comptant)', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'subscription.complete.ok',
      dryRun: true,
      stoppedBefore: 'valider_souscription',
      comptantBreakdown: null,
      garantiesComptant: { fractionnement: 'mensuel', comptantEur: 21.58, fraisComptantEur: 17 },
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/souscriptionNaviguerOngletVehicule.do',
      durationMs: 4321,
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a real-mode subscription.complete.ok at the Paiement page', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'subscription.complete.ok',
      dryRun: false,
      souscripteurRef: 'T123456789012',
      montantComptantEur: 52.04,
      souscripteurEmail: 'r.lefriekh@hotmail.com',
      comptantBreakdown: {
        fraisGestionEur: 30,
        commissionEur: 0.39,
        fraisDossierEur: 17,
        comptantDuEur: 52.04,
      },
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/souscriptionValiderFinaleMoto.do',
      durationMs: 23456,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects subscription.complete.ok missing the required comptantBreakdown key', () => {
    const fail = ResponseSchema.safeParse({
      id: UUID,
      kind: 'subscription.complete.ok',
      dryRun: true,
      screenshots: [],
      finalUrl: 'https://www.maxance.com/Proximeo/x',
      durationMs: 1,
    });
    expect(fail.success).toBe(false);
  });

  it('accepts a subscription.complete.navigating response', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'subscription.complete.navigating',
      fromScreen: 'bancaires',
      expectedScreen: 'paiement',
      screenshots: [],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts the rib_rejected error code on an error response', () => {
    const ok = ResponseSchema.safeParse({
      id: UUID,
      kind: 'error',
      errorCode: 'maxance_subscription_rib_rejected',
      detail: 'ALERTE: Prélèvement sur RIB de test non autorisé',
      screenshots: [],
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
