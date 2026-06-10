# HubSpot Rich Mirror — Design

**Date:** 2026-06-10
**Status:** Approved (brainstorm), pending spec review
**Owner:** Ridaa / Achraf (Assuryal F16)
**Builds on:** M5 HubSpot dual-write (`backend/src/integrations/hubspot/*`), now live (Service Key, EU portal). See ruflo `hubspot-integration-LIVE-2026-06-10`.

## 1. Goal & principle

Make HubSpot a **live mirror of everything F16 knows and does** about a lead — full customer record, vehicle, lifecycle stage (incl. won/lost), deal value, Maxance devis number, channel, preferred contact time, and (later) the activity timeline.

**Principle: F16 is the source of truth; HubSpot reflects it.** The sync is one-directional (F16 → HubSpot) and idempotent. Today's integration creates a Contact + Deal **once** at intake (`LEAD.NEW`). This design generalizes that into **reconcile-on-every-change**: a single `reconcileLead(leadId)` reads the current F16 state and upserts the full Contact + Deal, called at intake and on every meaningful transition.

**Scope:** backend-only (`backend/src/integrations/hubspot/*` + thin hooks at lifecycle transition points). No admin/frontend change. No bidirectional sync (HubSpot edits do not flow back in V1).

## 2. Current state (what exists, grounded)

- `integrations/hubspot/client.ts` — `upsertContact`, `createDeal`, `associateContactDeal` (now V4), `getDefaultDealPipelineAndStage` (cached). Bearer `HUBSPOT_API_KEY` → `api.hubapi.com`.
- `integrations/hubspot/dual-write.ts` — `handleLeadNew` worker on the `lead` queue (role `hubspot-sync`, env-gated on `HUBSPOT_API_KEY`): decrypt PII → upsert contact → create deal → associate → write `leads.hubspot_deal_id` back. Has a custom-property degrade + idempotency guard on `hubspot_deal_id`.
- Custom properties created manually today (must become self-provisioned): deals `product_line`, `f16_lead_id`; contacts `f16_lead_id`, `f16_product_line`, `f16_source`.
- F16 data available: `leads` (status, source, product_line, score, hubspot_deal_id, preferred_channel, contact_window/preferred_time, callback fields), `customers` (full_name, email, phone, address[enc JSON], civility, vehicle/driver jsonb), `quotes` (status, product, product_variant, monthly_premium, comptant_due, maxance_devis_number).
- **`lead_status` enum:** `new, scored, qualifying, quoting, negotiating, awaiting_payment, closed_won, closed_lost, dormant`.
- **`quote_status` enum:** `draft, requested, in_progress, ready, sent, accepted, rejected, expired`.

## 3. Self-provisioning — `ensureSchema()`

Runs once at worker startup (when `HUBSPOT_API_KEY` present), idempotent:

1. **Custom properties** — create any missing property (GET property → 404 → POST create). Tolerate "already exists" (409/validation) as success. Group: `dealinformation` / `contactinformation`.
2. **Assuryal pipeline** — list pipelines (`GET /crm/v3/pipelines/deals`); if none labelled `Assuryal` exists, create it (`POST`) with the stage set in §4. Cache `{pipelineId, stageId-by-key}` for the process. Store the resolved pipeline + stage ids in module state (re-resolved on boot).

`ensureSchema()` is best-effort: a failure logs a warning and the worker still runs against whatever exists (degrade path in dual-write remains the safety net). It never throws on startup.

### Custom properties to provision

**Contact** (`contactinformation`): `f16_lead_id` (string), `f16_source` (string), `f16_preferred_channel` (string), `f16_preferred_time` (string). Standard HubSpot fields used as-is: `firstname`, `lastname`, `email`, `phone`, `address`, `city`, `zip`.

**Deal** (`dealinformation`): `product_line` (string), `f16_lead_id` (string), `f16_lead_score` (number), `f16_vehicle` (string — model/label), `f16_devis_number` (string), `f16_comptant_due` (number), `f16_dormant` (enumeration bool: `true`/`false`). Standard fields: `dealname`, `amount` (= monthly premium), `dealstage`, `pipeline`, `closedate` (on won/lost).

