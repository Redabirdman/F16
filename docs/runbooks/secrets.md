# F16 Secrets Runbook

## 1. Purpose

This runbook is the single source of truth for every credential F16 depends on:
what each secret is, which EasyPanel container holds it, who issued it, who
holds the canonical value, how often it rotates, and the procedure for both
scheduled and emergency rotation. The consolidated env reference lives at
[`../../.env.template`](../../.env.template); this document explains the
people-and-process side of those values. Read this end-to-end before
provisioning a new environment, rotating a key, or responding to a suspected
leak.

## 2. Inventory

Each row maps one env-var (or logical secret) to its target EasyPanel app,
issuer console, the human responsible for the canonical copy in the password
manager, rotation cadence, and the date of the most recent rotation. "Last
rotated" is `TBD` until the first production deployment populates it.

| Name                                 | EasyPanel app(s)                                   | Source / issuer                            | Holder                                   | Rotation cadence                          | Last rotated |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------------ | ---------------------------------------- | ----------------------------------------- | ------------ |
| `DATABASE_URL`                       | f16-postgres (canonical), f16-backend (consumer)   | EasyPanel Postgres app                     | Ridaa                                    | 180 days                                  | TBD          |
| `REDIS_URL`                          | f16-redis (canonical), f16-backend (consumer)      | EasyPanel Redis app                        | Ridaa                                    | 180 days                                  | TBD          |
| `ANTHROPIC_API_KEY`                  | f16-backend, f16-stagehand                         | console.anthropic.com                      | Achraf                                   | 90 days                                   | TBD          |
| `OPENROUTER_API_KEY`                 | f16-backend                                        | openrouter.ai                              | Achraf                                   | 90 days                                   | TBD          |
| `WAHA_API_KEY`                       | f16-backend                                        | WAHA admin dashboard                       | Ridaa                                    | 180 days                                  | TBD          |
| `OVH_SIP_USERNAME` / `_PASSWORD`     | f16-pipecat                                        | OVH telephony console                      | Ridaa                                    | 180 days                                  | TBD          |
| `DEEPGRAM_API_KEY`                   | f16-pipecat                                        | console.deepgram.com                       | Achraf                                   | 90 days                                   | TBD          |
| `AZURE_SPEECH_KEY`                   | f16-pipecat                                        | portal.azure.com                           | Achraf                                   | 90 days                                   | TBD          |
| `BILLIONMAIL_SMTP_PASSWORD`          | f16-backend, f16-admin (magic links)               | BillionMail admin UI                       | Ridaa                                    | 180 days                                  | TBD          |
| `BILLIONMAIL_DKIM_PRIVATE_KEY`       | f16-billionmail                                    | BillionMail generates during DKIM setup    | Ridaa                                    | On-incident                               | TBD          |
| `SMS_GATEWAY_USERNAME` / `_PASSWORD` | f16-backend                                        | android-sms-gateway device pairing         | Ridaa                                    | 180 days                                  | TBD          |
| `MAXANCE_USERNAME` / `_PASSWORD`     | f16-stagehand                                      | Maxance webapp (provisioned by partner)    | Ridaa                                    | 180 days                                  | TBD          |
| `META_ACCESS_TOKEN`                  | f16-backend                                        | business.facebook.com (system user)        | Achraf                                   | 60 days                                   | TBD          |
| `META_APP_SECRET`                    | f16-backend                                        | developers.facebook.com                    | Achraf                                   | On-incident                               | TBD          |
| `HUBSPOT_ACCESS_TOKEN`               | f16-backend                                        | HubSpot → Settings → Integrations          | Ridaa                                    | 180 days                                  | TBD          |
| `PII_ENCRYPTION_KEY`                 | f16-backend, f16-stagehand                         | `openssl rand -base64 32` (self-generated) | Shared (Ridaa + Achraf, 1Password vault) | On-incident only (re-encryption required) | TBD          |
| `HMAC_WEBHOOK_SECRET`                | f16-backend                                        | `openssl rand -hex 32` (self-generated)    | Shared                                   | 180 days                                  | TBD          |
| `ADMIN_JWT_SECRET`                   | f16-backend                                        | `openssl rand -hex 64` (self-generated)    | Shared                                   | 90 days                                   | TBD          |
| `LOKI_BASIC_AUTH`                    | f16-backend, f16-pipecat, f16-stagehand, f16-admin | Caddy basic-auth (Ridaa generates)         | Ridaa                                    | 180 days                                  | TBD          |
| `GRAFANA_ADMIN_PASSWORD`             | (Grafana app, not F16-managed)                     | Grafana initial setup                      | Ridaa                                    | On first login + 180 days                 | TBD          |

Holders maintain the canonical copy in the shared 1Password vault `F16-Production`.
Any change to a row above MUST be reflected by updating "Last rotated" in the same commit
that performs the rotation.

