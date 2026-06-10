# HubSpot Rich Mirror — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the create-once HubSpot dual-write into a live mirror of F16's full lead state — rich Contact + Deal, self-provisioned custom properties + an Assuryal pipeline, and deal stage/value updates on every lifecycle transition.

**Architecture:** F16 → HubSpot, one-directional + idempotent. A pure mapping layer (`mirror-map.ts`) turns `(lead, customer, latestQuote)` into HubSpot props; a self-provisioner (`schema.ts`) creates properties + the Assuryal pipeline on boot; `reconcileLead(leadId)` upserts Contact + Deal (create-or-update); a `setLeadStatus()` repo helper emits `LEAD.SYNC_HUBSPOT` so the existing `hubspot-sync` worker reconciles on every transition.

**Tech Stack:** Node 22 + TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Drizzle, BullMQ, vitest. HubSpot CRM v3/v4 REST via `HubSpotClient` (Bearer `HUBSPOT_API_KEY`). Spec: `docs/superpowers/specs/2026-06-10-hubspot-rich-mirror-design.md`.

**Conventions (must follow):**

- All pnpm from `Assuryal/F16/backend/`. Commits: conventional, **lowercase subject**, scope **backend**; end body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Husky auto-runs eslint+prettier on staged files.
- TS strict: explicit return types, no `any`, no unused; guard every array index (`noUncheckedIndexedAccess`); for optional props use conditional spread (`...(x !== undefined ? { k: x } : {})`) — `exactOptionalPropertyTypes` is on.
- Tests: `pnpm test` (vitest). **DB-gated tests use the THROWAWAY DB** `postgres://f16:f16@127.0.0.1:5435/f16_test` — NEVER prod `f16`. Pure tests need no DB.
- Backend run for live-verify (Bash bg, NOT PowerShell): `env -u ANTHROPIC_API_KEY PORT=3001 npx tsx src/index.ts`. HubSpot key already in `.env`.
- PII discipline: never log email/phone/name; ids + booleans only.

---

## File Structure

| File                                                    | Responsibility                                                                                                                             | Status      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `backend/src/integrations/hubspot/mirror-map.ts`        | PURE: `stageKeyForStatus`, `buildContactProps`, `buildDealProps`, `parseAddress`, `vehicleLabel`. No IO.                                   | new         |
| `backend/src/integrations/hubspot/schema.ts`            | `ensureSchema(client)` — idempotently create custom properties + the Assuryal pipeline; resolve + cache `{pipelineId, stageIdByKey}`.      | new         |
| `backend/src/integrations/hubspot/client.ts`            | Add `ensureProperty`, `listPipelines`, `createPipeline`, `updateDeal`, `updateContact`.                                                    | modify      |
| `backend/src/integrations/hubspot/dual-write.ts`        | Generalize `handleLeadNew` → `reconcileLead(opts, leadId)` (create-or-update, rich props, stage); worker also handles `LEAD.SYNC_HUBSPOT`. | modify      |
| `backend/src/integrations/hubspot/index.ts`             | Export the new surface.                                                                                                                    | modify      |
| `backend/src/db/repositories/leads.ts`                  | `setLeadStatus(db, leadId, status, deps?)` — update status + emit `LEAD.SYNC_HUBSPOT`.                                                     | new (P2)    |
| `backend/src/db/repositories/quotes.ts`                 | `getLatestQuoteForLead(db, leadId)`.                                                                                                       | modify      |
| Various agents (sales/engagement/supervisor/maxance)    | Route `leads.status` writes through `setLeadStatus`; emit sync on quote-ready/dormant.                                                     | modify (P2) |
| `backend/tests/integrations/hubspot/mirror-map.test.ts` | Pure mapping tests.                                                                                                                        | new         |
| `backend/tests/integrations/hubspot/schema.test.ts`     | `ensureSchema` with a mocked client.                                                                                                       | new         |
| `backend/tests/integrations/hubspot/reconcile.test.ts`  | `reconcileLead` create→update idempotency (DB-gated, `f16_test`).                                                                          | new         |

---

## PHASE 1 — Rich snapshot + self-provisioning

_Demo at end: inject a lead → a rich Deal (value, vehicle, score, preferences) + Contact appear in a self-created **Assuryal** pipeline at stage **Nouveau**._

### Task 1.1: Pure mapping layer — `mirror-map.ts` (TDD)

**Files:**

