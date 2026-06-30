# F16 Secrets Runbook

> **Refreshed 2026-06-30.** This replaces the original VPS/EasyPanel era runbook.
> F16 no longer runs on a Hostinger VPS / EasyPanel. **This dedicated PC is
> production** (Windows on ARM64). Deprecated since the original draft and
> intentionally NOT in this inventory: EasyPanel, `f16-pipecat`/Pipecat,
> Deepgram, Azure Speech, `f16-stagehand`/Stagehand, BillionMail, the
> android SMS gateway, Loki/Grafana. Voice is now OpenAI Realtime native SIP
> (+ Asterisk/OVH in WSL); email is Gmail/Workspace SMTP; Maxance is driven by
> the Chrome extension; the admin is published via a Cloudflare Tunnel behind
> Cloudflare Access (Google SSO).

## 1. Purpose

Single source of truth for every credential F16 depends on: what each secret is,
which surface consumes it, who issues it, who holds the canonical value, and the
procedure for scheduled + emergency rotation.

**Where secrets live now:** one file, **`backend/.env`** on this PC. It is
git-ignored (`.gitignore`: `.env`, `.env.local`, `.env.*.local`) and is
**blocked from direct read/write by the assistant** — edit it ONLY via
`backend/scripts/update-env.ts`:

```bash
cd backend
SETENV_SOME_KEY="value" SETENV_OTHER_KEY="value" npx tsx scripts/update-env.ts
```

`update-env.ts` upserts keys in place (no duplicate shadowing) and never echoes
values to argv. The backend loads `.env` at boot via `dotenv` — **booting the
backend = fully live** (real WhatsApp/voice/email; compliance is the only gate,
there is no "safe mode"). After editing `.env`, restart the backend for the new
values to take effect.

## 2. Inventory (current)

Holder = who keeps the canonical copy. "Source" = where the value is issued.
Rotation cadence is guidance, not enforced. Group keys travel together.

### Core infra (local to this PC)

| Key                  | Consumer | Source                                                                                        | Holder                | Rotation         |
| -------------------- | -------- | --------------------------------------------------------------------------------------------- | --------------------- | ---------------- |
| `DATABASE_URL`       | backend  | local Docker Postgres `f16-postgres-dev` (host `:5435`, db `f16`, pgvector+pgcrypto)          | Ridaa                 | on-incident      |
| `REDIS_URL`          | backend  | local Docker Redis `f16-redis-dev` (host `:6380`)                                             | Ridaa                 | on-incident      |
| `PII_ENCRYPTION_KEY` | backend  | self-gen `openssl rand -base64 32` — **AES key for all PII**; rotating requires re-encryption | Shared (Ridaa+Achraf) | on-incident only |
| `BULLMQ_PREFIX`      | backend  | static (default `f16`)                                                                        | —                     | n/a              |
| `LOG_LEVEL`          | backend  | static                                                                                        | —                     | n/a              |

### LLM

