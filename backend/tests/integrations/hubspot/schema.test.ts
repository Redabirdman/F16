import { describe, it, expect, vi } from 'vitest';
import {
  ensureSchema,
  ASSURYAL_PIPELINE_LABEL,
  __resetSchemaCacheForTests,
} from '../../../src/integrations/hubspot/schema.js';

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
      stages: [
        { id: 's-nouveau', label: 'Nouveau' },
        { id: 's-qualifie', label: 'Qualifié' },
        { id: 's-devis_en_cours', label: 'Devis en cours' },
        { id: 's-devis_envoye', label: 'Devis envoyé / Négociation' },
        { id: 's-attente_paiement', label: 'En attente paiement' },
        { id: 's-gagne', label: 'Gagné' },
        { id: 's-perdu', label: 'Perdu' },
      ],
    }),
  };
}

describe('ensureSchema', () => {
  it('creates all custom properties + the Assuryal pipeline when absent', async () => {
    __resetSchemaCacheForTests();
    const client = fakeClient([]);
    const res = await ensureSchema(client as never);
    // contact props (4) + deal props (6) = at least 10 ensureProperty calls
    expect(client.ensureProperty.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(client.createPipeline).toHaveBeenCalledOnce();
    expect(res.pipelineId).toBe('pipe-new');
    expect(res.stageIdByKey.nouveau).toBe('s-nouveau');
    expect(res.stageIdByKey.gagne).toBe('s-gagne');
  });

  it('reuses an existing Assuryal pipeline (no create)', async () => {
    __resetSchemaCacheForTests();
    const client = fakeClient([
      {
        id: 'pipe-existing',
        label: ASSURYAL_PIPELINE_LABEL,
        stages: [
          { id: 'x-nouveau', label: 'Nouveau' },
          { id: 'x-gagne', label: 'Gagné' },
        ],
      },
    ]);
    const res = await ensureSchema(client as never);
    expect(client.createPipeline).not.toHaveBeenCalled();
    expect(res.pipelineId).toBe('pipe-existing');
    expect(res.stageIdByKey.nouveau).toBe('x-nouveau');
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