- Create: `backend/src/integrations/hubspot/mirror-map.ts`
- Test: `backend/tests/integrations/hubspot/mirror-map.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/integrations/hubspot/mirror-map.test.ts
import { describe, it, expect } from 'vitest';
import {
  stageKeyForStatus,
  buildContactProps,
  buildDealProps,
  type MirrorInput,
} from '../../../src/integrations/hubspot/mirror-map.js';

function base(): MirrorInput {
  return {
    lead: {
      id: 'lead-1',
      status: 'new',
      source: 'meta',
      productLine: 'scooter',
      score: 80,
      preferredChannel: 'call',
      preferredTime: 'matin',
    },
    customer: {
      fullName: 'Achraf Mortady',
      email: 'a@example.fr',
      phone: '+33612345678',
      address: JSON.stringify({
        line1: '12 Rue de la Roquette',
        city: 'Paris',
        postalCode: '75011',
      }),
      vehicle: { brand: 'Xiaomi', model: 'Pro 2' },
    },
    latestQuote: null,
  };
}

describe('stageKeyForStatus', () => {
  it('maps each lead status to a stage key', () => {
    expect(stageKeyForStatus('new')).toBe('nouveau');
    expect(stageKeyForStatus('scored')).toBe('nouveau');
    expect(stageKeyForStatus('qualifying')).toBe('qualifie');
    expect(stageKeyForStatus('quoting')).toBe('devis_en_cours');
    expect(stageKeyForStatus('negotiating')).toBe('devis_envoye');
    expect(stageKeyForStatus('awaiting_payment')).toBe('attente_paiement');
    expect(stageKeyForStatus('closed_won')).toBe('gagne');
    expect(stageKeyForStatus('closed_lost')).toBe('perdu');
  });
  it('returns null for dormant (leave stage unchanged)', () => {
    expect(stageKeyForStatus('dormant')).toBeNull();
  });
});

describe('buildContactProps', () => {
  it('splits name + maps address + f16 fields, omitting missing', () => {
    const p = buildContactProps(base());
    expect(p.firstname).toBe('Achraf');
    expect(p.lastname).toBe('Mortady');
    expect(p.email).toBe('a@example.fr');
    expect(p.phone).toBe('+33612345678');
    expect(p.address).toBe('12 Rue de la Roquette');
    expect(p.city).toBe('Paris');
    expect(p.zip).toBe('75011');
    expect(p.f16_lead_id).toBe('lead-1');
    expect(p.f16_source).toBe('meta');
    expect(p.f16_preferred_channel).toBe('call');
    expect(p.f16_preferred_time).toBe('matin');
  });
  it('omits keys with no value (never sends empty strings)', () => {
    const input = base();
    input.customer.address = null;
    input.customer.phone = null;
    const p = buildContactProps(input);
    expect('address' in p).toBe(false);
    expect('city' in p).toBe(false);
    expect('phone' in p).toBe(false);
  });
});

describe('buildDealProps', () => {
  it('builds deal name + f16 fields; amount omitted with no quote', () => {
    const p = buildDealProps(base());
    expect(p.dealname).toBe('Trottinette — Achraf Mortady');
    expect(p.product_line).toBe('scooter');
    expect(p.f16_lead_id).toBe('lead-1');
    expect(p.f16_lead_score).toBe(80);
    expect(p.f16_vehicle).toBe('Xiaomi Pro 2');
    expect(p.f16_dormant).toBe('false');
    expect('amount' in p).toBe(false);
  });
  it('fills amount + comptant + devis number from the latest quote', () => {
    const input = base();
    input.latestQuote = {
      status: 'ready',
      monthlyPremium: '78.85',
      comptantDue: '90.85',
      maxanceDevisNumber: 'DR0000973638',
      productVariant: 'tiers',
    };
    const p = buildDealProps(input);
    expect(p.amount).toBe(78.85);
    expect(p.f16_comptant_due).toBe(90.85);
    expect(p.f16_devis_number).toBe('DR0000973638');
  });
  it('sets f16_dormant true when status is dormant', () => {
    const input = base();
    input.lead.status = 'dormant';
    expect(buildDealProps(input).f16_dormant).toBe('true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Assuryal/F16/backend && pnpm test -- mirror-map`
Expected: FAIL ("Cannot find module '.../mirror-map.js'").

- [ ] **Step 3: Implement `mirror-map.ts`**

