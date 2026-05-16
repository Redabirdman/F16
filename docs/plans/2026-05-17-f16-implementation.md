# F16 V1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Each task below expands into TDD micro-steps (red → green → refactor → commit) at execution time.

**Goal:** Build F16 V1 — the autonomous AI organization for Assuryal Conseil — end-to-end: 16 agent roles across 4 channels (WhatsApp, voice, email, SMS), Maxance browser operator, ads pipeline, admin SPA, 2D isometric office visualization, dual-surface human-action channel, all on Ridaa's Hostinger VPS via EasyPanel.

**Architecture:** TypeScript monorepo (`backend/`, `admin/`, `pipecat/`, `stagehand/`, `infra/`). Claude Agent SDK + thin supervisor. Postgres + pgvector + Drizzle. BullMQ + Redis for inter-agent comms. Stagehand for Maxance. Pipecat (Python) for voice. WAHA for WhatsApp. Anthropic API direct for Claude (R2 routing); OpenRouter only for Nano Banana Pro.

**Tech Stack:**
- **Backend:** Node 22, TypeScript, Bun runtime (or Node), `@anthropic-ai/claude-agent-sdk`, Drizzle ORM, BullMQ, zod, Hono (HTTP), Mem0 SDK
- **Admin:** Vite, React 18, shadcn/ui, Tailwind, react-query, PixiJS (office scene), framer-motion
- **DB:** Postgres 16 + pgvector + pgcrypto
- **Cache/Queue:** Redis 7 (BullMQ)
- **Browser:** Stagehand + Playwright + headless Chromium
- **Voice:** Pipecat (Python), Deepgram, Azure Speech, OVH SIP
- **WhatsApp:** WAHA (existing)
- **Email:** BillionMail (self-hosted)
- **SMS:** android-sms-gateway (fallback)
- **Image Gen:** existing Python pipeline (`image_or.py`) via OpenRouter
- **Observability:** Loki + Grafana
- **Deploy:** EasyPanel containers on Hostinger VPS
- **Tests:** Vitest (unit), Playwright (e2e), synthetic conversation harness

**Source of truth for all design decisions:** `Assuryal/F16/docs/plans/2026-05-17-f16-design.md`. This plan implements that doc — when in doubt, re-read it.

---

## Milestone Overview & Dependency Graph

```
                       M0  ◄─ external bootstrap (Ridaa)
                        │
                        ▼
M1 Repo skeleton  ─────▶ M2 DB & migrations
                              │
            ┌─────────────────┼──────────────┬────────────────┐
            ▼                 ▼              ▼                ▼
   M3 Comms primitives  M4 Channel layer  M7 Knowledge   M14 Admin SPA scaffold
            │                 │              │                │
            ├─────────────────┼──────────────┘                │
            ▼                 ▼                               │
   M5 Lead intake  ──▶ M6 Sales Agent (WA only)               │
                             │                                │
                             ├──▶ M8 Maxance Op + Stagehand   │
                             │            │                   │
                             │            ▼                   │
                             │    M9 Quote orchestration ─────┤
                             │                                │
                             ├──▶ M10 Voice channel ──────────┤
                             │                                │
                             ├──▶ M11 Customer Engagement ────┤
                             │                                │
                             └──▶ M12 Ads Pipeline ───────────┤
                                                              │
                            M13 Human Action Channel ◄────────┤
                                          │                   │
                                          ▼                   │
                            M15 Supervisor + Team Manager ────┤
                                          │                   │
                                          ▼                   │
                            M16 Observability + Polish ◄──────┘
                                          │
                                          ▼
                            M17 Pre-launch + soft go-live
```

**Critical path (longest dependency chain, sequential):**
M0 → M1 → M2 → M3 → M5 → M6 → M8 → M9 → M13 → M15 → M16 → M17

**Parallelizable streams (after M3 + M4):**
- **Stream A** Sales pipeline: M5 → M6 → M8 → M9 → M11
- **Stream B** Voice: M10 (depends on M4, M6)
- **Stream C** Ads: M12 (depends on M5)
- **Stream D** Knowledge: M7 (depends on M2)
- **Stream E** Admin: M14 (depends on M3, can scaffold early)
- **Stream F** Ops: M0 + M16 continuously

**Total milestone count:** 17. **Tasks per milestone:** 5-15. **Rough effort estimate at single-engineer pace:** 4-5 months. At 2-engineer pace with parallel streams: 2.5-3 months.

---

## Conventions used in this plan