## 4. Assuryal pipeline + stage map

Pipeline label `Assuryal`. Stages (displayOrder ascending), each with a stable key we map to:

| Key                | Stage label                | `metadata.isClosed` / probability |
| ------------------ | -------------------------- | --------------------------------- |
| `nouveau`          | Nouveau                    | open                              |
| `qualifie`         | Qualifié                   | open                              |
| `devis_en_cours`   | Devis en cours             | open                              |
| `devis_envoye`     | Devis envoyé / Négociation | open                              |
| `attente_paiement` | En attente paiement        | open                              |
| `gagne`            | Gagné                      | closed won (prob 1.0)             |
| `perdu`            | Perdu                      | closed lost (prob 0.0)            |

`lead.status → stage`:
`new`→nouveau · `scored`→nouveau · `qualifying`→qualifie · `quoting`→devis_en_cours · `negotiating`→devis_envoye · `awaiting_payment`→attente_paiement · `closed_won`→gagne · `closed_lost`→perdu · `dormant`→**unchanged stage** (keep last; set `f16_dormant=true`).

Stage is **forward-only** in practice; reconcile sets the stage that matches the current `lead.status`. If `lead.status === 'dormant'`, reconcile does NOT move the stage — it only sets `f16_dormant=true` (and clears it back to `false` if the lead later leaves dormant).

## 5. Mapping layer — `mirror-map.ts` (pure, tested)

Pure functions, no IO, exhaustively unit-tested:

```ts
interface MirrorInput {
  lead: LeadRow;          // status, source, product_line, score, preferred_channel, contact_window
  customer: CustomerRow;  // decrypted: fullName, email, phone, address(JSON), civility, vehicle
  latestQuote: QuoteRow | null; // status, monthly_premium, comptant_due, maxance_devis_number, product_variant
}
buildContactProps(input): Record<string,string>      // firstname/lastname/email/phone/address/city/zip + f16_*
buildDealProps(input): Record<string,string|number>  // dealname/amount/f16_comptant_due/f16_devis_number/f16_vehicle/f16_lead_score/product_line/f16_lead_id/f16_dormant
stageKeyForStatus(status): StageKey | null            // null = "leave stage unchanged" (dormant)
```

- `amount` = `latestQuote.monthly_premium` when present (else omitted).
- `f16_vehicle` = a human label from `customer.vehicle` (e.g. `"Xiaomi Pro 2"`), best-effort from the jsonb.
- Address parsed from the decrypted JSON string → `address`/`city`/`zip`. Missing fields omitted (never send empty strings that overwrite).
- PII discipline preserved: the mapper receives already-decrypted values; **no logging of PII** anywhere in the IO layer (lead id / deal id / booleans only — unchanged from today).

## 6. Reconcile + lifecycle hooks

### `reconcileLead(opts, leadId)` (generalizes `handleLeadNew`)

1. Load lead (+ skip if no `customer_id` / no email — unchanged guards).
2. Load customer, decrypt PII; load latest quote for the lead.
3. `ensureSchema()` (cached — no-op after first).
4. `upsertContact(buildContactProps(...))` (degrade-on-missing-property retained).
5. If `lead.hubspot_deal_id` is null → `createDeal` in the Assuryal pipeline at the mapped stage → `associateContactDeal` → write `hubspot_deal_id` back. Else → `updateDeal(hubspot_deal_id, buildDealProps + stage)`.
6. Stage: set to `stageKeyForStatus(lead.status)` unless null (dormant → leave stage, set `f16_dormant`).

Idempotent + replay-safe: re-running reconcile for the same lead converges to the same HubSpot state.

### Trigger points → `emitHubSpotSync(deps, leadId)`

A tiny helper that emits a `LEAD.SYNC_HUBSPOT` agent message (`toRole: hubspot-sync`, `lead` queue). The worker consumes both `LEAD.NEW` (→ reconcile) and `LEAD.SYNC_HUBSPOT` (→ reconcile). Emit at:

- Lead status transitions (the central status-setter / wherever `leads.status` is updated).
- Quote status transitions to `ready`/`sent`/`accepted` (premium/comptant/devis now known).
- Engagement-agent dormant flip.

If a transition site is scattered, the plan introduces a single `setLeadStatus()` helper and routes existing updates through it (targeted refactor, in-scope per "improve code you're touching").

### Client additions (`client.ts`)

`updateDeal(dealId, props)` (PATCH `/crm/v3/objects/deals/{id}`), `updateContact` (PATCH), `getOrCreatePipeline(label, stages)` + `listPipelines`. `createDeal` extended to accept an explicit `pipeline`+`dealStage` (already does) — pass the Assuryal ids.

## 7. Activity timeline (Phase 3 — deferred, needs scopes)

Log F16 activities as HubSpot engagements on the contact+deal timeline: voice calls (with duration + summary), WhatsApp messages, engagement follow-ups, human-action resolutions. Requires adding `crm.objects.calls.write` / `crm.objects.communications.write` / `crm.objects.notes.write` to the Service Key (deferred — Ridaa adds when we reach P3). Until then, P1/P2 use only the already-granted scopes.

## 8. Phases

- **P1 — Rich snapshot + self-provisioning.** `schema.ts` (`ensureSchema`: props + Assuryal pipeline) + `mirror-map.ts` (pure + tested) + `reconcileLead` rewrite pushing the full Contact + Deal at intake into the Assuryal pipeline at `Nouveau`. _Demo: inject a lead → rich deal (value, vehicle, score, preferences) in the Assuryal pipeline._ Commit `feat(backend): hubspot self-provisioned schema + rich lead mirror`.
- **P2 — Live lifecycle.** `emitHubSpotSync` at status/quote/dormant transitions → deal stage + amount + comptant + devis-number + dormant update live. _Demo: drive a lead new→qualifying→quoting→quote-ready→won → watch the HubSpot deal move stages and fill value._ Commit `feat(backend): hubspot live lifecycle + value sync`.
- **P3 — Activity timeline** (after scopes added). Commit `feat(backend): hubspot activity timeline`.

## 9. Testing

- **`mirror-map.ts`** — pure unit tests: each `lead.status`→stage; amount from quote; dormant → stage unchanged + flag; address parse; missing-field omission; PII not in output keys.
- **`reconcileLead`** — DB-gated idempotency tests on the **throwaway `f16_test`** DB (NEVER prod `f16`): create-then-update converges; replay no-ops; no-email/no-customer skips.
- **`ensureSchema`** — unit test with a mocked client: creates missing props, tolerates existing, creates pipeline only when absent.
- **Live-verify each phase** in Ridaa's real HubSpot (inject a lead via `scripts/.tmp-test-lead.ts` pattern; verify via Graph reads). Clean up test data after.
- Gate: `pnpm typecheck && pnpm lint && pnpm test` green; never run DB-gated tests against prod `f16`.

## 10. Risks & mitigations

| Risk                                                     | Mitigation                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| HubSpot API shape drift (V3↔V4, association, properties) | Already bit us (V3 association, missing property). `ensureSchema` self-provisions; client centralizes endpoints; live-verify each phase. |
| Property/pipeline already exists on re-provision         | `ensureSchema` treats "exists" as success (idempotent).                                                                                  |
| Scattered lead-status updates miss a hook                | Route status writes through one `setLeadStatus()` helper; reconcile is idempotent so an extra/late sync is harmless.                     |
| PII leakage to logs                                      | Mapper receives decrypted values; IO layer logs ids/booleans only (unchanged discipline).                                                |
| Rate limits (bursty reconciles)                          | Reconcile is on the `lead` queue (already throttled by BullMQ); updates are coalesced per lead.                                          |
| Test data polluting prod CRM                             | Use distinguishable test emails; clean up after live-verify (done today).                                                                |