```ts
// backend/src/integrations/hubspot/mirror-map.ts
// Pure F16 → HubSpot property mapping. No IO, no logging of PII.

export type LeadStatus =
  | 'new'
  | 'scored'
  | 'qualifying'
  | 'quoting'
  | 'negotiating'
  | 'awaiting_payment'
  | 'closed_won'
  | 'closed_lost'
  | 'dormant';

export type StageKey =
  | 'nouveau'
  | 'qualifie'
  | 'devis_en_cours'
  | 'devis_envoye'
  | 'attente_paiement'
  | 'gagne'
  | 'perdu';

export interface MirrorInput {
  lead: {
    id: string;
    status: LeadStatus;
    source: string;
    productLine: 'scooter' | 'car';
    score: number | null;
    preferredChannel: 'whatsapp' | 'call' | null;
    preferredTime: string | null;
  };
  customer: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    address: string | null; // decrypted JSON string
    vehicle: unknown; // jsonb
  };
  latestQuote: {
    status: string;
    monthlyPremium: string | null;
    comptantDue: string | null;
    maxanceDevisNumber: string | null;
    productVariant: string;
  } | null;
}

const STATUS_TO_STAGE: Record<LeadStatus, StageKey | null> = {
  new: 'nouveau',
  scored: 'nouveau',
  qualifying: 'qualifie',
  quoting: 'devis_en_cours',
  negotiating: 'devis_envoye',
  awaiting_payment: 'attente_paiement',
  closed_won: 'gagne',
  closed_lost: 'perdu',
  dormant: null, // leave stage unchanged
};

export function stageKeyForStatus(status: LeadStatus): StageKey | null {
  return STATUS_TO_STAGE[status];
}

function parseAddress(raw: string | null): { address?: string; city?: string; zip?: string } {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const out: { address?: string; city?: string; zip?: string } = {};
    const line = j.line1 ?? j.address ?? j.street;
    const city = j.city ?? j.ville;
    const zip = j.postalCode ?? j.zip ?? j.codePostal;
    if (typeof line === 'string' && line.trim()) out.address = line.trim();
    if (typeof city === 'string' && city.trim()) out.city = city.trim();
    if (typeof zip === 'string' && zip.trim()) out.zip = zip.trim();
    return out;
  } catch {
    return {};
  }
}

function vehicleLabel(vehicle: unknown): string | undefined {
  if (!vehicle || typeof vehicle !== 'object') return undefined;
  const v = vehicle as Record<string, unknown>;
  const parts = [v.brand, v.model].filter(
    (x): x is string => typeof x === 'string' && x.trim() !== '',
  );
  if (parts.length > 0) return parts.join(' ');
  const single = v.label ?? v.name ?? v.model;
  return typeof single === 'string' && single.trim() ? single.trim() : undefined;
}

function splitName(fullName: string | null): { firstName?: string; lastName?: string } {
  const trimmed = (fullName ?? '').trim();
  if (!trimmed) return {};
  const [first, ...rest] = trimmed.split(/\s+/).filter(Boolean);
  const out: { firstName?: string; lastName?: string } = {};
  if (first) out.firstName = first;
  if (rest.length > 0) out.lastName = rest.join(' ');
  return out;
}

export function buildContactProps(input: MirrorInput): Record<string, string> {
  const { lead, customer } = input;
  const name = splitName(customer.fullName);
  const addr = parseAddress(customer.address);
  const p: Record<string, string> = {
    f16_lead_id: lead.id,
    f16_source: lead.source,
  };
  if (name.firstName) p.firstname = name.firstName;
  if (name.lastName) p.lastname = name.lastName;
  if (customer.email) p.email = customer.email;
  if (customer.phone) p.phone = customer.phone;
  if (addr.address) p.address = addr.address;
  if (addr.city) p.city = addr.city;
  if (addr.zip) p.zip = addr.zip;
  if (lead.preferredChannel) p.f16_preferred_channel = lead.preferredChannel;
  if (lead.preferredTime) p.f16_preferred_time = lead.preferredTime;
  return p;
}

export function buildDealProps(input: MirrorInput): Record<string, string | number> {
  const { lead, customer, latestQuote } = input;
  const product = lead.productLine === 'scooter' ? 'Trottinette' : 'Auto';
  const subject = (customer.fullName && customer.fullName.trim()) || customer.email || 'Lead';
  const p: Record<string, string | number> = {
    dealname: `${product} — ${subject}`,
    product_line: lead.productLine,
    f16_lead_id: lead.id,
    f16_dormant: lead.status === 'dormant' ? 'true' : 'false',
  };
  if (typeof lead.score === 'number') p.f16_lead_score = lead.score;
  const veh = vehicleLabel(customer.vehicle);
  if (veh) p.f16_vehicle = veh;
  if (latestQuote) {
    const monthly = latestQuote.monthlyPremium != null ? Number(latestQuote.monthlyPremium) : NaN;
    const comptant = latestQuote.comptantDue != null ? Number(latestQuote.comptantDue) : NaN;
    if (Number.isFinite(monthly)) p.amount = monthly;
    if (Number.isFinite(comptant)) p.f16_comptant_due = comptant;
    if (latestQuote.maxanceDevisNumber) p.f16_devis_number = latestQuote.maxanceDevisNumber;
  }
  return p;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Assuryal/F16/backend && pnpm test -- mirror-map`
Expected: PASS (all mapping tests green).

- [ ] **Step 5: Commit**

```bash
git add backend/src/integrations/hubspot/mirror-map.ts backend/tests/integrations/hubspot/mirror-map.test.ts
git commit -m "feat(backend): hubspot pure mirror-map (f16 → crm props)"
```

---

### Task 1.2: Client additions — properties, pipelines, updates

**Files:**

- Modify: `backend/src/integrations/hubspot/client.ts`

> The client centralizes every HubSpot endpoint. `request<T>(method, path, body)` already exists (private) and throws `HubSpotApiError`. Add the methods below as public methods on `HubSpotClient`. Use `null` body for GET.

- [ ] **Step 1: Add the methods** (paste before the closing `}` of `class HubSpotClient`)

