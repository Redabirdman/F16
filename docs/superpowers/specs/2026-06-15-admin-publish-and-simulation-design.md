# Admin Publish + Simulation Section — Design

Date: 2026-06-15. Goal: let Achraf (remote) test the F16 AI agents end-to-end by self-serving fake "Facebook ad" leads against the **real** intake pipeline, on his real WhatsApp/phone, and giving feedback that feeds the prompt/knowledge learning loop.

Decisions locked by Ridaa (2026-06-15): publish via **Cloudflare Tunnel + Access** (email-gated); reset = **full purge incl. HubSpot**; form = **full incl. quote inputs**; runs against the **live `f16` DB** with a simulation flag (no separate DB).

## 1. Principle

The simulator must inject leads through the **same code path as a real Facebook lead** — `ingestLead()` in `backend/src/leads/intake.ts` (the function the Meta webhook calls). No special-cased "simulation mode" in the agents. The only difference is an `attribution.f16_simulation = "true"` flag on the lead so analytics can exclude test traffic and we can identify sim data. This honors the intelligence mandate: agents reason about Achraf exactly as they would a real prospect.

## 2. Two independent pieces

- **Part 1 — Publish the admin** (ops/config; little or no app code).
- **Part 2 — Simulation section** (backend endpoints + admin page).

They share the same definition of done (Achraf can run a scenario remotely) but are built/verified separately.

---

## 3. Part 1 — Publish the admin (Cloudflare Tunnel + Access)

### 3.1 Routing

Reuse the existing `cloudflared` tunnel (already serving `hooks.assuryalconseil.fr` → `localhost:3001` for the voice/Meta webhooks). Add a **new hostname** `admin.assuryalconseil.fr` with path-based ingress (same hostname, ordered rules):

```
admin.assuryalconseil.fr/v1/admin/*  -> http://localhost:3001   # admin API
admin.assuryalconseil.fr/ws/*        -> ws://localhost:3001     # realtime (SSE/WS)
admin.assuryalconseil.fr/*           -> http://localhost:5173   # the admin app
```

The admin app already calls **relative** URLs (`/v1/admin/...`, `/ws/...` — see `admin/src/lib/api.ts`), so cloudflared routes API calls straight to the backend; **no Vite proxy dependency**. Only `/v1/admin/*` (not all of `/v1`) is exposed on this host, keeping surface minimal; the webhook routes stay only on `hooks.…`.

### 3.2 Access (the security gate)

A **Cloudflare Access** application protects `admin.assuryalconseil.fr` with a policy allowing only Achraf's + Ridaa's emails (one-time PIN). Rationale: the admin controls live agents and customer PII — it must never be openly reachable. Access gates the whole hostname (app + `/v1/admin` + `/ws`). The admin's existing bearer-token middleware (`requireAdminAuth`) stays enabled as defense-in-depth behind Access.

Setup is a Cloudflare-dashboard task (DNS CNAME + tunnel public hostname + Access app/policy). If the full-perm Cloudflare API token in `backend/.env` is usable, the DNS + tunnel route can be scripted; the Access policy is simplest in the dashboard. Deliverable: a short **runbook** (`docs/runbooks/publish-admin.md`) with the exact steps + the cloudflared ingress snippet.

### 3.3 Serving the admin

For remote stability, prefer a **built** admin over the HMR dev server: `pnpm --filter @f16/admin build` then serve `admin/dist` (static) on `:5173` (e.g. `vite preview --host --port 5173`, or a tiny static server). If the dev server is used instead, add `admin.assuryalconseil.fr` to Vite `server.allowedHosts`. The runbook documents both; built-static is the recommended default for Achraf's sessions.

### 3.4 Out of scope (Part 1)

No always-on hosting/PM2 changes; the existing "boot backend + admin for a session" flow stays. No auth changes beyond Access + the existing bearer token.

---

## 4. Part 2 — Simulation section

