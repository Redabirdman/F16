import { describe, it, expect, vi } from 'vitest';
import {
  ensureSchema,
  ASSURYAL_PIPELINE_LABEL,
  __resetSchemaCacheForTests,
} from '../../../src/integrations/hubspot/schema.js';

/** The 7 Assuryal stage labels, in order — reused across fakes/assertions. */
const ASSURYAL_STAGES = [
  { id: 's-nouveau', label: 'Nouveau' },
  { id: 's-qualifie', label: 'Qualifié' },
  { id: 's-devis_en_cours', label: 'Devis en cours' },
  { id: 's-devis_envoye', label: 'Devis envoyé / Négociation' },
  { id: 's-attente_paiement', label: 'En attente paiement' },
  { id: 's-gagne', label: 'Gagné' },
  { id: 's-perdu', label: 'Perdu' },
];

function fakeClient(
  existingPipelines: Array<{
    id: string;
    label: string;
    stages: Array<{ id: string; label: string }>;
  }> = [],
) {
  return {
    ensureProperty: vi.fn().mockResolvedValue(undefined),
    listPipelines: vi.fn().mockResolvedValue(existingPipelines),
    createPipeline: vi.fn().mockResolvedValue({
      id: 'pipe-new',
      stages: ASSURYAL_STAGES,
    }),
    updatePipeline: vi.fn().mockResolvedValue({
      id: 'pipe-default',
      stages: ASSURYAL_STAGES,
    }),
  };
}

describe('ensureSchema', () => {
  it('creates all custom properties + the Assuryal pipeline when absent', async () => {
    __resetSchemaCacheForTests();
    const client = fakeClient([]);
    const res = await ensureSchema(client as never);
    // contact props (4) + deal props (7) = at least 11 ensureProperty calls
    expect(client.ensureProperty.mock.calls.length).toBeGreaterThanOrEqual(11);
    expect(client.createPipeline).toHaveBeenCalledOnce();
    expect(res.pipelineId).toBe('pipe-new');
    expect(res.stageIdByKey.nouveau).toBe('s-nouveau');
    expect(res.stageIdByKey.gagne).toBe('s-gagne');
  });

  it('reuses an existing Assuryal pipeline as-is (no create, no update)', async () => {
    __resetSchemaCacheForTests();
    const client = fakeClient([
      {
        id: 'pipe-existing',
        label: ASSURYAL_PIPELINE_LABEL,
        // Already has ALL the Assuryal stages → pure reuse, no update.
        stages: ASSURYAL_STAGES.map((s) => ({ id: `x-${s.id}`, label: s.label })),
      },
    ]);
    const res = await ensureSchema(client as never);
    expect(client.createPipeline).not.toHaveBeenCalled();
    expect(client.updatePipeline).not.toHaveBeenCalled();
    expect(res.pipelineId).toBe('pipe-existing');
    expect(res.stageIdByKey.nouveau).toBe('x-s-nouveau');
  });

  it('adopts the single default pipeline via updatePipeline (free tier)', async () => {
    __resetSchemaCacheForTests();
    // HubSpot free tier: one generic default pipeline with non-Assuryal stages.
    const client = fakeClient([
      {
        id: 'pipe-default',
        label: 'Sales Pipeline (default)',
        stages: [
          { id: 'gen-appointment', label: 'Appointment Scheduled' },
          { id: 'gen-closedwon', label: 'Closed Won' },
        ],
      },
    ]);
    const res = await ensureSchema(client as never);
    // Adopts (renames + overwrites stages) — NOT a fresh create.
    expect(client.createPipeline).not.toHaveBeenCalled();
    expect(client.updatePipeline).toHaveBeenCalledOnce();
    expect(client.updatePipeline).toHaveBeenCalledWith(
      'pipe-default',
      ASSURYAL_PIPELINE_LABEL,
      expect.any(Array),
    );
    expect(res.pipelineId).toBe('pipe-default');
    // stageIdByKey resolves from the updated (Assuryal-labelled) stages.
    expect(res.stageIdByKey.nouveau).toBe('s-nouveau');
    expect(res.stageIdByKey.gagne).toBe('s-gagne');
  });

  it('is cached — a second call does no API work', async () => {
    __resetSchemaCacheForTests();
    const client = fakeClient([]);
    await ensureSchema(client as never);
    const before = client.listPipelines.mock.calls.length;
    await ensureSchema(client as never);
    expect(client.listPipelines.mock.calls.length).toBe(before);
  });
});
