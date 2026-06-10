/**
 * Idempotent self-provisioning of HubSpot custom properties + the Assuryal
 * deal pipeline. Resolved ids are cached for the process lifetime.
 *
 * Call `ensureSchema(client)` once at boot (or on first use). Subsequent
 * calls return the cached result without any API round-trips.
 *
 * Stage matching is done by label so the pipeline can be created in any
 * portal without hard-coded stage IDs.
 */
import type { HubSpotClient } from './client.js';
import type { StageKey } from './mirror-map.js';
import { logger } from '../../logger.js';

export const ASSURYAL_PIPELINE_LABEL = 'Assuryal';

export interface ResolvedSchema {
  pipelineId: string;
  stageIdByKey: Record<StageKey, string>;
}

const STAGES: Array<{
  key: StageKey;
  label: string;
  metadata: Record<string, string>;
}> = [
  { key: 'nouveau', label: 'Nouveau', metadata: { isClosed: 'false', probability: '0.1' } },
  { key: 'qualifie', label: 'Qualifié', metadata: { isClosed: 'false', probability: '0.3' } },
  {
    key: 'devis_en_cours',
    label: 'Devis en cours',
    metadata: { isClosed: 'false', probability: '0.5' },
  },
  {
    key: 'devis_envoye',
    label: 'Devis envoyé / Négociation',
    metadata: { isClosed: 'false', probability: '0.7' },
  },
  {
    key: 'attente_paiement',
    label: 'En attente paiement',
    metadata: { isClosed: 'false', probability: '0.9' },
  },
  { key: 'gagne', label: 'Gagné', metadata: { isClosed: 'true', probability: '1.0' } },
  { key: 'perdu', label: 'Perdu', metadata: { isClosed: 'true', probability: '0.0' } },
];

const CONTACT_PROPS: Array<{
  name: string;
  label: string;
  type: 'string' | 'number' | 'enumeration';
}> = [
  { name: 'f16_lead_id', label: 'F16 Lead ID', type: 'string' },
  { name: 'f16_source', label: 'F16 Source', type: 'string' },
  { name: 'f16_preferred_channel', label: 'F16 Canal préféré', type: 'string' },
  { name: 'f16_preferred_time', label: 'F16 Créneau préféré', type: 'string' },
];

const DEAL_PROPS: Array<{
  name: string;
  label: string;
  type: 'string' | 'number' | 'enumeration';
  options?: Array<{ label: string; value: string }>;
}> = [
  { name: 'product_line', label: 'Produit (F16)', type: 'string' },
  { name: 'f16_lead_id', label: 'F16 Lead ID', type: 'string' },
  { name: 'f16_lead_score', label: 'F16 Score', type: 'number' },
  { name: 'f16_vehicle', label: 'F16 Véhicule', type: 'string' },
  { name: 'f16_devis_number', label: 'F16 N° devis Maxance', type: 'string' },
  { name: 'f16_comptant_due', label: 'F16 Comptant (€)', type: 'number' },
  {
    name: 'f16_dormant',
    label: 'F16 Dormant',
    type: 'enumeration',
    options: [
      { label: 'Oui', value: 'true' },
      { label: 'Non', value: 'false' },
    ],
  },
];

let cache: ResolvedSchema | null = null;

/** Test-only: clear the module-level cache between test runs. */
export function __resetSchemaCacheForTests(): void {
  cache = null;
}

/**
 * Idempotently ensure all F16 custom properties and the Assuryal deal pipeline
 * exist in HubSpot. Caches the resolved pipeline + stage IDs for the process.
 */
export async function ensureSchema(client: HubSpotClient): Promise<ResolvedSchema> {
  if (cache) return cache;

  // 1. Ensure contact custom properties.
  for (const p of CONTACT_PROPS) {
    await client.ensureProperty('contacts', { ...p, groupName: 'contactinformation' });
  }

  // 2. Ensure deal custom properties.
  for (const p of DEAL_PROPS) {
    await client.ensureProperty('deals', { ...p, groupName: 'dealinformation' });
  }

  // 3. Pipeline — reuse the Assuryal pipeline if it already exists, else create.
  const pipelines = await client.listPipelines();
  const existing = pipelines.find((p) => p.label === ASSURYAL_PIPELINE_LABEL);

  let pipelineId: string;
  let stages: Array<{ id: string; label: string }>;

  if (existing) {
    pipelineId = existing.id;
    stages = existing.stages;
  } else {
    const created = await client.createPipeline(
      ASSURYAL_PIPELINE_LABEL,
      STAGES.map((s, i) => ({ label: s.label, displayOrder: i, metadata: s.metadata })),
    );
    pipelineId = created.id;
    stages = created.stages;
  }

  // 4. Resolve stage IDs by our stable key → label mapping.
  const stageIdByKey = {} as Record<StageKey, string>;
  for (const s of STAGES) {
    const match = stages.find((hs) => hs.label === s.label);
    if (match) stageIdByKey[s.key] = match.id;
  }

  // Surface a partial/failed label match — an unresolved stage key means deals
  // would be created with no stage. Visible, not silent.
  const missing = STAGES.filter((s) => !stageIdByKey[s.key]).map((s) => s.key);
  if (missing.length > 0) {
    logger.warn({ pipelineId, missing }, 'hubspot: some pipeline stages did not resolve by label');
  }

  cache = { pipelineId, stageIdByKey };
  logger.info(
    { pipelineId, stageCount: Object.keys(stageIdByKey).length },
    'hubspot: schema ensured',
  );
  return cache;
}