### 4.1 Backend — `src/admin/sim-control.ts` (Hono router, mounted behind `requireAdminAuth`)

**`POST /v1/admin/sim/inject-lead`**

- Body (Zod): `{ fullName, phone, email?, preferredChannel: 'whatsapp'|'call', preferredTime?: 'maintenant'|'matin'|'apres_midi'|'soir', productLine: 'scooter', quote?: { purchasePriceEur, purchaseDate, postalCode, stationnement, dateOfBirth, city? } }`.
- Builds a `LeadIntakePayload`: `source:'meta'`, `sourceId:'sim-<runId>'`, `attribution: { f16_simulation:'true', sim_run_id, sim_by:'admin', utm_source:'simulation' }`, `preferredChannel`, `preferredTime`, `formAnswers: quote ?? {}`, `raw: { simulation:true, ... }`, plus `metaLeadgenId` omitted (so the unique index isn't consumed) — sim runs are deduped by **phone** like any lead.
- Calls `ingestLead(db, payload)` → returns `{ accepted, leadId, customerId, dedup: 'new_customer'|'matched_existing' }`.
- Validation: phone must normalize to E.164 (reuse `normalizePhone`), else 400. `quote` fields validated only if present.

**`POST /v1/admin/sim/reset`**

- Body: `{ phone?: string, email?: string }` (at least one).
- Calls `purgeContact(db, { phone, email })` (new `src/leads/purge.ts`) — see 4.2.
- Then archives HubSpot: `archiveContactByEmailOrPhone()` (new method on `src/integrations/hubspot/client.ts`) — search contact by email/phone, archive the contact and its associated deals. Best-effort + logged; a HubSpot failure does not fail the F16 purge (returns `{ hubspot: 'archived'|'not_found'|'error' }`).
- Returns `{ purged: { customer, leads, conversations, quotes, humanActions }, hubspot }` counts.

**`POST /v1/admin/sim/status`** (phone in the body, never a query string — no PII in URLs)

- Body: `{ phone?: string }`. Returns `{ channels: { whatsapp: boolean, voice: boolean }, contact: { exists, leadCount, lastLeadStatus, lastConversationId } | null }` so the page can show a **live/not-live banner** and **new vs returning** state + a deep link to the conversation/lead.
- Channel liveness from the existing integrations-health probe (whatsapp = WAHA registered; voice = OpenAI SIP configured).

Mount in `backend/src/index.ts` alongside the other `app.route('/', adminXApp)` lines, after the admin-auth middleware.

### 4.2 Backend — `src/leads/purge.ts`

`purgeContact(db, { phone?, email? }) -> { customer, leads, conversations, quotes, humanActions }` (counts), in a single transaction, ordered to respect FKs:

1. Resolve the customer by `phoneHash` (and/or `emailHash` if present) — reuse the dedup lookup. If none → return all-zero (idempotent).
2. Collect the customer's `leadIds` and `quoteIds`.
3. Delete `conversation_turns` (by `customerId` / related `leadId`).
4. Delete `quotes` (by `customerId`).
5. Delete `human_actions` whose `correlationId` matches the customer/lead ids (string-correlated — match the ids we collected).
6. Delete `leads` (by `customerId`).
7. Delete the `customers` row.
   Pure, reusable, unit + DB-tested. Never logs decrypted PII (log ids/counts only).

### 4.3 Frontend — `admin/src/pages/Simulation.tsx` + nav/route

- New nav entry "Simulation" in `admin/src/App.tsx`; route `/sim`.
- **Form** (mirrors the FB ad lead form + optional quote inputs):
  - Identity: Full name, Phone (his real WhatsApp/call number), Email.
  - Channel preference: WhatsApp / Appel (radio).
  - Preferred time (select): maintenant / matin / après-midi / soir.
  - Product: Trottinette (scooter) — only live product.
  - Optional "Quote inputs" collapsible: purchase price €, purchase date, postal code, stationnement, date of birth, city. If filled, attached so the agent can drive a real Maxance quote in-chat; if blank, the agent collects them conversationally.
- **Actions:** Submit (inject), Reset (with a confirm dialog naming the phone + what gets wiped, incl. HubSpot).
- **Status panel:** channel live/not-live banner (from `/sim/status`); current identity (new vs returning) for the entered phone; after submit, show `leadId` + `dedup` + a link to the lead/conversation so Achraf can watch the agents.
- API wrappers in `admin/src/lib/api.ts`: `injectSimulatedLead()`, `resetSimulatedContact()`, `getSimStatus()` (all POST; react-query, following existing hooks).
- Note on the page: "Quote-in-chat requires the Chrome extension running" and "agents only message live when the backend is in full-live mode."

### 4.4 Faithfulness + analytics

`source:'meta'` makes the pipeline behavior identical to a real FB lead. Sim leads carry `attribution.f16_simulation='true'`; dashboards currently don't filter on it — a **follow-up** (not in this scope) can exclude sim traffic from metrics. Logged here so it isn't silently assumed.

---

## 5. Safety & error handling

- **Only the entered number is contacted.** Inject creates exactly one lead for the typed phone; no broadcast. Other contacts in the DB are untouched by a sim submit.
- **Live-mode required to message.** If WhatsApp/voice channels aren't registered, inject still creates the lead (so the pipeline/scoring is testable) but the status banner warns the agent can't send. Ridaa boots full-live for Achraf's sessions.
- **Reset is destructive + transactional.** Confirm dialog; idempotent; reports counts. Scoped to one phone/email — no bulk purge endpoint.
- **Access + bearer** gate the whole surface; reset/inject are admin-only.
- **PII discipline:** purge and status log ids/counts only, never decrypted values.

## 6. Testing

- **Backend unit:** sim→`LeadIntakePayload` mapping (flag + fields); `purgeContact` ordering (mocked db); HubSpot archive (mocked client); status liveness shaping.
- **DB-gated (`f16_test` only, never prod `f16`):** inject → creates customer+lead, `dedup='new_customer'`; resubmit same phone → `dedup='matched_existing'` (returning path); reset → all rows gone, idempotent on re-reset.
- **Frontend:** form validation, submit/reset/status hooks (vitest + testing-library, existing admin test patterns).
- **Live (with Achraf):** Ridaa boots full-live; Achraf opens the published admin (Access login), submits a WhatsApp lead, receives the agent's message, converses, resets, re-tests as new.

## 7. Risks & mitigations

- **Admin exposed to the internet** → Cloudflare Access email gate + bearer token; only `/v1/admin` + `/ws` routed on that host.
- **Accidentally messaging real customers** → sim contacts only the typed number; reset/inject never touch other rows; full-live is a deliberate per-session boot.
- **Purge FK/cascade mistakes** → single transaction, explicit delete order, DB-gated tests assert zero residual rows across all 5 tables.
- **HubSpot archive partial failure** → best-effort, isolated from the F16 purge, status reported.
- **Tunnel/HMR flakiness for remote** → serve built static admin (not dev HMR) behind the tunnel.

## 8. File touch-list

| File                                            | Change                                     |
| ----------------------------------------------- | ------------------------------------------ |
| `backend/src/admin/sim-control.ts`              | new — inject/reset/status router           |
| `backend/src/leads/purge.ts`                    | new — transactional purgeContact           |
| `backend/src/integrations/hubspot/client.ts`    | add archiveContactByEmailOrPhone           |
| `backend/src/index.ts`                          | mount sim router                           |
| `admin/src/pages/Simulation.tsx`                | new page                                   |
| `admin/src/App.tsx`                             | nav + route                                |
| `admin/src/lib/api.ts`                          | inject/reset/status wrappers               |
| `docs/runbooks/publish-admin.md`                | new — cloudflared ingress + Access runbook |
| tests (backend unit + DB-gated, admin frontend) | new                                        |