```ts
  /** Idempotently ensure a custom property exists on an object type. */
  async ensureProperty(
    objectType: 'contacts' | 'deals',
    prop: { name: string; label: string; type: 'string' | 'number' | 'enumeration'; groupName: string; options?: Array<{ label: string; value: string }> },
  ): Promise<void> {
    try {
      await this.request<unknown>('GET', `/crm/v3/properties/${objectType}/${encodeURIComponent(prop.name)}`, null);
      return; // already exists
    } catch (err) {
      if (!(err instanceof HubSpotApiError) || err.status !== 404) throw err;
    }
    const fieldType = prop.type === 'number' ? 'number' : prop.type === 'enumeration' ? 'select' : 'text';
    const body: Record<string, unknown> = {
      name: prop.name,
      label: prop.label,
      type: prop.type,
      fieldType,
      groupName: prop.groupName,
    };
    if (prop.options) body.options = prop.options;
    try {
      await this.request<unknown>('POST', `/crm/v3/properties/${objectType}`, body);
    } catch (err) {
      // A concurrent create (or pre-existing) → treat "already exists" as success.
      if (err instanceof HubSpotApiError && (err.status === 409 || /already exists/i.test(err.message))) return;
      throw err;
    }
  }

  /** List all deal pipelines. */
  async listPipelines(): Promise<Array<{ id: string; label: string; stages: Array<{ id: string; label: string }> }>> {
    const json = await this.request<{ results?: Array<{ id: string; label: string; stages?: Array<{ id: string; label: string }> }> }>(
      'GET',
      '/crm/v3/pipelines/deals',
      null,
    );
    return (json.results ?? []).map((p) => ({ id: p.id, label: p.label, stages: p.stages ?? [] }));
  }

  /** Create a deal pipeline with the given stages. Returns the created pipeline. */
  async createPipeline(
    label: string,
    stages: Array<{ label: string; displayOrder: number; metadata: Record<string, string> }>,
  ): Promise<{ id: string; stages: Array<{ id: string; label: string }> }> {
    const json = await this.request<{ id?: string; stages?: Array<{ id: string; label: string }> }>(
      'POST',
      '/crm/v3/pipelines/deals',
      { label, displayOrder: 99, stages },
    );
    if (!json.id) throw new Error('HubSpot createPipeline: no id in response');
    return { id: json.id, stages: json.stages ?? [] };
  }

  /** PATCH deal properties. */
  async updateDeal(dealId: string, properties: Record<string, string | number>): Promise<void> {
    await this.request<unknown>('PATCH', `/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties });
  }

  /** PATCH contact properties. */
  async updateContact(contactId: string, properties: Record<string, string>): Promise<void> {
    await this.request<unknown>('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, { properties });
  }
```

- [ ] **Step 2: Typecheck**

Run: `cd Assuryal/F16/backend && pnpm typecheck`
Expected: PASS. (If `request` rejects a `PATCH` method type, widen its `method` param to `string` — it's already `string`.)

- [ ] **Step 3: Commit**

```bash
git add backend/src/integrations/hubspot/client.ts
git commit -m "feat(backend): hubspot client property/pipeline/update methods"
```

---

### Task 1.3: Self-provisioner — `schema.ts` (TDD with a mocked client)

**Files:**

- Create: `backend/src/integrations/hubspot/schema.ts`
- Test: `backend/tests/integrations/hubspot/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/integrations/hubspot/schema.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Assuryal/F16/backend && pnpm test -- hubspot/schema`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `schema.ts`**

```ts
// backend/src/integrations/hubspot/schema.ts
// Idempotent self-provisioning of HubSpot custom properties + the Assuryal
// deal pipeline. Resolved ids are cached for the process.
import type { HubSpotClient } from './client.js';
import type { StageKey } from './mirror-map.js';
import { logger } from '../../logger.js';

export const ASSURYAL_PIPELINE_LABEL = 'Assuryal';

export interface ResolvedSchema {
  pipelineId: string;
  stageIdByKey: Record<StageKey, string>;
}

const STAGES: Array<{ key: StageKey; label: string; metadata: Record<string, string> }> = [
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

const CONTACT_PROPS = [
  { name: 'f16_lead_id', label: 'F16 Lead ID', type: 'string' as const },
  { name: 'f16_source', label: 'F16 Source', type: 'string' as const },
  { name: 'f16_preferred_channel', label: 'F16 Canal préféré', type: 'string' as const },
  { name: 'f16_preferred_time', label: 'F16 Créneau préféré', type: 'string' as const },
];
const DEAL_PROPS = [
  { name: 'product_line', label: 'Produit (F16)', type: 'string' as const },
  { name: 'f16_lead_id', label: 'F16 Lead ID', type: 'string' as const },
  { name: 'f16_lead_score', label: 'F16 Score', type: 'number' as const },
  { name: 'f16_vehicle', label: 'F16 Véhicule', type: 'string' as const },
  { name: 'f16_devis_number', label: 'F16 N° devis Maxance', type: 'string' as const },
  { name: 'f16_comptant_due', label: 'F16 Comptant (€)', type: 'number' as const },
  {
    name: 'f16_dormant',
    label: 'F16 Dormant',
    type: 'enumeration' as const,
    options: [
      { label: 'Oui', value: 'true' },
      { label: 'Non', value: 'false' },
    ],
  },
];

let cache: ResolvedSchema | null = null;

/** Test-only: clear the module cache. */
export function __resetSchemaCacheForTests(): void {
  cache = null;
}

export async function ensureSchema(client: HubSpotClient): Promise<ResolvedSchema> {
  if (cache) return cache;

  // 1. Properties (idempotent).
  for (const p of CONTACT_PROPS) {
    await client.ensureProperty('contacts', { ...p, groupName: 'contactinformation' });
  }
  for (const p of DEAL_PROPS) {
    await client.ensureProperty('deals', { ...p, groupName: 'dealinformation' });
  }

  // 2. Pipeline — reuse if a pipeline labelled 'Assuryal' exists, else create.
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

  // 3. Resolve stage ids by our stable keys (match on label).
  const stageIdByKey = {} as Record<StageKey, string>;
  for (const s of STAGES) {
    const match = stages.find((hs) => hs.label === s.label);
    if (match) stageIdByKey[s.key] = match.id;
  }

  cache = { pipelineId, stageIdByKey };
  logger.info({ pipelineId, stages: Object.keys(stageIdByKey).length }, 'hubspot: schema ensured');
  return cache;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Assuryal/F16/backend && pnpm test -- hubspot/schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/integrations/hubspot/schema.ts backend/tests/integrations/hubspot/schema.test.ts
git commit -m "feat(backend): hubspot self-provisioned schema + assuryal pipeline"
```

---

### Task 1.4: `getLatestQuoteForLead` repo helper

**Files:**

- Modify: `backend/src/db/repositories/quotes.ts`

- [ ] **Step 1: Add the helper** (append to `quotes.ts`, mirroring the file's existing import + style — `quotes` table, `eq`, `desc`)

```ts
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../index.js';
import { quotes } from '../schema/index.js';

/** Newest quote for a lead, or null. Used by the HubSpot mirror for value. */
export async function getLatestQuoteForLead(db: Database, leadId: string) {
  const [row] = await db
    .select()
    .from(quotes)
    .where(eq(quotes.leadId, leadId))
    .orderBy(desc(quotes.requestedAt))
    .limit(1);
  return row ?? null;
}
```

> If `quotes.ts` already imports `eq`/`desc`/`quotes`/`Database`, don't duplicate the imports — add only the function. Confirm the timestamp column name (`requestedAt` / `createdAt`) by reading `db/schema/quotes.ts`; use whichever exists for ordering.

- [ ] **Step 2: Typecheck + commit**

Run: `cd Assuryal/F16/backend && pnpm typecheck`
Expected: PASS.

```bash
git add backend/src/db/repositories/quotes.ts
git commit -m "feat(backend): getLatestQuoteForLead repo helper"
```

---

### Task 1.5: Generalize `dual-write.ts` → `reconcileLead`

**Files:**

- Modify: `backend/src/integrations/hubspot/dual-write.ts`
- Modify: `backend/src/integrations/hubspot/index.ts`

- [ ] **Step 1: Refactor `handleLeadNew` into `reconcileLead`**

In `dual-write.ts`:

1. Add imports:

```ts
import { ensureSchema } from './schema.js';
import {
  buildContactProps,
  buildDealProps,
  stageKeyForStatus,
  type MirrorInput,
} from './mirror-map.js';
import { getLatestQuoteForLead } from '../../db/repositories/quotes.js';
```

2. Replace the body of `handleLeadNew` so it delegates to a new `reconcileLead`, and make the worker accept both intents. Keep the existing guards (no customer / no email / decrypt) and the `callWithPropertyDegrade` helper.

Replace the existing `startHubSpotSyncWorker` handler + `handleLeadNew` with:

```ts
export function startHubSpotSyncWorker(opts: HubSpotSyncWorkerOptions): Worker {
  return consume({
    db: opts.db,
    queue: 'lead',
    role: 'hubspot-sync',
    handler: async (envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> => {
      if (envelope.intent !== 'LEAD.NEW' && envelope.intent !== 'LEAD.SYNC_HUBSPOT') {
        return { ok: true, result: { skipped: 'wrong-intent' } };
      }
      const payload = envelope.payload as { leadId: string };
      return reconcileLead(opts, payload.leadId);
    },
  });
}

/** Back-compat shim for existing tests/callers. */
export async function handleLeadNew(
  opts: HubSpotSyncWorkerOptions,
  env: AgentMessageEnvelope,
): Promise<MessageHandlerResult> {
  if (env.intent !== 'LEAD.NEW' && env.intent !== 'LEAD.SYNC_HUBSPOT') {
    return { ok: true, result: { skipped: 'wrong-intent' } };
  }
  const payload = env.payload as { leadId: string };
  return reconcileLead(opts, payload.leadId);
}

/**
 * Reconcile a lead's full state into HubSpot (create-or-update). Idempotent.
 */
export async function reconcileLead(
  opts: HubSpotSyncWorkerOptions,
  leadId: string,
): Promise<MessageHandlerResult> {
  const [lead] = await opts.db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return { ok: false, error: `Lead ${leadId} not found` };
  if (!lead.customerId) return { ok: true, result: { skipped: 'no-customer' } };

  const [customerRow] = await opts.db
    .select()
    .from(customers)
    .where(eq(customers.id, lead.customerId))
    .limit(1);
  if (!customerRow) return { ok: false, error: `Customer ${lead.customerId} not found` };

  const email = decryptPII(customerRow.email);
  if (!email) return { ok: true, result: { skipped: 'no-email' } };
  const phone = decryptPII(customerRow.phone);
  const fullName = decryptPII(customerRow.fullName);
  const address = customerRow.address ? decryptPII(customerRow.address) : null;

  const latestQuote = await getLatestQuoteForLead(opts.db, lead.id);

  const schema = await ensureSchema(opts.client);

  const mirror: MirrorInput = {
    lead: {
      id: lead.id,
      status: lead.status as MirrorInput['lead']['status'],
      source: lead.source,
      productLine: lead.productLine as 'scooter' | 'car',
      score: lead.score ?? null,
      preferredChannel: (lead.preferredChannel as 'whatsapp' | 'call' | null) ?? null,
      preferredTime: (lead.contactWindow as string | null) ?? null,
    },
    customer: {
      fullName,
      email,
      phone,
      address,
      vehicle: customerRow.vehicle ?? null,
    },
    latestQuote: latestQuote
      ? {
          status: latestQuote.status,
          monthlyPremium: latestQuote.monthlyPremium ?? null,
          comptantDue: latestQuote.comptantDue ?? null,
          maxanceDevisNumber: latestQuote.maxanceDevisNumber ?? null,
          productVariant: latestQuote.productVariant,
        }
      : null,
  };

  // Contact (degrade-on-missing-property retained).
  const contactProps = buildContactProps(mirror);
  const contact = await callWithPropertyDegrade(
    (props) =>
      opts.client.upsertContact({
        email,
        ...(contactProps.firstname ? { firstName: contactProps.firstname } : {}),
        ...(contactProps.lastname ? { lastName: contactProps.lastname } : {}),
        ...(phone ? { phone } : {}),
        properties: props,
      }),
    contactProps,
    { leadId: lead.id, op: 'upsertContact' },
  );

  // Deal props + stage.
  const dealProps = buildDealProps(mirror);
  const stageKey = stageKeyForStatus(mirror.lead.status);
  const stageId = stageKey ? schema.stageIdByKey[stageKey] : undefined;

  if (!lead.hubspotDealId) {
    const deal = await callWithPropertyDegrade(
      (props) =>
        opts.client.createDeal({
          dealName: String(dealProps.dealname),
          pipeline: schema.pipelineId,
          ...(stageId ? { dealStage: stageId } : {}),
          productLine: mirror.lead.productLine,
          properties: props,
        }),
      dealProps,
      { leadId: lead.id, op: 'createDeal' },
    );
    await opts.client.associateContactDeal(contact.hubspotContactId, deal.hubspotDealId);
    await opts.db
      .update(leads)
      .set({ hubspotDealId: deal.hubspotDealId, updatedAt: new Date() })
      .where(eq(leads.id, lead.id));
    logger.info(
      { leadId: lead.id, hubspotDealId: deal.hubspotDealId },
      'hubspot-sync: lead created',
    );
    return { ok: true, result: { created: true, hubspotDealId: deal.hubspotDealId } };
  }

  // Update path.
  const updateProps: Record<string, string | number> = { ...dealProps };
  if (stageId) updateProps.dealstage = stageId;
  await callWithPropertyDegrade(
    async (props) => {
      await opts.client.updateDeal(lead.hubspotDealId as string, props);
      return null;
    },
    updateProps,
    { leadId: lead.id, op: 'updateDeal' },
  );
  logger.info({ leadId: lead.id, hubspotDealId: lead.hubspotDealId }, 'hubspot-sync: lead updated');
  return { ok: true, result: { updated: true, hubspotDealId: lead.hubspotDealId } };
}
```

> Notes: `callWithPropertyDegrade<T>` already exists — its generic works for the update path's `Promise<null>`. Confirm `lead.contactWindow` is the column for preferred time (read `db/schema/leads.ts`); if it's named `preferredTime`, use that. `createDeal` already accepts `pipeline`+`dealStage` (Task 1.2 / existing) — pass the resolved Assuryal ids.

- [ ] **Step 2: Export `reconcileLead` from `index.ts`**

Add `reconcileLead` to the `dual-write.js` export block in `integrations/hubspot/index.ts`.

- [ ] **Step 3: Typecheck + lint + run existing hubspot tests**

Run: `cd Assuryal/F16/backend && pnpm typecheck && pnpm lint && pnpm test -- hubspot`
Expected: PASS (existing dual-write tests still pass via the shim + new mapping/schema tests green). Fix any test that asserted the old "create-only" shape to accept create-or-update.

- [ ] **Step 4: Commit**

```bash
git add backend/src/integrations/hubspot/dual-write.ts backend/src/integrations/hubspot/index.ts
git commit -m "feat(backend): hubspot reconcileLead create-or-update with rich props + stage"
```

---

### Task 1.6: Reconcile idempotency test (DB-gated, throwaway DB)

**Files:**

- Create: `backend/tests/integrations/hubspot/reconcile.test.ts`

- [ ] **Step 1: Write the test** (mirror an existing DB-gated hubspot test's harness — seed a customer + lead, run reconcile twice with a fake client capturing calls, assert create-then-update)

```ts
// backend/tests/integrations/hubspot/reconcile.test.ts
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { reconcileLead } from '../../../src/integrations/hubspot/dual-write.js';
import { __resetSchemaCacheForTests } from '../../../src/integrations/hubspot/schema.js';
// Reuse the project's DB-gated test harness for seeding (createTestDb / seedCustomer
// / insertLead) — match the imports used by the existing hubspot dual-write test.

const RUN = Boolean(process.env.DATABASE_URL); // DB-gated; throwaway f16_test only

function fakeClient() {
  return {
    ensureProperty: vi.fn().mockResolvedValue(undefined),
    listPipelines: vi.fn().mockResolvedValue([]),
    createPipeline: vi.fn().mockResolvedValue({
      id: 'pipe',
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
    upsertContact: vi.fn().mockResolvedValue({ hubspotContactId: 'c1', isNew: true }),
    createDeal: vi.fn().mockResolvedValue({ hubspotDealId: 'd1' }),
    associateContactDeal: vi.fn().mockResolvedValue(undefined),
    updateDeal: vi.fn().mockResolvedValue(undefined),
    updateContact: vi.fn().mockResolvedValue(undefined),
  };
}

describe.runIf(RUN)('reconcileLead (DB-gated)', () => {
  beforeAll(() => __resetSchemaCacheForTests());

  it('creates on first run, updates (no second create) on second run', async () => {
    // ... seed a customer with email + a lead (status 'new') using the project harness;
    //     obtain { db, leadId }.
    const client = fakeClient();
    const first = await reconcileLead({ db, client } as never, leadId);
    expect((first.result as { created?: boolean }).created).toBe(true);
    expect(client.createDeal).toHaveBeenCalledOnce();

    const second = await reconcileLead({ db, client } as never, leadId);
    expect((second.result as { updated?: boolean }).updated).toBe(true);
    expect(client.createDeal).toHaveBeenCalledOnce(); // still once
    expect(client.updateDeal).toHaveBeenCalledOnce();
  });
});
```

> Fill the seed section using the SAME helpers the existing `dual-write` DB test uses (read it first). Keep the fake client; the point is DB idempotency (hubspot_deal_id write-back gating create-vs-update), not HTTP.

- [ ] **Step 2: Run (throwaway DB)**

Run: `cd Assuryal/F16/backend && DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16_test pnpm test -- hubspot/reconcile`
Expected: PASS (create then update).

- [ ] **Step 3: Commit**

```bash
git add backend/tests/integrations/hubspot/reconcile.test.ts
git commit -m "test(backend): hubspot reconcile idempotency (create then update)"
```

---

### ✅ Phase 1 live-verify (Ridaa's HubSpot)

- [ ] Restart backend: `cd Assuryal/F16/backend && env -u ANTHROPIC_API_KEY PORT=3001 npx tsx src/index.ts` (Bash bg).
- [ ] Confirm boot log `hubspot: schema ensured` + the **Assuryal** pipeline now exists in HubSpot (Settings → Objects → Deals → Pipelines).
- [ ] Inject a test lead (the `scripts/.tmp-test-lead.ts` pattern, unique test email) → verify in HubSpot: a Contact with name/phone/address/source/channel/time + a Deal **in the Assuryal pipeline at Nouveau** with product/vehicle/score (+ amount once a quote exists).
- [ ] Clean up the test contact+deal after. Log `hubspot-mirror-P1-DONE` to ruflo.

---

## PHASE 2 — Live lifecycle (stage + value on every transition)

_Demo at end: drive a lead new→qualifying→quoting→quote-ready→won and watch the HubSpot deal move stages + fill value live._

### Task 2.1: `setLeadStatus` repo helper that emits the sync

**Files:**

- Create: `backend/src/db/repositories/leads.ts`
- Test: `backend/tests/db/repositories/leads.test.ts`

- [ ] **Step 1: Write the failing test** (DB-gated; assert status updated + a `LEAD.SYNC_HUBSPOT` agent_message row emitted)

```ts
// backend/tests/db/repositories/leads.test.ts
import { describe, it, expect } from 'vitest';
import { setLeadStatus } from '../../../src/db/repositories/leads.js';
// reuse the project DB harness to seed a lead; assert leads.status changed
// and an agent_messages row with intent 'LEAD.SYNC_HUBSPOT' toRole 'hubspot-sync' exists.

const RUN = Boolean(process.env.DATABASE_URL);
describe.runIf(RUN)('setLeadStatus', () => {
  it('updates status and enqueues a hubspot sync', async () => {
    // seed { db, leadId } with status 'new'
    await setLeadStatus(db, leadId, 'qualifying');
    // assert leads.status === 'qualifying'
    // assert an agent_messages row: intent 'LEAD.SYNC_HUBSPOT', to_role 'hubspot-sync', payload.leadId === leadId
  });
});
```

- [ ] **Step 2: Implement `leads.ts`**

```ts
// backend/src/db/repositories/leads.ts
import { eq } from 'drizzle-orm';
import type { Database } from '../index.js';
import { leads } from '../schema/index.js';
import { sendMessage } from '../../messaging/dispatcher.js';

type LeadStatus =
  | 'new'
  | 'scored'
  | 'qualifying'
  | 'quoting'
  | 'negotiating'
  | 'awaiting_payment'
  | 'closed_won'
  | 'closed_lost'
  | 'dormant';

/**
 * Update a lead's status AND mirror it to HubSpot. The single chokepoint for
 * status writes so every transition reflects in the CRM. The sync is fire-and
 * -forget on the `lead` queue (idempotent reconcile); a HubSpot hiccup never
 * blocks the status write.
 */
export async function setLeadStatus(
  db: Database,
  leadId: string,
  status: LeadStatus,
): Promise<void> {
  await db.update(leads).set({ status, updatedAt: new Date() }).where(eq(leads.id, leadId));
  await emitHubSpotSync(db, leadId);
}

/** Emit a HubSpot reconcile request for a lead (idempotent worker-side). */
export async function emitHubSpotSync(db: Database, leadId: string): Promise<void> {
  if (!process.env.HUBSPOT_API_KEY) return; // no-op when integration off
  try {
    await sendMessage(
      { db },
      {
        fromRole: 'system',
        toRole: 'hubspot-sync',
        intent: 'LEAD.SYNC_HUBSPOT',
        payload: { leadId },
        correlationId: leadId,
      },
    );
  } catch {
    // non-blocking — the next transition (or a manual replay) will reconcile.
  }
}
```

- [ ] **Step 3: Run (throwaway DB) + commit**

Run: `cd Assuryal/F16/backend && DATABASE_URL=postgres://f16:f16@127.0.0.1:5435/f16_test pnpm test -- repositories/leads`
Expected: PASS.

```bash
git add backend/src/db/repositories/leads.ts backend/tests/db/repositories/leads.test.ts
git commit -m "feat(backend): setLeadStatus repo helper emits hubspot sync"
```

---

### Task 2.2: Route lead-status writes through `setLeadStatus`

**Files:** Modify each site that writes `leads.status` directly:
`agents/sales-agent/agent.ts`, `agents/engagement-agent/agent.ts`, `agents/supervisor-agent/agent.ts`, `agents/maxance-operator/control-plane.ts`, `admin/human-actions.ts` (only where it transitions lead status), `agents/ads-manager-agent/approval.ts` (if it sets lead status).

- [ ] **Step 1: Find every direct status write**

Run: `cd Assuryal/F16/backend && grep -rn "leads.status\|\.set({ status\|\.set({status" src --include=*.ts | grep -v repositories/leads.ts | grep -v test`
For each hit that updates a `leads` row's `status`, replace the inline `db.update(leads).set({ status, ... })` with `await setLeadStatus(db, leadId, '<status>')` (import from `../../db/repositories/leads.js`). If the same update sets OTHER columns too, keep those in a separate `db.update` and call `setLeadStatus` for the status (or extend `setLeadStatus` is out of scope — keep it status-only).

- [ ] **Step 2: Typecheck + lint + full test**

Run: `cd Assuryal/F16/backend && pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS (deterministic suite green; live-Anthropic e2e excluded per `pnpm test` vs `pnpm test:live`).

- [ ] **Step 3: Commit**

```bash
git add -A backend/src/agents backend/src/admin
git commit -m "refactor(backend): route lead-status writes through setLeadStatus"
```

---

### Task 2.3: Quote + dormant hooks

**Files:**

- Modify: the quote status setter (where `quotes.status` → `ready`/`sent`/`accepted`; likely `agents/maxance-operator/*` or a quotes repo) — after the quote becomes ready/sent, call `emitHubSpotSync(db, quote.leadId)` so the deal picks up amount + devis number.
- Modify: `agents/engagement-agent/agent.ts` dormant flip — it already sets status `dormant` (now via `setLeadStatus`, which emits sync). Confirm the dormant path calls `setLeadStatus(db, leadId, 'dormant')` so `f16_dormant=true` mirrors. No extra code if already routed in Task 2.2.

- [ ] **Step 1: Add the quote hook**

Find where a quote reaches `ready`/`sent`:
Run: `cd Assuryal/F16/backend && grep -rn "status: 'ready'\|status:'ready'\|maxanceDevisNumber\|quotes.*set(" src --include=*.ts | grep -v test`
After the quote row is updated with the price/devis number, add:

```ts
import { emitHubSpotSync } from '../../db/repositories/leads.js';
// ...after the quote update, with the quote's leadId in scope:
await emitHubSpotSync(db, leadId);
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd Assuryal/F16/backend && pnpm typecheck && pnpm lint`
Expected: PASS.

```bash
git add -A backend/src
git commit -m "feat(backend): emit hubspot sync on quote ready + dormant"
```

---

### ✅ Phase 2 live-verify (Ridaa's HubSpot)

- [ ] Backend running. Inject a test lead → it lands at **Nouveau**.
- [ ] Drive transitions (via the agents in a real/simulated flow, or by calling `setLeadStatus` from a one-off tsx): `qualifying → quoting → negotiating → closed_won`. After each, confirm the **same** HubSpot deal moves stage (no duplicate deals).
- [ ] Produce a quote (ready, with premium + devis number) → confirm the deal's **amount + comptant + devis number** fill in.
- [ ] Flip to dormant → confirm `f16_dormant=true` and the stage does NOT change.
- [ ] Clean up test data. Log `hubspot-mirror-P2-DONE` to ruflo.

---

## PHASE 3 — Activity timeline (DEFERRED — needs extra scopes)

Gated on adding `crm.objects.calls.write` / `crm.objects.communications.write` / `crm.objects.notes.write` to the Service Key. When unblocked: add `client.logActivity` (notes/calls/communications) + emit on voice-call end, WhatsApp turn, engagement follow-up, and human-action resolution → attach to the contact+deal timeline. Sketch only; a separate plan when Ridaa adds the scopes.

---

## Self-Review notes (author)

- **Spec coverage:** §3 self-provision → Task 1.2/1.3; §4 pipeline+stage map → schema STAGES + mirror-map STATUS_TO_STAGE; §5 mapping → Task 1.1; §6 reconcile + hooks → Tasks 1.5 / 2.1–2.3; §7 activities → Phase 3 (deferred); §8 phases → P1/P2/P3; §9 testing → 1.1/1.3/1.6/2.1 + live-verify gates.
- **Placeholder scan:** the only intentionally-deferred fills are the DB-seed sections in 1.6/2.1 tests (must reuse the project's existing DB harness — explicitly instructed to read the existing dual-write DB test first), and Phase 3 (scope-gated). No silent TODOs in shipping code.
- **Type consistency:** `MirrorInput`, `StageKey`, `stageKeyForStatus`, `buildContactProps/buildDealProps`, `ensureSchema`/`ResolvedSchema.stageIdByKey`, `reconcileLead`, `setLeadStatus`/`emitHubSpotSync` consistent across tasks. `f16_dormant` is `'true'`/`'false'` strings everywhere.
- **Grounding TODOs for the implementer (verify-by-reading, noted inline):** quote timestamp column (`requestedAt`?), lead preferred-time column (`contactWindow`?), and the existing DB-test harness helper names — each task says to confirm by reading the real file before relying on a name.

```

```