| Key                  | Consumer                                      | Source                | Holder | Rotation |
| -------------------- | --------------------------------------------- | --------------------- | ------ | -------- |
| `ANTHROPIC_API_KEY`  | backend (all agents' brain)                   | console.anthropic.com | Achraf | 90d      |
| `OPENROUTER_API_KEY` | backend/scripts (Nano-Banana office + ad art) | openrouter.ai         | Achraf | 90d      |

### WhatsApp (cloud WAHA — `waha.automeapp.cloud`, sender 212674009900)

| Key                                                               | Consumer                     | Source                             | Holder | Rotation  |
| ----------------------------------------------------------------- | ---------------------------- | ---------------------------------- | ------ | --------- |
| `WAHA_BASE_URL`, `WAHA_API_KEY`, `WAHA_SESSION`                   | backend                      | cloud WAHA instance                | Ridaa  | 180d      |
| `WAHA_HMAC_ALGO` (= `sha512`) + WAHA webhook HMAC secret          | backend (inbound verify)     | WAHA config                        | Ridaa  | 180d      |
| `HUMAN_ACTION_GROUP_CHAT_ID`, `HUMAN_ACTION_AUTHORISED_RESOLVERS` | backend (operator approvals) | the WA chat id + operator phone(s) | Ridaa  | on-change |

### Voice (OpenAI Realtime native SIP + Asterisk/OVH in WSL)

| Key                                                                                                                                                            | Consumer                                    | Source                      | Holder | Rotation  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------- | ------ | --------- |
| `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`                                                                                                                      | backend (Realtime SIP webhook + control WS) | platform.openai.com         | Achraf | 90d       |
| `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`                                                                                                               | backend                                     | static config               | —      | n/a       |
| `ASTERISK_OVH_TRUNK` + OVH SIP trunk creds                                                                                                                     | Asterisk (WSL)                              | OVH telephony console       | Ridaa  | 180d      |
| `ASTERISK_ARI_URL/_USER/_PASSWORD`, `ASTERISK_DIALPLAN_CONTEXT`, `ASTERISK_OPENAI_CONTEXT`                                                                     | backend↔Asterisk                            | local Asterisk config (WSL) | Ridaa  | on-change |
| `F16_ASTERISK_TRANSPORT`, `F16_VOICE_NATIVE_SIP`, `F16_VOICE_WATCHDOG`, `VOICE_CALLER_ID`, `WSL_DISTRO`, `F16_SESSION_LOOKUP_SECRET`, `AUDIOSOCKET_HOST/_PORT` | backend/voice                               | static / self-gen           | Ridaa  | on-change |

### Email (Gmail / Google Workspace SMTP)

| Key                                                                   | Consumer                | Source                                                                | Holder | Rotation    |
| --------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------- | ------ | ----------- |
| `SMTP_HOST` (`smtp.gmail.com`), `SMTP_PORT` (`587`), `SMTP_FROM_NAME` | backend (email channel) | static                                                                | —      | n/a         |
| `SMTP_USER` (`contact@assuryalconseil.fr`), `SMTP_FROM_ADDRESS`       | backend                 | the Workspace mailbox                                                 | Ridaa  | on-change   |
| `SMTP_PASS`                                                           | backend                 | **Google App Password** ("F16 backend") — requires 2FA on the account | Ridaa  | on-incident |

> Legacy `BILLIONMAIL_SMTP_*` / `BILLIONMAIL_FROM_*` are still accepted as a
> fallback by `loadSmtpConfigFromEnv`, but the live config uses `SMTP_*`.
> Deliverability DNS on Cloudflare zone `assuryalconseil.fr`: SPF includes
> `_spf.google.com`; DKIM `google._domainkey` published; DMARC `p=none`.

### Maxance (broker — Chrome extension driver)

| Key                                                                  | Consumer                   | Source                    | Holder | Rotation |
| -------------------------------------------------------------------- | -------------------------- | ------------------------- | ------ | -------- |
| `MAXANCE_DRIVER` (= `chrome_extension`), `MAXANCE_EXTENSION_WS_PORT` | backend (maxance-operator) | static                    | Ridaa  | n/a      |
| `MAXANCE_CONFIRM_FORCE_DRYRUN`, `MAXANCE_SUBSCRIPTION_FORCE_DRYRUN`  | backend                    | safety flags (default ON) | Ridaa  | n/a      |

> Maxance login is performed in the operator's real Chrome via the extension
> (Cloudflare-proof) — there are no Playwright/Stagehand creds in `.env` anymore.
> `STAGEHAND_BASE_URL`/`STAGEHAND_HMAC_SECRET`, if still present, are vestigial
> (the stagehand workspace was deleted) and safe to remove.

### Meta Ads

| Key                                                                                                                                                             | Consumer            | Source                              | Holder | Rotation    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------- | ------ | ----------- |
| `META_SYSTEM_USER_TOKEN`                                                                                                                                        | backend (Graph API) | business.facebook.com (system user) | Achraf | 60d         |
| `META_APP_SECRET`                                                                                                                                               | backend             | developers.facebook.com             | Achraf | on-incident |
| `META_AD_ACCOUNT_ID`, `META_PAGE_ID`, `META_INSTAGRAM_USER_ID`, `META_GRAPH_API_VERSION`, `META_DSA_BENEFICIARY`, `META_DSA_PAYOR`, `META_LEADGEN_VERIFY_TOKEN` | backend             | Meta config / self-set              | Achraf | on-change   |

### HubSpot

| Key                                         | Consumer             | Source                | Holder | Rotation |
| ------------------------------------------- | -------------------- | --------------------- | ------ | -------- |
| `HUBSPOT_API_KEY` (Service Key `pat-eu1-…`) | backend (CRM mirror) | HubSpot → private app | Ridaa  | 180d     |
| `F16_HUBSPOT_ACTIVITIES` (= `true`)         | backend              | flag                  | Ridaa  | n/a      |

### Cloudflare (tunnel + Access + DNS)

| Key                                                                           | Consumer                                                                   | Source                | Holder | Rotation    |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------- | ------ | ----------- |
| `CLOUDFLARE_API_TOKEN`                                                        | backend/scripts (DNS, tunnel, Access) — full-perm, **account `89eba934…`** | dash.cloudflare.com   | Ridaa  | 180d        |
| `CLOUDFLARE_TUNNEL_TOKEN` (run token), `CLOUDFLARE_TUNNEL_NAME` (`f16-admin`) | cloudflared                                                                | Cloudflare Zero Trust | Ridaa  | on-incident |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `F16_ADMIN_HOSTNAME`           | scripts                                                                    | Cloudflare            | Ridaa  | n/a         |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`                        | Access Google IdP (admin SSO)                                              | Google Cloud Console  | Ridaa  | on-incident |
| `ADMIN_ALLOWED_EMAILS`                                                        | Access allow policy                                                        | the operator gmails   | Ridaa  | on-change   |

### Admin / metrics / flags

| Key                                          | Consumer                                   | Source                          | Holder | Rotation |
| -------------------------------------------- | ------------------------------------------ | ------------------------------- | ------ | -------- |
| `ADMIN_BEARER_TOKEN`, `METRICS_BEARER_TOKEN` | backend (admin/metrics auth behind Access) | self-gen `openssl rand -hex 32` | Shared | 90d      |
| `SUPERVISOR_STRATEGY_ENABLED`                | backend (default off — daily Opus burn)    | flag                            | Ridaa  | n/a      |

Canonical copies live in the shared password vault. Any rotation should be
committed with `chore(secrets): rotate <NAME>` (the value never appears in the
commit — only the runbook note / "Last rotated" if you track it).

## 3. First-run setup (this PC)

1. **Docker** — `f16-postgres-dev` (`:5435`, pgvector+pgcrypto, db `f16`) and
   `f16-redis-dev` (`:6380`). `DATABASE_URL`/`REDIS_URL` point at these. Run
   migrations with drizzle-kit before first boot.
2. **`backend/.env`** — populate the keys above via `update-env.ts`. Minimum to
   boot the backend: `DATABASE_URL`, `REDIS_URL`, `PII_ENCRYPTION_KEY`,
   `ANTHROPIC_API_KEY`. Everything else makes its integration go green in admin
   `/integrations` when present and shows "unconfigured" (grey) when absent.
3. **Run** — backend: `cd backend && env PORT=3001 npx tsx src/index.ts`; admin:
   `cd admin && pnpm build && npx vite preview --port 5173`; tunnel + voice
   stack: `powershell scripts/deploy/start-voice-stack.ps1` (named cloudflared
   tunnel `f16-admin`, `--protocol http2`).
4. **Publish** — admin at `https://admin.assuryalconseil.fr` behind Cloudflare
   Access (Google SSO, allowed emails in `ADMIN_ALLOWED_EMAILS`); webhooks at
   `https://hooks.assuryalconseil.fr`.

## 4. Rotation procedure (generic)

1. **Issue the new value** at the source console without revoking the old one.
2. **Set it** in `backend/.env` via `SETENV_<KEY>=… npx tsx scripts/update-env.ts`
   (set it everywhere the key is consumed — note the grouped keys in §2).
3. **Restart the backend** (and the relevant stack piece — cloudflared for
   tunnel/Access tokens; Asterisk in WSL for voice trunk creds) so the new value
   loads. Booting = fully live.
4. **Verify** in admin `/integrations` that the vendor tile is green (and send a
   real test for email/WhatsApp/voice where applicable).
5. **Revoke the old value** at the source ONLY after the new one is verified
   live — never revoke before restart (self-inflicted outage).
6. **Log** the rotation in this runbook + commit `chore(secrets): rotate <NAME>`.

## 5. Emergency rotation (suspected compromise)

Invert the order — **revoke first, ask questions later.**

1. **Revoke at the source immediately.** Accept the brief outage; a burned key
   in attacker hands is worse than minutes of red health.
2. **Cut the surface** — for a webhook/HMAC leak, add a Cloudflare WAF block (or
   pause the tunnel) so no further signed/forged requests reach the backend.
3. **Rotate** — issue new, set in `.env`, restart, verify green.
4. **Audit** — pull backend logs + the vendor's usage dashboard for the leak
   window. Look for unfamiliar IPs, unusual rate, off-pattern calls.
5. **File an incident** + notify Ridaa + Achraf the same day, even if the audit
   is clean. Record: what leaked, vector, time-to-revoke, time-to-rotate,
   findings, follow-up hardening.

## 6. Never rules

- Never commit a populated `.env` (it is git-ignored — keep it that way).
- Never paste secrets in chat / WhatsApp / Slack / email.
- Never log secrets at any level (`debug`/`trace`/error context/span attrs).
- Never share secrets verbally — always via the shared vault.
- Never reuse secrets across environments — dev and prod each generate their own.
- Edit `.env` ONLY through `backend/scripts/update-env.ts` (direct read/write is
  blocked, and ad-hoc edits risk duplicate-shadowed keys).