## 3. EasyPanel setup checklist (for Ridaa, first deployment)

This is the order to bring up a fresh F16 stack on EasyPanel. Each step is
self-contained; treat the boxes as a literal checklist.

### 3.1 Create the seven EasyPanel apps

In the EasyPanel project, create these apps (names are load-bearing — internal
DNS resolves to the app name):

1. `f16-postgres` — EasyPanel built-in Postgres template, version 16, with the
   `pgvector` and `pgcrypto` extensions enabled. This is a managed service —
   EasyPanel issues `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
   directly on the Postgres app; assemble `DATABASE_URL` from them and paste
   it into `f16-backend`.
2. `f16-redis` — EasyPanel built-in Redis template with AOF persistence on.
   Same pattern: EasyPanel manages it, `f16-backend` consumes `REDIS_URL`.
3. `f16-backend` — From this repo, `backend/Dockerfile`, build context = repo
   root. Internal port 3001, not public.
4. `f16-admin` — From this repo, `admin/Dockerfile`, build context = repo
   root. Internal port 8080, publicly exposed via Caddy on the admin domain
   Ridaa picks.
5. `f16-pipecat` — From this repo, `pipecat/Dockerfile`, build context =
   `pipecat/`. Internal port 8000, not public.
6. `f16-stagehand` — From this repo, `stagehand/Dockerfile`, build context =
   repo root. Internal port 4001, not public.
7. `f16-billionmail` — External image (deferred until outbound mail is wired
   in). When it lands: SMTP-out, TLS cert + MX + SPF + DKIM all in place
   before sending the first message.

`waha` already exists on the VPS — do not recreate it; F16 only consumes it.

### 3.2 Paste env values per app

For each app: EasyPanel → App → Environment → paste the relevant rows. The
consolidated [`.env.template`](../../.env.template) is the master checklist.
Mapping by app:

- **f16-backend** — `F16_ENV`, `F16_INSTANCE_ID`, `F16_PIPECAT_URL`,
  `F16_STAGEHAND_URL`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`,
  `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `WAHA_BASE_URL`, `WAHA_API_KEY`,
  `BILLIONMAIL_SMTP_*`, `BILLIONMAIL_FROM_ADDRESS`, `SMS_GATEWAY_*`,
  `META_*`, `HUBSPOT_*`, `PII_ENCRYPTION_KEY`, `HMAC_WEBHOOK_SECRET`,
  `ADMIN_JWT_SECRET`, `ADMIN_JWT_TTL_SECONDS`, `ADMIN_MAGIC_LINK_FROM`,
  `LOKI_PUSH_URL`, `LOKI_BASIC_AUTH`.
- **f16-admin** — `F16_ENV`, `F16_INSTANCE_ID`, `LOG_LEVEL`, `LOKI_PUSH_URL`,
  `LOKI_BASIC_AUTH`. The SPA itself talks to the backend via relative URLs;
  no API keys ever reach the browser bundle.
- **f16-pipecat** — `F16_ENV`, `F16_INSTANCE_ID`, `LOG_LEVEL`,
  `F16_BACKEND_URL`, `DEEPGRAM_API_KEY`, `AZURE_SPEECH_KEY`,
  `AZURE_SPEECH_REGION`, `OVH_SIP_USERNAME`, `OVH_SIP_PASSWORD`,
  `OVH_SIP_DOMAIN`, `OVH_SIP_DID`, `LOKI_PUSH_URL`, `LOKI_BASIC_AUTH`.
- **f16-stagehand** — `F16_ENV`, `F16_INSTANCE_ID`, `LOG_LEVEL`,
  `F16_BACKEND_URL`, `ANTHROPIC_API_KEY`, `STAGEHAND_LLM_MODEL`,
  `STAGEHAND_BROWSER_HEADLESS`, `STAGEHAND_BROWSER_TIMEOUT_MS`,
  `MAXANCE_BASE_URL`, `MAXANCE_USERNAME`, `MAXANCE_PASSWORD`,
  `PII_ENCRYPTION_KEY`, `LOKI_PUSH_URL`, `LOKI_BASIC_AUTH`.
- **f16-billionmail** (when activated) — SMTP listener config plus
  `BILLIONMAIL_DKIM_PRIVATE_KEY`.
- **f16-postgres / f16-redis** — EasyPanel-managed; only the credentials
  EasyPanel itself prompts for. Nothing from this repo's env template gets
  pasted into them.

### 3.3 What must be set BEFORE first start vs what can wait

**Required before first start of `f16-backend`:**

- `F16_ENV`, `F16_INSTANCE_ID`, `LOG_LEVEL`
- `DATABASE_URL`, `REDIS_URL`
- `PII_ENCRYPTION_KEY`, `HMAC_WEBHOOK_SECRET`, `ADMIN_JWT_SECRET`
- `ANTHROPIC_API_KEY` (the backend's healthcheck does not call the LLM, but
  any agent run will crash without it — set this on day one)

**Required before first start of `f16-pipecat`:** only `F16_ENV`,
`F16_INSTANCE_ID`, `LOG_LEVEL` — voice creds are not consumed until M10.

**Required before first start of `f16-stagehand`:** `F16_ENV`,
`F16_INSTANCE_ID`, `LOG_LEVEL`, `ANTHROPIC_API_KEY`, `PII_ENCRYPTION_KEY`.
Maxance creds are not consumed until the M8 login flow runs.

**Can wait (set when the corresponding feature ships):** Meta, HubSpot,
SMS gateway, BillionMail SMTP, OVH SIP, Deepgram, Azure Speech, all DKIM
material. The services start without them; the integrations panel just shows
red until they're populated.

After pasting env for an app, redeploy it from the EasyPanel UI so the new
process inherits the values.

## 4. First-time rotation tasks for V1 launch

These run once, during M0 → V1 cutover:

- [ ] **Rotate the leaked OpenRouter key (M0.T1).** STATUS: TODO at time of
      writing — the leaked value remains usable until revoked. Issue a new
      key at openrouter.ai, paste into `f16-backend` env, restart, verify
      `/integrations` green, then revoke the old key in the OpenRouter
      dashboard. Mark this checkbox done in-commit.
- [ ] **Issue new Anthropic API key with €1k monthly cap (M0.T2).** Create
      at console.anthropic.com → API Keys, set the org-level spend limit to
      €1k, paste the new key into `f16-backend` AND `f16-stagehand` env.
- [ ] **Generate `PII_ENCRYPTION_KEY`** — `openssl rand -base64 32`. Single
      value, MUST be identical across `f16-backend` and `f16-stagehand`
      (encrypt/decrypt symmetry). Store the canonical copy in 1Password
      vault `F16-Production`.
- [ ] **Generate `HMAC_WEBHOOK_SECRET`** — `openssl rand -hex 32`. Used by
      the public lead-intake webhook (Meta / form vendors send the signed
      payload, backend verifies).
- [ ] **Generate `ADMIN_JWT_SECRET`** — `openssl rand -hex 64`. Used to sign
      admin-panel session JWTs.

When each task is done, change `[ ]` to `[x]` in the same commit that
performs the rotation, and update the matching row in §2's "Last rotated"
column.

## 5. Rotation procedure (generic)

Apply this for any scheduled rotation:

1. **Issue the new value** at the source console (Anthropic dashboard,
   OpenRouter, etc.) without revoking the old one yet.
2. **Paste the new value** into EasyPanel env for every app listed in §2 for
   that secret. Double-check every app — a key shared across two services
   that's only rotated in one will fail decrypt/auth in the other.
3. **Trigger an app restart** in EasyPanel (Deploy button) for each affected
   app so the new process picks up the env. Wait for healthcheck green.
4. **Verify** in admin `/integrations` that the integration health for that
   vendor is green. If the panel shows red, roll back env, debug, then retry.
5. **Revoke the old value** at the source console only after the new value
   is verified live. Never revoke before redeploy — that's a self-inflicted
   outage.
6. **Log the rotation** by updating the "Last rotated" cell for that row in
   §2 of this document, and commit with message
   `chore(secrets): rotate <NAME>`.

## 6. Emergency rotation (suspected compromise)

If a key is suspected leaked — pushed to a public repo, pasted in chat,
exfiltrated, observed in unexpected billing, etc. — invert the normal
procedure: **revoke first, ask questions later.**

1. **Revoke the old value at the source immediately.** Accept the brief
   outage. A burned key in attacker hands is worse than 5 minutes of red
   health.
2. **Stop accepting webhook traffic** for the affected surface area — apply
   a Caddy firewall rule or EasyPanel network deny so no further signed (or
   forged) requests reach the backend until the new HMAC is live.
3. **Rotate**: issue a new value, paste into every EasyPanel app from §2,
   restart, verify green.
4. **Audit logs** for misuse. Pull Loki for the time window between leak
   suspicion and revocation. For LLM keys, also pull the vendor's usage
   dashboard. Look for: unfamiliar IPs, unusual rate, off-pattern model
   calls, traffic from outside expected geographies.
5. **File an incident** in the shared incident log and notify both
   stakeholders (Ridaa + Achraf) the same day, even if the audit comes back
   clean. Record: what leaked, suspected vector, time to revoke, time to
   rotate, audit findings, and any follow-up hardening.

## 7. Never rules

- Never commit a populated `.env`.
- Never paste secrets in chat / WhatsApp / Slack / email.
- Never log secrets at any level (`debug`, `trace`, error context, span
  attributes — anywhere).
- Never share secrets verbally — always via the shared 1Password vault.
- Never reuse secrets across environments — dev, staging, and prod each have
  their own, generated independently.
