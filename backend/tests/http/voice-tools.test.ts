/**
 * Unit tests for the voice tool layer (src/http/voice-tools.ts) — focused on
 * the NEW `confirmer_devis` tool (2026-07-04, voice catch-up with the
 * 2026-07-02 sales overhaul).
 *
 * No DB, no Redis: the registry's `invokeTool` is mocked (voice executors are
 * pure adapters over the builtins), the builtins barrel is stubbed out so
 * importing voice-tools doesn't drag the whole tool tree in, and the drizzle
 * `db` is a minimal chainable fake for the single "latest quote" lookup.
 *
 * Covered:
 *   1. Schema shape of confirmer_devis in VOICE_TOOLS (OpenAI Realtime JSON).
 *   2. identite_manquante when the call has no lead/customer.
 *   3. devis_inexistant when the lead has no quote yet.
 *   4. Happy path — wires to quote.confirm (quoteId omitted, options mapped
 *      to garantiesAdditionnelles, civilité/adresse forwarded + persisted via
 *      customer.update_profile first).
 *   5. champs_manquants — quote.confirm's descriptive French error becomes a
 *      status the model can act on (ask, then retry) instead of a call error.
 *   6. Formule switch — a different formule than the parked quote re-runs
 *      quote.request with the stored formData and returns recalcul_en_cours.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- Mocks (declared before importing the module under test) ---------------
const invokeToolMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../../src/tools/registry.js', () => ({
  invokeTool: (...args: unknown[]) => invokeToolMock(...args),
}));
// voice-tools imports the builtins barrel for its registration side effect —
// stub it so this unit test doesn't load (and register) the real tool tree.
vi.mock('../../src/tools/builtins/index.js', () => ({}));
const appendAuditMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../../src/db/repositories/audit-log.js', () => ({
  appendAudit: (...args: unknown[]) => appendAuditMock(...args),
}));

import { handleVoiceTool, VOICE_TOOLS } from '../../src/http/voice-tools.js';
import type { Database } from '../../src/db/index.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const LEAD_ID = '22222222-2222-4222-8222-222222222222';
const QUOTE_ID = '33333333-3333-4333-8333-333333333333';

const CTX = { sipCallId: 'call-1', leadId: LEAD_ID, customerId: CUSTOMER_ID };

/** Minimal chainable fake for the `select().from().where().orderBy().limit()`
 *  latest-quote lookup. Every select resolves to the given rows. */
function fakeDb(rows: unknown[]): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return { select: () => chain } as unknown as Database;
}

const storedFormData = {
  vehicleKind: 'trottinette',
  purchasePriceEur: 350,
  purchaseDate: '2026-01-15',
  postalCode: '75001',
  stationnement: 'garage_box',
  clientDateOfBirth: '1990-06-12',
};

function dbWithLatestQuote(formData: Record<string, unknown> | null = storedFormData): Database {
  return fakeDb([{ id: QUOTE_ID, rawFormData: formData }]);
}

beforeEach(() => {
  invokeToolMock.mockReset();
  appendAuditMock.mockReset();
});