- **Files** lists exact paths. `Create:` = new file, `Modify:` = existing.
- **Tests** are written first (TDD). Every task ends with a green test + a commit.
- **Commit messages** follow Conventional Commits: `feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`, `test(scope): ...`.
- **Branch strategy:** trunk-based on `main`. Feature work in short-lived branches `mNN-task-N-slug`, merged via PR (even though it's just Ridaa for now — keeps history clean).
- **Skills to invoke during execution:**
  - `superpowers:executing-plans` for task dispatch
  - `superpowers:test-driven-development` per task
  - `superpowers:subagent-driven-development` if Ridaa wants parallel subagents
  - `superpowers:requesting-code-review` before each milestone merge
- **"Done" definition per task:** tests green, lint green, typecheck green, committed, pushed to remote.
- **"Done" definition per milestone:** all tasks green + integration test for the milestone passes + design-doc section it implements signed off in the milestone PR.

---

# M0 — External Bootstrap (Ridaa, mostly out-of-code)

**Owner:** Ridaa (manual ops)
**Blocks:** M1
**Tasks:**

### M0.T1: Rotate the leaked OpenRouter key
- **Where:** openrouter.ai console → Keys
- **Action:** Revoke the key shared on 2026-05-16. Issue a new key labeled `F16-prod`. Set hard monthly spend cap (suggest €100 for V1).
- **Deliverable:** new key value (Ridaa holds privately, will paste into EasyPanel env in M1.T8).

### M0.T2: Create Anthropic API key
- **Where:** console.anthropic.com → API Keys
- **Action:** Issue key labeled `F16-prod`. Set monthly spend cap (suggest €1,000 for V1 with growth headroom).
- **Deliverable:** key in Ridaa's password manager.

### M0.T3: Upgrade Hostinger VPS spec
- **Action:** Verify VPS has at least 8 CPU / 12 GB RAM / 100 GB SSD. Upgrade plan if needed.
- **Deliverable:** confirmed specs.

### M0.T4: Confirm EasyPanel admin access
- **Action:** Ridaa logs into EasyPanel on the VPS; verifies project creation rights.
- **Deliverable:** screenshot of EasyPanel dashboard.

### M0.T5: Provision OVH SIP trunk (deferred to M10 bootstrap)
- **Note:** Not blocking — Ridaa provides DID + SIP creds when M10 is ready to consume them.

### M0.T6: Verify Maxance access + map MFA flow
- **Action:** Ridaa logs into Maxance from a clean browser, screenshots each step, writes a click-by-click walkthrough including any 2FA prompts.
- **Deliverable:** `F16/docs/runbooks/maxance-login.md` (manual write-up; AI will then encode this for Stagehand in M8.T2).

### M0.T7: Create WhatsApp group for Reporter
- **Action:** Ridaa creates a WhatsApp group named "F16 — Assuryal Ops" with Ridaa + Achraf + the bot's WAHA-bound number. Captures the WA group ID via WAHA `/api/sessions/<session>/groups` endpoint.
- **Deliverable:** group ID stored privately, paste into env in M13.T2.

### M0.T8: Achraf onboarding kickoff
- **Action:** Ridaa briefs Achraf on the design doc (forward `2026-05-17-f16-design.md`). Captures Achraf's questions/objections; surface any blocker that warrants design revision.
- **Deliverable:** sign-off email/message from Achraf.

---

# M1 — Repo & Workspace Skeleton

**Owner:** Engineer (Ridaa or whoever first executes the plan)
**Depends on:** M0.T3, M0.T4
**Blocks:** M2-M17

### M1.T1: Initialize git repo + monorepo structure
**Files:**
- Create: `Assuryal/F16/.gitignore`
- Create: `Assuryal/F16/README.md` (5-line summary + pointer to design doc)
- Create: `Assuryal/F16/package.json` (workspace root, pnpm or bun)
- Create: `Assuryal/F16/pnpm-workspace.yaml` (or `bun.workspace.toml`)

**Steps:** `cd Assuryal/F16 && git init && git add . && git commit -m "chore: init F16 monorepo skeleton"`

**Acceptance:** `git status` clean. `pnpm install` (or `bun install`) succeeds at root.

### M1.T2: Scaffold `backend/` workspace
**Files:**
- Create: `Assuryal/F16/backend/package.json`
- Create: `Assuryal/F16/backend/tsconfig.json`
- Create: `Assuryal/F16/backend/src/index.ts` (Hono "hello f16")
- Create: `Assuryal/F16/backend/src/types.ts`
- Create: `Assuryal/F16/backend/.env.template`
- Create: `Assuryal/F16/backend/Dockerfile`

**Dependencies installed:** `@anthropic-ai/claude-agent-sdk`, `hono`, `zod`, `drizzle-orm`, `drizzle-kit`, `postgres`, `bullmq`, `ioredis`, `pino`, `dotenv-safe`

**Test:** `tests/smoke.test.ts` — boots Hono on random port, asserts `/health` returns 200 with `{ok: true, service: 'f16-backend'}`.

**Commit:** `feat(backend): scaffold Hono server with /health`

### M1.T3: Scaffold `admin/` workspace (Vite + React + shadcn)
**Files:**
- Create: `Assuryal/F16/admin/package.json`
- Create: `Assuryal/F16/admin/vite.config.ts`
- Create: `Assuryal/F16/admin/index.html`
- Create: `Assuryal/F16/admin/src/main.tsx`
- Create: `Assuryal/F16/admin/src/App.tsx` (single placeholder route "/")
- Create: `Assuryal/F16/admin/tailwind.config.ts`
- Create: `Assuryal/F16/admin/Dockerfile` (Caddy static serve build)

**Dependencies:** React 18, shadcn-init, react-router-dom, @tanstack/react-query, framer-motion, lucide-react, pixi.js, recharts

**Test:** `pnpm --filter admin build` produces `dist/` with index.html + assets.

**Commit:** `feat(admin): scaffold Vite + React + shadcn + Tailwind`

### M1.T4: Scaffold `pipecat/` workspace (Python)
**Files:**
- Create: `Assuryal/F16/pipecat/pyproject.toml`
- Create: `Assuryal/F16/pipecat/src/f16_pipecat/__init__.py`
- Create: `Assuryal/F16/pipecat/src/f16_pipecat/server.py` (FastAPI "hello f16-pipecat")
- Create: `Assuryal/F16/pipecat/Dockerfile`

**Dependencies:** `pipecat-ai`, `fastapi`, `uvicorn`, `pydantic`, `httpx`, `deepgram-sdk`, `azure-cognitiveservices-speech`

**Test:** `pytest pipecat/tests/test_health.py` asserts `/health` returns 200.

**Commit:** `feat(pipecat): scaffold FastAPI service`

### M1.T5: Scaffold `stagehand/` workspace
**Files:**
- Create: `Assuryal/F16/stagehand/package.json`
- Create: `Assuryal/F16/stagehand/src/index.ts` (Stagehand server wrapper)
- Create: `Assuryal/F16/stagehand/Dockerfile` (mcr.microsoft.com/playwright base image)

**Dependencies:** `@browserbasehq/stagehand`, `playwright`, `hono`, `zod`

**Test:** `tests/stagehand-smoke.test.ts` boots a browser, navigates to `about:blank`, asserts no error.

**Commit:** `feat(stagehand): scaffold browser automation service`

### M1.T6: Scaffold `infra/` workspace
**Files:**
- Create: `Assuryal/F16/infra/docker-compose.dev.yml` (Postgres + Redis + adminer for local dev)
- Create: `Assuryal/F16/infra/easypanel/README.md` (mapping of containers → EasyPanel apps)
- Create: `Assuryal/F16/infra/Caddyfile.example` (reverse proxy template)

**Test:** `docker compose -f infra/docker-compose.dev.yml up -d` brings up Postgres on 5433 + Redis on 6380. `psql` connect succeeds.

**Commit:** `chore(infra): dev docker-compose + EasyPanel layout`

### M1.T7: Root tooling — ESLint, Prettier, lint-staged, husky, Vitest, CI
**Files:**
- Create: `Assuryal/F16/.eslintrc.json`
- Create: `Assuryal/F16/.prettierrc`
- Create: `Assuryal/F16/.husky/pre-commit`
- Create: `Assuryal/F16/.github/workflows/ci.yml` (or Gitea/Forgejo if VPS-self-hosted) — runs `pnpm install && pnpm -r build && pnpm -r test && pnpm -r typecheck`
- Create: `Assuryal/F16/turbo.json` (or rely on pnpm filters)

**Test:** running `pnpm lint && pnpm typecheck && pnpm test` at root passes for all workspaces.

**Commit:** `chore: root tooling — eslint, prettier, husky, vitest, CI`

### M1.T8: Environment & secrets template + EasyPanel project shells
**Files:**
- Create: `Assuryal/F16/.env.template` (every env var the system reads, with placeholder values + comments)
- Create: `Assuryal/F16/docs/runbooks/secrets.md` (which keys go in which EasyPanel container's env, who has them, rotation cadence)

**EasyPanel actions (Ridaa):** create 7 empty apps in EasyPanel: `f16-postgres`, `f16-redis`, `f16-backend`, `f16-admin`, `f16-pipecat`, `f16-stagehand`, `f16-billionmail`. Paste env values into each.

**Commit:** `docs: secrets runbook + env template`

---

# M2 — Database & Migrations

**Depends on:** M1
**Blocks:** M3+

### M2.T1: Postgres 16 + extensions
**Files:**
- Modify: `Assuryal/F16/infra/docker-compose.dev.yml` — pin `postgres:16` + init script
- Create: `Assuryal/F16/infra/postgres/init.sql` — `CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;`

**Test:** dev compose up; `\dx` in psql lists both extensions.

**Commit:** `chore(infra): postgres 16 + pgvector + pgcrypto`

### M2.T2: Drizzle setup + tooling
**Files:**
- Create: `Assuryal/F16/backend/drizzle.config.ts`
- Create: `Assuryal/F16/backend/src/db/index.ts` (Drizzle client factory, reads `DATABASE_URL`)
- Create: `Assuryal/F16/backend/src/db/schema/index.ts` (barrel export)

**Test:** `pnpm --filter backend db:generate` produces empty migration; `pnpm --filter backend db:push` applies it.

**Commit:** `feat(backend): drizzle ORM setup`

### M2.T3: Core lead + customer schema
**Files:**
- Create: `backend/src/db/schema/customers.ts` — `customers`, `customer_facts`
- Create: `backend/src/db/schema/leads.ts` — `leads`
- Create: `backend/src/db/schema/conversation_turns.ts` — `conversation_turns`
- Test: `backend/tests/db/customers.test.ts` — insert customer with encrypted PII, retrieve, assert decryption roundtrip

**Migration:** `drizzle/0001_core_customer.sql`

**Commit:** `feat(db): customers, leads, conversation_turns schema with PII encryption`

### M2.T4: Quote + Maxance schema
**Files:**
- Create: `backend/src/db/schema/quotes.ts` — `quotes`, `maxance_actions`
- Test: insert quote linked to customer, insert N maxance_actions, assert ordering by step_index

**Migration:** `drizzle/0002_quotes_maxance.sql`

**Commit:** `feat(db): quotes + maxance_actions`

### M2.T5: Ads schema
**Files:**
- Create: `backend/src/db/schema/ads.ts` — `campaigns`, `adsets`, `ads`, `creatives`, `ad_metrics_hourly`
- Test: insert campaign tree, query metrics rollup

**Migration:** `drizzle/0003_ads.sql`

**Commit:** `feat(db): campaigns, adsets, ads, creatives, metrics`

### M2.T6: Agent comms + memory schema
**Files:**
- Create: `backend/src/db/schema/agent_messages.ts` — `agent_messages` (the §6.2 schema)
- Create: `backend/src/db/schema/agent_patterns.ts` — `agent_patterns`
- Create: `backend/src/db/schema/human_actions.ts` — `human_actions`
- Create: `backend/src/db/schema/audit_log.ts` — `audit_log`
- Create: `backend/src/db/schema/knowledge_chunks.ts` — `knowledge_chunks` (with `vector(1536)`)
- Test: round-trip enqueue + consume on `agent_messages`; vector kNN query on `knowledge_chunks`

**Migration:** `drizzle/0004_agent_runtime.sql`

**Commit:** `feat(db): agent comms, memory, audit, knowledge`

### M2.T7: PII encryption helpers
**Files:**
- Create: `backend/src/db/crypto.ts` — `encryptPII(plaintext)`, `decryptPII(ciphertext)`, AES-GCM with key from `PII_ENCRYPTION_KEY` env
- Modify: customer schema columns flagged PII to use helper transparently
- Test: encrypt → store → retrieve → decrypt; assert wrong key fails

**Commit:** `feat(db): PII column encryption helpers`

### M2.T8: Seed + dev fixtures
**Files:**
- Create: `backend/scripts/seed-dev.ts` — inserts 3 fake leads, 2 fake customers, 1 quote, sample human action
- Test: `pnpm --filter backend seed:dev && pnpm --filter backend test:e2e:db` reads expected rows

**Commit:** `chore(db): dev seed + fixtures`

---

# M3 — Inter-Agent Comms Primitives

**Depends on:** M2
**Blocks:** M5+

### M3.T1: BullMQ setup
**Files:**
- Create: `backend/src/queue/index.ts` — queue factory bound to Redis
- Create: `backend/src/queue/queues.ts` — declare named queues per intent domain
- Test: enqueue + consume a hello-world job

**Commit:** `feat(queue): BullMQ + Redis client`

### M3.T2: Intent registry + zod schemas
**Files:**
- Create: `backend/src/intents/index.ts` — `IntentName` enum + zod schema registry
- Create: `backend/src/intents/lead.ts`, `intents/quote.ts`, `intents/customer.ts`, `intents/ads.ts`, `intents/voice.ts`, `intents/knowledge.ts`, `intents/compliance.ts`, `intents/operations.ts`
- Test: invalid payload rejected with helpful error; valid payload roundtrips

**Commit:** `feat(intents): typed intent registry with zod schemas`

### M3.T3: AgentMessage dispatcher
**Files:**
- Create: `backend/src/messaging/dispatcher.ts` — `sendMessage(...)`, `consume(handler)`
- Writes to `agent_messages` AND enqueues BullMQ job; consumer marks `consumed_at` on completion
- Test: send → consume → assert DB row state transitions; failure → `error` recorded, retry counter increments

**Commit:** `feat(messaging): AgentMessage dispatcher with DB persistence`

### M3.T4: Base Agent class
**Files:**
- Create: `backend/src/agents/base.ts` — `BaseAgent` with: `role`, `instanceId`, `model`, `tools`, `sendMessage()`, `recall()`, hooks for `onMessage(intent, payload)`
- Test: spawn a `TestAgent` that echoes; assert it can receive an intent and emit a follow-up

**Commit:** `feat(agents): BaseAgent class + lifecycle`

### M3.T5: Claude Agent SDK integration
**Files:**
- Create: `backend/src/llm/claude.ts` — typed wrapper around `@anthropic-ai/claude-agent-sdk` with model tier selection
- Create: `backend/src/llm/router.ts` — picks model per use case (Sonnet/Haiku/Opus per design §16)
- Create: `backend/src/llm/cache.ts` — prompt caching helpers (cache control on system prompts)
- Test: stub Anthropic with a mock; assert correct model + cache control sent for each tier

**Commit:** `feat(llm): Claude Agent SDK wrapper + model router + caching`

### M3.T6: MCP tool registry
**Files:**
- Create: `backend/src/tools/registry.ts` — register/lookup tools by name; each tool has `name`, `description`, `schema`, `handler`
- Create: `backend/src/tools/builtins/` — initial tools: `customer.read_profile`, `customer.update_profile`, `knowledge.search`, `human.escalate`
- Test: register a tool, agent retrieves it, calls handler, gets validated result

**Commit:** `feat(tools): tool registry + builtins`

### M3.T7: Agent registry + spawn/kill
**Files:**
- Create: `backend/src/agents/registry.ts` — registry of agent classes by role; spawn(role, instanceId, ctx); kill(instanceId)
- Track running instances in-memory + reflect in `agents_state` table for admin visibility
- Test: spawn 2 instances of same role, send an intent targeting `to_instance`, only that one receives

**Commit:** `feat(agents): registry + spawn/kill`

### M3.T8: Realtime fan-out for admin (Postgres LISTEN/NOTIFY)
**Files:**
- Create: `backend/src/realtime/notify.ts` — wraps NOTIFY on `agent_messages_inserted` and `human_actions_changed`
- Create trigger function in migration: `NOTIFY agent_messages_channel, payload_json` on insert
- Test: subscribe consumer receives a payload within 100ms of insert

**Commit:** `feat(realtime): Postgres LISTEN/NOTIFY fan-out`

---

# M4 — Channel Layer

**Depends on:** M2, M3
**Blocks:** M6 (WhatsApp), M10 (voice), M11

### M4.T1: ConversationChannel interface
**Files:**
- Create: `backend/src/channels/types.ts` — `ConversationChannel`, `ContactRef`, `ContentBlock`, `DeliveryReceipt` types
- Create: `backend/src/channels/registry.ts` — `getChannel(id)`
- Test: register a stub channel, send, assert delivery receipt shape

**Commit:** `feat(channels): interface + registry`

### M4.T2: WAHA adapter (outbound)
**Files:**
- Create: `backend/src/channels/whatsapp/waha-client.ts` — HTTP client to WAHA
- Create: `backend/src/channels/whatsapp/adapter.ts` — implements `ConversationChannel`
- Test: against a mock WAHA server, send text, send image, send interactive list

**Commit:** `feat(channels/wa): WAHA outbound adapter`

### M4.T3: WAHA inbound webhook
**Files:**
- Create: `backend/src/channels/whatsapp/webhook.ts` — Hono route `POST /webhooks/waha`
- Validates webhook signature; converts to `CUSTOMER.MESSAGE_RECEIVED` intent
- Test: POST sample WAHA payload, assert intent emitted with correct customer match

**Commit:** `feat(channels/wa): inbound webhook → intent`

### M4.T4: BillionMail adapter
**Files:**
- Create: `backend/src/channels/email/billionmail-client.ts`
- Create: `backend/src/channels/email/adapter.ts`
- Test: against a BillionMail dev SMTP, send HTML + plaintext email

**Commit:** `feat(channels/email): BillionMail adapter`

### M4.T5: SMS adapter (android-sms-gateway)
**Files:**
- Create: `backend/src/channels/sms/adapter.ts`
- Test: stubbed POST to gateway, assert payload shape

**Commit:** `feat(channels/sms): android-sms-gateway adapter`

### M4.T6: Channel switching policy
**Files:**
- Create: `backend/src/channels/switching.ts` — `pickChannel(customer, intent, history)` → channel id
- Default to customer's last-used channel; rules for switch (silence threshold, customer request, failure ladder)
- Test: 5 scenarios from design §8.1 produce expected channel pick

**Commit:** `feat(channels): switching policy`

### M4.T7: Unified send-tracking
**Files:**
- Modify: every adapter `send()` writes a row to `conversation_turns` with `direction='outbound'`, `delivery_receipt`
- Test: send via WA + via email, assert two `conversation_turns` rows with correct channels

**Commit:** `feat(channels): unified send tracking → conversation_turns`

---

# M5 — Lead Intake

**Depends on:** M2, M3, M4 (WhatsApp for opener)
**Blocks:** M6

### M5.T1: Public webhook endpoint
**Files:**
- Create: `backend/src/routes/public/leads.ts` — `POST /v1/leads`, HMAC-signed, rate-limited
- Validates payload, normalizes phone (E.164 FR), dedups by `phone`+`email`
- Test: valid HMAC + payload → 201 + lead row + `LEAD.NEW` intent emitted; invalid HMAC → 401

**Commit:** `feat(leads): public intake webhook with HMAC`

### M5.T2: HubSpot client + dual-write
**Files:**
- Create: `backend/src/integrations/hubspot/client.ts`
- Create: `backend/src/workers/hubspot-sync.ts` — consumes `LEAD.NEW`, creates HubSpot contact + deal in correct pipeline stage
- Test: against HubSpot sandbox (free tier), create lead, assert contact + deal IDs returned and stored on `leads` row

**Commit:** `feat(integrations): HubSpot dual-write on LEAD.NEW`

### M5.T3: Lead Scorer ephemeral worker
**Files:**
- Create: `backend/src/agents/lead-scorer.ts` — Haiku-powered, scores intent 0-100, picks opening, recommends channel
- Triggered by `LEAD.NEW`, emits `LEAD.SCORED`
- Test: 3 lead profiles → expected score ranges + channel picks

**Commit:** `feat(agents): Lead Scorer worker`

### M5.T4: Sales Agent spawn-on-`LEAD.NEW`
**Files:**
- Modify: `agents/registry.ts` — on `LEAD.NEW`, spawn `SalesAgent` instance with `instanceId=lead-${id}`
- Test: lead created → SalesAgent instance running

**Commit:** `feat(agents): auto-spawn Sales Agent on new lead`

### M5.T5: Website webhook integration
**Files:**
- Create: `Assuryal/F16/docs/runbooks/website-integration.md` — exact instructions Achraf follows in Lovable to add a parallel POST to F16's `/v1/leads`
- Define exact payload schema (zod) the website must send

**Achraf action:** add the webhook call in the Lovable project, paste F16 webhook URL + HMAC secret.

**Test:** real form submit on assuryalconseil.fr → row appears in F16 DB + HubSpot.

**Commit:** `docs(integrations): website-to-F16 webhook runbook`

---

# M6 — Sales Agent (WhatsApp Only First)

**Depends on:** M3, M4 (WA), M5
**Blocks:** M8

### M6.T1: Sales Agent class skeleton
**Files:**
- Create: `backend/src/agents/sales/index.ts`
- Create: `backend/src/agents/sales/prompts.ts` — system primer (Assuryal brand voice, French, sales playbook, guardrails)
- Test: instantiate, assert prompt structure includes brand name, voice rules, current customer state

**Commit:** `feat(agents/sales): class skeleton + prompt primer`

### M6.T2: Customer memory recall via Mem0
**Files:**
- Create: `backend/src/memory/mem0-client.ts` — wraps Mem0 SDK pointed at our Postgres
- Add tool `memory.recall_customer(query)` to Sales Agent's toolbelt
- Test: write 5 facts about a customer; query "what's the customer's vehicle?" returns relevant facts

**Commit:** `feat(memory): Mem0 recall integration`

### M6.T3: Tool: `quote.request`
**Files:**
- Create: `backend/src/tools/builtins/quote-request.ts` — emits `QUOTE.REQUESTED` to Maxance Operator queue
- Test: agent invokes tool → `QUOTE.REQUESTED` row in `agent_messages` with correct correlation_id

**Commit:** `feat(tools): quote.request`

### M6.T4: Tool: `human.escalate`
**Files:**
- Create: `backend/src/tools/builtins/human-escalate.ts` — creates `human_actions` row + emits `HUMAN_ACTION.REQUESTED`
- Test: agent escalates → row created with severity inferred from context

**Commit:** `feat(tools): human.escalate`

### M6.T5: Compliance Sentry inline gate
**Files:**
- Create: `backend/src/agents/compliance-sentry.ts` — Haiku, sync invocation
- Create: `backend/src/middleware/compliance.ts` — wraps Sales Agent outbound; PASS → send, BLOCK → escalate + retry with revised prompt
- Test: forbidden phrase ("contract is bound") → BLOCK; safe message → PASS in <300ms

**Commit:** `feat(compliance): inline Sentry on Sales Agent outbound`

### M6.T6: Streaming reply to WAHA "typing" indicator
**Files:**
- Modify: `channels/whatsapp/adapter.ts` — add `sendTyping(contact, true|false)`
- Modify: `agents/sales/index.ts` — on first Sonnet token, send typing=true; on final, send message + typing=false
- Test: synthetic Sonnet stream, assert typing-on within 1s, message arrives within 8s (M6.T6 hits the speed SLO)

**Commit:** `feat(agents/sales): streaming with WAHA typing indicator`

### M6.T7: Inbound message handling loop
**Files:**
- Modify: `agents/sales/index.ts` — `onMessage(CUSTOMER.MESSAGE_RECEIVED)` flow: recall context → run Claude → compliance gate → send reply → log turn
- Test: synthetic conversation harness — 5-turn WhatsApp dialogue with a fake customer asking about scooter insurance; agent qualifies, requests quote, delivers result. Assert SLOs (§17.4) met on every turn.

**Commit:** `feat(agents/sales): full inbound handling loop`

### M6.T8: French sales playbook prompt tuning
**Files:**
- Modify: `agents/sales/prompts.ts` — incorporate Achraf's playbook for handling: price objections, "je vais réfléchir", silence after quote, request-callback
- Create: `backend/tests/agents/sales/playbook.test.ts` — 8 scenario tests, each a synthetic French customer dialogue, asserting agent's chosen path matches the playbook

**Owner of content:** Achraf provides the playbook bullets; engineer encodes.

**Commit:** `feat(agents/sales): French sales playbook prompts`

---

# M7 — Knowledge Ingest + Curator

**Depends on:** M2
**Blocks:** M6 (full quality), M10, M11
**Note:** Can run in parallel with M5/M6 — scaffold knowledge tool early as a no-op, fill in content here

### M7.T1: Website scraper for assuryalconseil.fr
**Files:**
- Create: `backend/src/knowledge/scrapers/assuryal-site.ts` — fetches sitemap, scrapes pages, extracts main text, captures images
- Test: against a local snapshot of conversion-machine-main, produces N text chunks

**Commit:** `feat(knowledge): Assuryal site scraper`

### M7.T2: Chunker + embedder
**Files:**
- Create: `backend/src/knowledge/chunker.ts` — semantic-boundary chunks, target 500-800 tokens
- Create: `backend/src/knowledge/embedder.ts` — uses Voyage-FR-2 (best French embedder) or text-embedding-3-large; pluggable
- Test: chunks bounded, embeddings have correct dim, idempotent on same input

**Commit:** `feat(knowledge): chunker + embedder`

### M7.T3: Upsert pipeline → `knowledge_chunks`
**Files:**
- Create: `backend/src/knowledge/upsert.ts` — diff against existing chunks (hash-based), upsert new/changed
- Test: re-running on unchanged source → 0 inserts; one page changed → only that page's chunks re-embedded

**Commit:** `feat(knowledge): idempotent upsert pipeline`

### M7.T4: `knowledge.search` tool
**Files:**
- Create: `backend/src/tools/builtins/knowledge-search.ts` — vector kNN + optional reranking via Cohere/Voyage rerank
- Modify: Sales Agent toolbelt to include it
- Test: query "combien coûte l'assurance trottinette" returns chunks containing "5€/mois"

**Commit:** `feat(tools): knowledge.search`

### M7.T5: Knowledge Curator agent
**Files:**
- Create: `backend/src/agents/knowledge-curator/index.ts` — singleton, runs every 6h + on demand
- Detects drift (price changes, new product, removed product) → emits `KNOWLEDGE.DRIFT_DETECTED` → Supervisor → Human Action
- Test: simulate website with a price change, assert drift detected with old + new value

**Commit:** `feat(agents): Knowledge Curator with drift detection`

### M7.T6: Maxance product-pages ingest
**Files:**
- Create: `backend/src/knowledge/scrapers/maxance-products.ts` — uses Stagehand to navigate logged-in Maxance product catalog
- Depends on M8.T1 for Stagehand
- Test: produces chunks for at least 2 known products

**Commit:** `feat(knowledge): Maxance product-pages ingest`

---

# M8 — Maxance Operator + Stagehand

**Depends on:** M3, M6, M0.T6 (Maxance login flow), M1.T5 (Stagehand workspace)
**Blocks:** M9, M11 (full)

### M8.T1: Stagehand server in-container
**Files:**
- Modify: `stagehand/src/index.ts` — Hono server exposing `POST /v1/intent` (body: `{sessionId, intent, payload}`) → executes Stagehand action → returns result + screenshot URL
- Persistent user-data dir mounted on volume
- Test: send `intent: "navigate to https://example.com"` → returns 200 + screenshot

**Commit:** `feat(stagehand): HTTP server with intent endpoint`

### M8.T2: Maxance login + session bootstrap
**Files:**
- Create: `stagehand/src/maxance/login.ts` — encodes Ridaa's M0.T6 walkthrough as deterministic Stagehand intents
- Create: `stagehand/src/maxance/heartbeat.ts` — 5min ping; on logout, emits `SESSION.LOGGED_OUT` → human action
- Test: full login flow against Maxance staging account; session cookies persisted

**Commit:** `feat(stagehand/maxance): login + heartbeat`

### M8.T3: Maxance quote-flow intent library
**Files:**
- Create: `stagehand/src/maxance/intents/vehicle.ts` — "set vehicle type to X", "set brand", "set model", "set year"
- Create: `stagehand/src/maxance/intents/driver.ts` — license, age, malus, history
- Create: `stagehand/src/maxance/intents/garanties.ts` — coverage level selection
- Create: `stagehand/src/maxance/intents/infos.ts` — usage, address, parking
- Create: `stagehand/src/maxance/intents/coordonnees.ts` — subscriber info (the §5.5 screenshot fields)
- Test: each intent tested against the Maxance form; before/after screenshots captured

**Commit:** `feat(stagehand/maxance): quote-flow intent library`

### M8.T4: Maxance Operator agent
**Files:**
- Create: `backend/src/agents/maxance-operator/index.ts` — consumes `QUOTE.REQUESTED`, drives Stagehand step-by-step, captures price + PDF
- Logs every step to `maxance_actions`
- Test: synthetic QUOTE.REQUESTED → real Maxance form drive → PDF returned → `QUOTE.READY` emitted

**Commit:** `feat(agents): Maxance Operator`

### M8.T5: Pre-warm pool
**Files:**
- Modify: `stagehand/src/index.ts` — maintain N=3 always-logged-in sessions
- Modify: `backend/src/agents/maxance-operator/index.ts` — checkout from pool on `QUOTE.REQUESTED`
- Test: latency budget — cold session unused; quote takes < 60s for happy path

**Commit:** `feat(stagehand): pre-warm session pool`

### M8.T6: Quote PDF capture + Maxance email-send
**Files:**
- Create: `stagehand/src/maxance/intents/quote-pdf.ts` — clicks "Télécharger le devis" + "Envoyer par email" with provided customer email
- Returns PDF byte stream + email send confirmation
- Test: end-to-end on test account; verify PDF arrives at fake email inbox

**Commit:** `feat(stagehand/maxance): quote PDF + email send`

---

# M9 — Quote Orchestration End-to-End

**Depends on:** M8, M6
**Blocks:** M11, M13

### M9.T1: Quote Summarizer worker
**Files:**
- Create: `backend/src/agents/quote-summarizer.ts` — Haiku, given a quote payload, produces French WhatsApp message + email body
- Triggered by `QUOTE.READY`, emits `QUOTE.SUMMARIZED`
- Test: 3 quote shapes → expected French summaries with the right tone

**Commit:** `feat(agents): Quote Summarizer`

### M9.T2: Sales Agent quote delivery loop
**Files:**
- Modify: `agents/sales/index.ts` — on `QUOTE.SUMMARIZED`, send WhatsApp summary + PDF attachment + (optional) email
- Emit `QUOTE.DELIVERED` after send confirmation
- Test: synthetic flow LEAD.NEW → ... → QUOTE.DELIVERED, assert end-to-end happy-path < 5 min (matches §17.4)

**Commit:** `feat(agents/sales): quote delivery loop`

### M9.T3: Pre-warming Maxance on partial data
**Files:**
- Modify: `agents/sales/index.ts` — after first turn where vehicle category is known, emit `QUOTE.PREWARM_REQUESTED`
- Modify: `agents/maxance-operator/index.ts` — handle prewarm; checkout session, navigate to vehicle step
- Test: full flow timing — quote-ready latency reduced by N seconds vs no-prewarm

**Commit:** `feat(perf): Maxance pre-warming on partial data`

### M9.T4: Quote acceptance flow
**Files:**
- Modify: `agents/sales/index.ts` — recognize "j'accepte" / "ok je prends" / etc. → emit `QUOTE.ACCEPTED` → trigger `PAYMENT.PENDING_HUMAN` (Ridaa/Achraf get the wire-transfer task)
- Test: 10 French acceptance phrasings recognized; one ambiguous → human escalation

**Commit:** `feat(agents/sales): quote acceptance recognition`

---

# M10 — Voice Channel

**Depends on:** M4, M6, M0.T5 (OVH DID)
**Blocks:** M11 (voice cascade)

### M10.T1: Pipecat container
**Files:**
- Modify: `pipecat/src/f16_pipecat/server.py` — FastAPI server with `POST /v1/calls/outbound`, `POST /webhooks/sip/inbound`, `WebSocket /v1/realtime`
- Create: `pipecat/src/f16_pipecat/pipeline.py` — STT(Deepgram FR) → LLM bridge (HTTP to backend) → TTS(Azure Neural Denise) → audio out

**Commit:** `feat(pipecat): server + base pipeline`

### M10.T2: OVH SIP integration
**Files:**
- Create: `pipecat/src/f16_pipecat/sip/ovh.py` — SIP client config, DID registration
- Test: synthetic outbound dial to a test number; success criteria = audio in/out flowing

**Commit:** `feat(pipecat): OVH SIP integration`

### M10.T3: Sales-Agent ↔ Pipecat HTTP bridge
**Files:**
- Create: `backend/src/routes/voice.ts` — `POST /v1/sales-agent/turn` — Pipecat calls this with transcribed text, gets response text back
- Routes to the existing Sales Agent for the matched customer_id (lookup by phone)
- Test: simulate Pipecat call → text in → text out; latency target < 800ms first token

**Commit:** `feat(voice): Sales Agent HTTP bridge`

### M10.T4: Voice channel adapter
**Files:**
- Create: `backend/src/channels/voice/adapter.ts` — implements ConversationChannel; `send()` schedules outbound call via Pipecat
- Test: schedule outbound to a test number, monitor call completion via `VOICE.CALL_COMPLETED`

**Commit:** `feat(channels/voice): adapter`

### M10.T5: Inbound from website CTA
**Files:**
- Create: `backend/src/routes/public/call-me.ts` — `POST /v1/call-me`, HMAC-signed, dial customer from F16
- Modify: Achraf's website Lovable to call this endpoint when CTA is hit
- Test: simulate CTA → outbound dial → Pipecat handles, Sales Agent receives

**Commit:** `feat(voice): inbound from website CTA`

### M10.T6: Voice + WhatsApp memory continuity
**Files:**
- Verify: `conversation_turns` writes from voice use `channel='voice'`, same `customer_id`; Sales Agent recall query stays channel-agnostic
- Test: mid-conversation switch from WA to voice → agent's first voice utterance references context from WA turns

**Commit:** `test(voice): cross-channel memory continuity`

---

# M11 — Customer Engagement (Follow-up Cascades)

**Depends on:** M6, M10
**Blocks:** M13 (escalations from cascades)

### M11.T1: Cascade definition DSL
**Files:**
- Create: `backend/src/cascades/types.ts` — `Cascade = { name, steps: Step[] }` where `Step = { afterMs, channel, composerHint }`
- Create: `backend/src/cascades/library/` — `silent-after-opener.ts`, `silent-after-quote.ts`, `cold-revival-30d.ts`
- Test: cascades have monotonic delays + valid channels

**Commit:** `feat(cascades): definition + library`

### M11.T2: Customer Engagement loop
**Files:**
- Create: `backend/src/agents/customer-engagement/index.ts` — singleton, runs every 5 min
- Queries leads with `next_followup_due_at < now()`, dispatches via channel
- Test: stub leads at various stages, assert correct cascade picked

**Commit:** `feat(agents): Customer Engagement`

### M11.T3: Follow-up Composer
**Files:**
- Create: `backend/src/agents/follow-up-composer.ts` — Sonnet, given full thread + cascade step, drafts the next French message
- Test: 5 thread scenarios → varied non-templated French messages, each respecting brand voice

**Commit:** `feat(agents): Follow-up Composer`

### M11.T4: Voice fallback ladder
**Files:**
- Modify: Customer Engagement — after 2 WhatsApp follow-ups silent, escalate to voice
- After voice fail twice, escalate to email + SMS combo
- Test: simulated silent customer → escalation path correct

**Commit:** `feat(cascades): WA → voice → email/SMS ladder`

### M11.T5: Idempotency + dedup
**Files:**
- Modify: cascade dispatch — write `followup_sent` row before send; on retry, skip if exists
- Test: deliberately retry cascade tick twice — only one message sent

**Commit:** `feat(cascades): idempotent dispatch`

---

# M12 — Ads Pipeline

**Depends on:** M2, M5, M7
**Blocks:** M13 (campaign approvals)

### M12.T1: Meta Marketing API client
**Files:**
- Create: `backend/src/integrations/meta/client.ts` — wraps the Meta Graph API for ads
- Auth via System User token (Ridaa provisions in M0)
- Test: read account info, list existing campaigns

**Commit:** `feat(integrations/meta): client`

### M12.T2: Metrics poller
**Files:**
- Create: `backend/src/workers/meta-metrics-poll.ts` — every 15 min, fetches CTR/impressions/frequency/spend/conversions per ad
- Writes to `ad_metrics_hourly`
- Test: stub Meta, assert rows written with correct shape

**Commit:** `feat(ads): 15-min metrics poller`

### M12.T3: Ads Manager agent — fatigue detection
**Files:**
- Create: `backend/src/agents/ads-manager/index.ts` — continuous loop
- Create: `backend/src/agents/ads-manager/fatigue.ts` — CTR drop > 30% or frequency > 3 → emit `CAMPAIGN.FATIGUE_DETECTED`
- Test: synthetic metrics → expected fatigue calls

**Commit:** `feat(agents/ads-manager): fatigue detection`

### M12.T4: Creative Brief Writer
**Files:**
- Create: `backend/src/agents/creative-brief-writer.ts` — Sonnet, given product+angle+psychology+brand, outputs Nano Banana Pro-ready prompt
- Pulls AW Assur Conseil validated principles from `Assuryal/AW Assur Conseil/CLAUDE.md` + `LOG.md` as system context
- Substitutes Assuryal brand spec
- Test: brief request for "Auto Bonus prix-bas" returns prompt with brush typography + green palette + sandero car

**Commit:** `feat(agents): Creative Brief Writer`

### M12.T5: Creative Generator subprocess wrapper
**Files:**
- Create: `backend/src/agents/creative-generator.ts` — spawns `image_or.py` subprocess with prompt + brand assets path; returns PNG paths
- Test: produces a PNG file at the expected path

**Commit:** `feat(agents): Creative Generator (image_or.py wrapper)`

### M12.T6: Campaign launch + approval flow
**Files:**
- Modify: `agents/ads-manager/index.ts` — on creative ready, emit `CAMPAIGN.HUMAN_APPROVAL_REQUESTED`
- After approval, post to Meta via `integrations/meta/client.ts`
- Test: synthetic flow blocked until approval is resolved

**Commit:** `feat(ads): campaign launch with human approval gate`

### M12.T7: Lookalike audience builder
**Files:**
- Create: `backend/src/agents/audience-builder.ts` — pulls closed-won leads from DB, uploads to Meta as Custom Audience seed, requests Lookalike
- Weekly cron via BullMQ
- Test: stubbed Meta, assert correct seed shape uploaded

**Commit:** `feat(ads): lookalike audience builder`

---

# M13 — Human Action Channel (dual-surface)

**Depends on:** M3, M4 (WA), M5+ (sources of actions)
**Blocks:** M14 (queue UI), M15

### M13.T1: human_actions lifecycle
**Files:**
- Create: `backend/src/human-actions/service.ts` — `create(action)`, `list({status})`, `resolve(id, choice, by, source)`
- Test: lifecycle assertions (pending → resolved, idempotent resolve)

**Commit:** `feat(human-actions): lifecycle service`

### M13.T2: Reporter Agent — outbound to WA group
**Files:**
- Create: `backend/src/agents/reporter/index.ts` — singleton
- Create: `backend/src/agents/reporter/templates.ts` — French templates for each severity tier
- Subscribes to `HUMAN_ACTION.REQUESTED`, posts to WA group via WAHA
- Test: stubbed WAHA, action created → message sent within 5s (matches §17.4)

**Commit:** `feat(agents/reporter): outbound to WA group`

### M13.T3: Reporter Agent — inbound WA parser
**Files:**
- Create: `backend/src/agents/reporter/parser.ts` — matches numbered replies, button presses, free-text to actions
- Verifies sender against Ridaa/Achraf whitelist
- Test: 6 reply patterns → correct action resolution

**Commit:** `feat(agents/reporter): inbound parser`

### M13.T4: Dual-surface idempotency
**Files:**
- Modify: `human-actions/service.ts` — `resolve()` is idempotent + broadcasts status to both surfaces
- Test: resolve from admin → WA thread updated; resolve from WA → admin updated; double-resolve → second is no-op

**Commit:** `feat(human-actions): dual-surface idempotency`

### M13.T5: Severity tiers + SLA timers
**Files:**
- Create: `backend/src/human-actions/sla.ts` — per-tier SLA + escalation if exceeded
- Critical actions also trigger audible WA notification (mention `@Ridaa` `@Achraf`)
- Test: tier escalation after timer expiry

**Commit:** `feat(human-actions): severity SLAs`

### M13.T6: Reporter daily digest
**Files:**
- Create: `backend/src/agents/reporter/daily-digest.ts` — Opus 4.7, summarizes 24h: leads, closes, ad performance, blockers, suggested actions
- Cron 09:00 CET
- Test: synthetic 24h data → digest covers all sections

**Commit:** `feat(agents/reporter): daily digest`

---

# M14 — Admin Panel

**Depends on:** M3 (realtime), M5 (data), runs partly in parallel with M5-M13
**Blocks:** none — final deploy depends on it

### M14.T1: Auth (WebAuthn + magic link)
**Files:**
- Create: `admin/src/auth/` — Lucia or Auth.js setup, WebAuthn + magic-link strategies
- Two-user store (Ridaa, Achraf); admin SPA gated
- Test: passkey enroll + login flow e2e

**Commit:** `feat(admin/auth): WebAuthn + magic link`

### M14.T2: Realtime subscription hook
**Files:**
- Create: `admin/src/realtime/use-realtime.ts` — WebSocket to backend, subscribes to channels, integrates with react-query cache
- Backend: `backend/src/routes/realtime.ts` — WS handshake + channel routing
- Test: insert agent_message → admin tile updates within 1s

**Commit:** `feat(admin/realtime): WebSocket + react-query integration`

### M14.T3: `/dashboard` route
**Files:**
- Create: `admin/src/routes/dashboard.tsx` — KPI cards: leads today, ads spend, MQL→close, response time, agent token usage, per-channel mix
- Uses recharts for time-series
- Test: e2e with seed data — all cards render expected numbers

**Commit:** `feat(admin/dashboard): KPI cards`

### M14.T4: `/leads` + `/leads/:id`
**Files:**
- Create: `admin/src/routes/leads.tsx` — table with filters
- Create: `admin/src/routes/leads/[id].tsx` — full timeline (turns + maxance_actions + emails + voice + agent decisions)
- Test: e2e — seed lead with multi-channel history → timeline renders chronologically

**Commit:** `feat(admin): leads list + detail timeline`

### M14.T5: `/queue/human`
**Files:**
- Create: `admin/src/routes/queue.tsx` — pending actions w/ inline approve/reject/revise/call
- Realtime update on changes from WA group
- Test: WA approval → row removed from queue within 1s

**Commit:** `feat(admin): human action queue`

### M14.T6: `/agents` registry + prompt editor
**Files:**
- Create: `admin/src/routes/agents.tsx` — list, status, cost
- Create: `admin/src/routes/agents/[role].tsx` — prompt editor (monaco-react), tool toggles, model picker
- Backend: `backend/src/routes/agents.ts` — CRUD on agent config; every change writes `audit_log`
- Test: change prompt → next agent message uses new prompt; audit row present

**Commit:** `feat(admin/agents): registry + prompt editor`

### M14.T7: `/integrations` health & toggles
**Files:**
- Create: `admin/src/routes/integrations.tsx` — health pings on each integration (WAHA, Meta, HubSpot, Maxance, OpenRouter, Anthropic, Pipecat, OVH, BillionMail)
- Toggle switches per integration; off = synthesize-only mode
- Test: kill WAHA container → health tile turns red within 30s

**Commit:** `feat(admin): integrations panel`

### M14.T8: `/knowledge` semantic search
**Files:**
- Create: `admin/src/routes/knowledge.tsx` — search bar over `knowledge_chunks` + `customer_facts`
- Backend: `backend/src/routes/knowledge.ts` — vector search endpoint
- Test: query → relevant chunks returned

**Commit:** `feat(admin): knowledge search`

### M14.T9: `/campaigns`
**Files:**
- Create: `admin/src/routes/campaigns.tsx` — tree view, performance, creatives, approval gate
- Test: campaigns + ads + creatives render with metrics

**Commit:** `feat(admin): campaigns tree`

### M14.T10: `/team-chat`
**Files:**
- Create: `admin/src/routes/team-chat.tsx` — mirror of WA group + admin-side comments to Reporter
- Test: WA group message → appears within 1s; reply from admin → sent to WA

**Commit:** `feat(admin): team chat mirror`

### M14.T11: `/office` (2D isometric)
**Files:**
- Create: `admin/src/routes/office.tsx` — PixiJS scene
- Create: `admin/src/office/scene.ts` — floor plan, sprite definitions, animation states
- Create: `admin/src/office/state-bridge.ts` — maps `agent_messages` + agent statuses to sprite states / walking paths
- Assets: sprite sheets for 5 persistent agents + 9 ephemeral; floor plan tiles
- Test: e2e — spawn Sales Agent for a lead → sprite walks to a desk; QUOTE.REQUESTED → walks to Maxance Booth; click sprite → side panel opens

**Effort note:** This is the largest single admin task (~5-7 days). Worth treating as a sub-plan.

**Commit:** `feat(admin/office): 2D isometric live view`

---

# M15 — Supervisor + Team Manager

**Depends on:** M3, M13
**Blocks:** M16

### M15.T1: Supervisor singleton skeleton
**Files:**
- Create: `backend/src/agents/supervisor/index.ts` — singleton, two faces (internal Team Manager + external Reporter)
- Reads all `agent_messages` + has full read on DB
- Test: spawn, assert it consumes specific intents

**Commit:** `feat(agents/supervisor): skeleton`

### M15.T2: Kill switch + priority adjust
**Files:**
- Modify: `agents/registry.ts` — `kill(role, instanceId)`, `setPriority(role, p)`
- Modify: `agents/supervisor/index.ts` — uses these to manage misbehaving agents
- Admin UI: button to kill or boost an agent
- Test: kill an instance → no further messages consumed by it

**Commit:** `feat(supervisor): kill + priority`

### M15.T3: Daily strategy review (Opus 4.7)
**Files:**
- Create: `backend/src/agents/supervisor/strategy.ts` — cron 02:00 CET, Opus 4.7
- Reviews 24h trends; proposes prompt tweaks, model swaps, kill suggestions for underperformers
- Surfaces as human-action `CONFIG_CHANGE_PROPOSED`
- Test: simulate poor performance → expected proposal

**Commit:** `feat(supervisor): nightly Opus strategy review`

### M15.T4: Cross-agent conflict arbitration
**Files:**
- Create: `backend/src/agents/supervisor/arbitration.ts` — detects loops or conflicting intents on same correlation_id
- Resolves by escalation or one-side-wins rule
- Test: synthetic loop between two agents → arbitration triggers, loop breaks

**Commit:** `feat(supervisor): arbitration`

---

# M16 — Observability + Backups + Polish

**Depends on:** all
**Blocks:** M17

### M16.T1: Loki + Grafana stack
**Files:**
- Modify: `infra/docker-compose.dev.yml` — add Loki + Grafana
- Modify: every container Dockerfile — log to stdout in JSON
- Create: `infra/grafana/dashboards/` — F16 dashboards (latency SLOs, agent activity, error rates, cost)
- Test: e2e — Grafana shows live data from each container

**Commit:** `feat(infra): Loki + Grafana + F16 dashboards`

### M16.T2: Performance SLO monitoring
**Files:**
- Create: `backend/src/observability/slos.ts` — emits per-flow latency metrics
- Grafana alerting on SLO breaches (e.g., `lead_to_opener > 60s`)
- Test: synthetic slow path → alert fires

**Commit:** `feat(observability): SLO metrics + alerting`

### M16.T3: Backups
**Files:**
- Create: `infra/backups/` — hourly Postgres logical dump cron + daily snapshot to Hostinger backup bucket
- Test: backup created, restore from backup brings DB back to known state

**Commit:** `feat(infra): postgres backup + restore`

### M16.T4: Runbooks
**Files:**
- Create: `Assuryal/F16/docs/runbooks/incident-response.md`
- Create: `Assuryal/F16/docs/runbooks/secret-rotation.md`
- Create: `Assuryal/F16/docs/runbooks/maxance-relogin.md`
- Create: `Assuryal/F16/docs/runbooks/waha-number-ban.md`

**Commit:** `docs(runbooks): V1 ops runbooks`

### M16.T5: Spend caps + alerts
**Files:**
- Backend: per-day token budget enforced per agent role + global cap
- Alert via Reporter if any agent crosses 80% of daily budget
- Test: synthetic burn → alert fires

**Commit:** `feat(observability): per-agent spend cap + alerts`

### M16.T6: Pen-test of public endpoints
**Files:**
- Create: `Assuryal/F16/docs/security/pentest-checklist.md`
- Run: OWASP ZAP scan against admin + webhooks; address findings
- Test: scan clean

**Commit:** `chore(security): pentest pass`

---

# M17 — Pre-launch & Soft Go-live

**Depends on:** M16
**Blocks:** revenue

### M17.T1: Internal dry-run
**Action:** Ridaa + Achraf simulate 10 leads as if they were customers (use second WhatsApp numbers); F16 handles end-to-end. No real customers yet.

**Acceptance:** all 10 cycle through without human intervention beyond expected approval gates.

### M17.T2: Soft launch — 5 leads/day cap
**Files:**
- Backend: `backend/src/limits/lead-rate.ts` — enforces daily cap, queues overflow for next day
- Set initial cap = 5 leads/day

**Action:** Open Meta ads to a low-volume audience; first 5 real leads/day route to F16.

**Acceptance:** 1 week of operation. Daily Reporter digest reviewed every morning. Incident rate < 1 per day.

### M17.T3: Ramp
**Action:** Raise cap weekly (5 → 15 → 30 → 50 → 100 leads/day) as long as SLOs hold and conversion is stable.

### M17.T4: V1 launch retrospective
**File:** `Assuryal/F16/docs/plans/2026-XX-XX-v1-retro.md` — what worked, what surprised us, what's in V2 backlog.

---

## How to execute this plan

Two ways, your choice:

### Option 1 — Subagent-driven (in this session)
I dispatch a fresh subagent per task, you review the diff between tasks, fast iteration. Required sub-skill: `superpowers:subagent-driven-development`. Best when you want close oversight and parallel agents working M-streams.

### Option 2 — Parallel session (separate)
You open a new session inside `Assuryal/F16/` and use `superpowers:executing-plans`. Batch execution with checkpoint reviews at end of each milestone. Best when you want to step away while several milestones run.

---

*Plan saved 2026-05-17. Ridaa to pick execution mode.*