// ---------------------------------------------------------------------------
// 1. Schema shape
// ---------------------------------------------------------------------------
describe('confirmer_devis — OpenAI tool schema', () => {
  const tool = VOICE_TOOLS.find((t) => t.name === 'confirmer_devis');

  it('is declared in VOICE_TOOLS as a function tool', () => {
    expect(tool).toBeDefined();
    expect(tool!.type).toBe('function');
    expect(tool!.description).toContain('devis');
  });

  it('exposes formule/avec_options/civilite/adresse params, none required', () => {
    const params = tool!.parameters as {
      type: string;
      properties: Record<string, { type?: string; enum?: readonly string[] }>;
      required: readonly string[];
    };
    expect(params.type).toBe('object');
    expect(params.properties['formule']?.enum).toEqual([
      'tiers_illimite',
      'vol_incendie',
      'dommages_tous_accidents',
    ]);
    expect(params.properties['avec_options']?.type).toBe('boolean');
    expect(params.properties['civilite']?.enum).toEqual(['monsieur', 'madame']);
    expect(params.properties['adresse_ligne']?.type).toBe('string');
    expect(params.properties['code_postal']?.type).toBe('string');
    expect(params.properties['ville']?.type).toBe('string');
    expect(params.required).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2-6. Executor behavior
// ---------------------------------------------------------------------------
describe('confirmer_devis — executor', () => {
  it('returns identite_manquante when the call has no resolved lead/customer', async () => {
    const out = JSON.parse(
      await handleVoiceTool(dbWithLatestQuote(), { sipCallId: 'call-x' }, 'confirmer_devis', '{}'),
    ) as { statut: string };
    expect(out.statut).toBe('identite_manquante');
    expect(invokeToolMock).not.toHaveBeenCalled();
  });

  it('returns devis_inexistant when the lead has no quote yet', async () => {
    const out = JSON.parse(await handleVoiceTool(fakeDb([]), CTX, 'confirmer_devis', '{}')) as {
      statut: string;
      message: string;
    };
    expect(out.statut).toBe('devis_inexistant');
    expect(out.message).toContain('demander_devis');
    expect(invokeToolMock).not.toHaveBeenCalled();
  });

  it('happy path: calls quote.confirm (quoteId omitted) and reports devis_confirmé', async () => {
    invokeToolMock.mockResolvedValueOnce({ quoteId: QUOTE_ID, queued: true });
    const out = JSON.parse(
      await handleVoiceTool(
        dbWithLatestQuote(),
        CTX,
        'confirmer_devis',
        JSON.stringify({ formule: 'tiers_illimite', avec_options: true }),
      ),
    ) as { statut: string; reference: string; info: string };

    expect(out.statut).toBe('devis_confirmé');
    expect(out.reference).toBe(QUOTE_ID);
    expect(out.info).toContain('WhatsApp');
    expect(out.info).toContain('email');

    expect(invokeToolMock).toHaveBeenCalledTimes(1);
    const [toolCtx, name, input] = invokeToolMock.mock.calls[0]!;
    expect(name).toBe('quote.confirm');
    expect(toolCtx).toMatchObject({ agentRole: 'sales-agent', correlationId: LEAD_ID });
    expect(input).toMatchObject({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      garantiesAdditionnelles: { assistance: true, garantiePersonnelle: true },
    });
    // quoteId must be OMITTED — quote.confirm resolves the lead's latest quote.
    expect(input).not.toHaveProperty('quoteId');
  });

  it('does not pass garantiesAdditionnelles when avec_options is not true', async () => {
    invokeToolMock.mockResolvedValueOnce({ quoteId: QUOTE_ID, queued: true });
    await handleVoiceTool(dbWithLatestQuote(), CTX, 'confirmer_devis', '{}');
    const [, name, input] = invokeToolMock.mock.calls[0]!;
    expect(name).toBe('quote.confirm');
    expect(input).not.toHaveProperty('garantiesAdditionnelles');
  });

  it('persists a complete civilité+adresse via customer.update_profile BEFORE quote.confirm', async () => {
    invokeToolMock.mockResolvedValue({ updated: true, quoteId: QUOTE_ID, queued: true });
    await handleVoiceTool(
      dbWithLatestQuote(),
      CTX,
      'confirmer_devis',
      JSON.stringify({
        civilite: 'monsieur',
        adresse_ligne: '12 rue de la Paix',
        code_postal: '75002',
        ville: 'Paris',
      }),
    );
    expect(invokeToolMock).toHaveBeenCalledTimes(2);
    const [, firstName, firstInput] = invokeToolMock.mock.calls[0]!;
    expect(firstName).toBe('customer.update_profile');
    expect(firstInput).toMatchObject({
      customerId: CUSTOMER_ID,
      fields: {
        address: {
          line1: '12 rue de la Paix',
          postalCode: '75002',
          city: 'Paris',
          civilite: 'monsieur',
        },
      },
    });
    const [, secondName, secondInput] = invokeToolMock.mock.calls[1]!;
    expect(secondName).toBe('quote.confirm');
    expect(secondInput).toMatchObject({
      civilite: 'monsieur',
      addressLine: '12 rue de la Paix',
      postalCode: '75002',
      city: 'Paris',
    });
  });

  it('maps quote.confirm "Informations souscripteur manquantes" to champs_manquants', async () => {
    invokeToolMock.mockRejectedValueOnce(
      new Error(
        'Informations souscripteur manquantes pour le devis : civilite (monsieur/madame), ' +
          'addressLine (adresse). Demande-les au client puis rappelle quote.confirm en les passant en paramètres.',
      ),
    );
    const out = JSON.parse(
      await handleVoiceTool(dbWithLatestQuote(), CTX, 'confirmer_devis', '{}'),
    ) as { statut: string; details: string; message: string };
    expect(out.statut).toBe('champs_manquants');
    expect(out.details).toContain('civilite');
    expect(out.message).toContain('adresse postale');
  });

  it('other quote.confirm failures degrade to the generic French erreur status', async () => {
    invokeToolMock.mockRejectedValueOnce(new Error('boom'));
    const out = JSON.parse(
      await handleVoiceTool(dbWithLatestQuote(), CTX, 'confirmer_devis', '{}'),
    ) as { statut: string };
    expect(out.statut).toBe('erreur');
  });

  it('a DIFFERENT formule than the parked quote re-runs quote.request and returns recalcul_en_cours', async () => {
    invokeToolMock.mockResolvedValueOnce({ quoteId: 'new-quote', queued: true });
    const out = JSON.parse(
      await handleVoiceTool(
        dbWithLatestQuote(), // stored formData has no formule → tiers_illimite
        CTX,
        'confirmer_devis',
        JSON.stringify({ formule: 'dommages_tous_accidents', avec_options: true }),
      ),
    ) as { statut: string };

    expect(out.statut).toBe('recalcul_en_cours');
    expect(invokeToolMock).toHaveBeenCalledTimes(1);
    const [, name, input] = invokeToolMock.mock.calls[0]!;
    expect(name).toBe('quote.request');
    expect(input).toMatchObject({
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      formData: {
        ...storedFormData,
        formule: 'dommages_tous_accidents',
        garantiesAdditionnelles: { assistance: true, garantiePersonnelle: true },
      },
    });
  });

  it('the SAME formule as the parked quote goes straight to quote.confirm', async () => {
    invokeToolMock.mockResolvedValueOnce({ quoteId: QUOTE_ID, queued: true });
    const out = JSON.parse(
      await handleVoiceTool(
        dbWithLatestQuote({ ...storedFormData, formule: 'vol_incendie' }),
        CTX,
        'confirmer_devis',
        JSON.stringify({ formule: 'vol_incendie' }),
      ),
    ) as { statut: string };
    expect(out.statut).toBe('devis_confirmé');
    expect(invokeToolMock.mock.calls[0]![1]).toBe('quote.confirm');
  });
});
