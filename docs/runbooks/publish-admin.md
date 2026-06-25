# Runbook — Publish the F16 admin at `admin.assuryalconseil.fr`

Publishes the admin UI through the **existing** cloudflared tunnel (the one already
serving `hooks.assuryalconseil.fr → localhost:3001`), gated by **Cloudflare Access**
(email one-time-PIN). No always-on hosting change: this is the per-session
"boot backend + admin behind the tunnel" flow.

> Spec: `docs/superpowers/specs/2026-06-15-admin-publish-and-simulation-design.md` §3.
> The admin uses **relative** URLs (`/v1/admin/*`, `/ws/*` — see `admin/src/lib/api.ts`),
> so cloudflared routes API/WS calls straight to the backend; there is **no Vite-proxy
> dependency** in this published setup.

---

## 0. Tunnel model in use here (read first)

This machine runs a **remotely-managed (dashboard/API-managed) named tunnel** named
**`f16`** (`config_src: cloudflare`). Confirmed facts:

- The running process is `… \.tools\cloudflared.exe tunnel run --token <CLOUDFLARE_TUNNEL_TOKEN>`
  (launched by `scripts/deploy/start-voice-stack.ps1`). The run-token lives in
  `backend/.env` as `CLOUDFLARE_TUNNEL_TOKEN`; the tunnel id is `CLOUDFLARE_TUNNEL_ID`.
- There is **no local `config.yml` and no `cert.pem`** — `~/.cloudflared` (i.e.
  `C:\Users\Rlefr\.cloudflared`) is empty. Ingress is stored **in Cloudflare**, not on disk.
- Ingress + DNS were provisioned by `backend/scripts/cf-tunnel-setup.ts`
  (`PUT /accounts/{acct}/cfd_tunnel/{id}/configurations` for ingress, DNS CNAME upsert).

**Therefore: add the admin hostname via the Cloudflare dashboard public-hostname UI
(or the same API the setup script uses) — NOT by editing a `config.yml`.** Section 2A
below is the one that applies here. Section 2B (config-file YAML) is included only as
reference for a different machine running a local-config tunnel; **it does not apply to
this tunnel** — do not create a `config.yml`, it would be ignored by a token-run tunnel.

> If you ever migrate to a local-config tunnel, confirm that first (`cloudflared`
> launched with `--config <file>` instead of `--token`), then use 2B.

---

## 1. Build + serve the admin static (`:5173`)

Built static is the recommended default for remote sessions (no HMR flakiness).

```bash
# from the F16 repo root
pnpm --filter @f16/admin build        # outputs admin/dist
cd admin && npx vite preview --host --port 5173
```

`vite preview` serves `admin/dist` on `0.0.0.0:5173`. It does not require the dev proxy
because all admin requests are relative paths that cloudflared sends to the backend
(see §2A). Leave this running for the session.

### Dev-server alternative (only if you need HMR)

```bash
cd admin && pnpm dev      # vite dev server on :5173 (host:true already set in vite.config.ts)
```

The Vite **dev** server validates the `Host` header. Add the published hostname to
`server.allowedHosts` in `admin/vite.config.ts`:

```ts
server: {
  port: 5173,
  strictPort: true,
  host: true,
  allowedHosts: ['admin.assuryalconseil.fr'],   // <-- add this line
  proxy: { /* …unchanged… */ },
},
```

> Note: `allowedHosts` is a **dev-server** option. For `vite preview`, the equivalent is
> `preview.allowedHosts`. In practice the built-static `preview` path above is preferred
> and avoids this entirely, so prefer §1 over the dev server.

---

## 2A. Add the admin hostname (THIS tunnel — dashboard / API)

Add a **second public hostname** `admin.assuryalconseil.fr` to the same `f16` tunnel,
with **path-ordered** ingress rules (order matters — most specific first):

| Order | Path          | Service                 | Why                         |
| ----- | ------------- | ----------------------- | --------------------------- |
| 1     | `/v1/admin/*` | `http://localhost:3001` | admin API → backend         |
| 2     | `/ws/*`       | `http://localhost:3001` | realtime (SSE/WS) → backend |
| 3     | `/*`          | `http://localhost:5173` | the admin app (static)      |

Only `/v1/admin/*` (not all of `/v1`) is exposed on this host, so the webhook routes
stay only on `hooks.assuryalconseil.fr`.

### Option A1 — Dashboard (simplest; recommended)

Zero Trust dashboard → **Networks → Tunnels** → open the **`f16`** tunnel → **Public
Hostnames** tab → **Add a public hostname**, once per row, in this order:

1. Subdomain `admin`, domain `assuryalconseil.fr`, **Path** `v1/admin/*`,
   Service **HTTP** `localhost:3001`.
2. Subdomain `admin`, domain `assuryalconseil.fr`, **Path** `ws/*`,
   Service **HTTP** `localhost:3001`.
3. Subdomain `admin`, domain `assuryalconseil.fr`, **Path** `*` (or leave blank for
   catch-all), Service **HTTP** `localhost:5173`.

Cloudflare evaluates public-hostname rules **top-to-bottom**; keep the catch-all (`*`)
**last**. Adding the public hostname here also creates the proxied DNS record
automatically (see §3 to verify).

### Option A2 — API (matches `cf-tunnel-setup.ts`)

The existing `f16` ingress currently has just the `hooks` hostname. To add `admin`
without dropping `hooks`, `PUT` the **full** ingress list (hooks rule + the three admin
rules + the final 404). Uses the same scoped token in `backend/.env`
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_ID`).

```bash
# pseudo-payload for PUT /accounts/{ACCOUNT_ID}/cfd_tunnel/{TUNNEL_ID}/configurations
{
  "config": {
    "ingress": [
      { "hostname": "hooks.assuryalconseil.fr", "service": "http://localhost:3001" },

      { "hostname": "admin.assuryalconseil.fr", "path": "/v1/admin/*", "service": "http://localhost:3001" },
      { "hostname": "admin.assuryalconseil.fr", "path": "/ws/*",       "service": "http://localhost:3001" },
      { "hostname": "admin.assuryalconseil.fr",                        "service": "http://localhost:5173" },

      { "service": "http_status:404" }
    ]
  }
}
```

Send it with the same auth header pattern as `cf-tunnel-setup.ts`
(`authorization: Bearer $CLOUDFLARE_API_TOKEN`). **Always include the existing `hooks`
rule** — a `PUT` replaces the whole ingress array; omitting it would take the voice/Meta
webhooks offline. A token-run tunnel picks up the new config within seconds; no restart
needed.

---

## 2B. Reference only — config-file (local-config) tunnels (NOT this machine)

If (and only if) a machine runs `cloudflared` with a local `~/.cloudflared/config.yml`
(`cloudflared tunnel run <name>`, no `--token`), the equivalent ingress is:

```yaml
# ~/.cloudflared/config.yml  — DOES NOT APPLY to the token-run f16 tunnel on this PC
tunnel: <tunnel-id>
credentials-file: /path/to/<tunnel-id>.json

ingress:
  # hooks (existing) — keep it
  - hostname: hooks.assuryalconseil.fr
    service: http://localhost:3001

  # admin (new) — path-ordered, most specific first
  - hostname: admin.assuryalconseil.fr
    path: /v1/admin/*
    service: http://localhost:3001
  - hostname: admin.assuryalconseil.fr
    path: /ws/*
    service: http://localhost:3001
  - hostname: admin.assuryalconseil.fr
    service: http://localhost:5173

  - service: http_status:404
```

Then `cloudflared tunnel route dns <tunnel-name> admin.assuryalconseil.fr` and restart
the tunnel. **This block is unused here** — the `f16` tunnel is dashboard/API-managed.

---

## 3. DNS

A proxied CNAME must exist for the new host:

```
admin.assuryalconseil.fr  CNAME  <CLOUDFLARE_TUNNEL_ID>.cfargotunnel.com   (Proxied — orange cloud)
```

`<CLOUDFLARE_TUNNEL_ID>` is the `f16` tunnel id (in `backend/.env` as
`CLOUDFLARE_TUNNEL_ID`; same value the `hooks` CNAME points at). Adding the public
hostname via the dashboard (§2A Option A1) **creates this record automatically** — just
verify it in **DNS → Records** and confirm the cloud is **orange (proxied)**, TTL Auto.
If scripting via API, upsert it exactly like `cf-tunnel-setup.ts` does for `hooks`
(`type: CNAME`, `proxied: true`).

---

## 4. Cloudflare Access (the security gate)

The admin controls live agents and customer PII — it must never be openly reachable.
Create a **self-hosted Access application** for `admin.assuryalconseil.fr`.

Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**:

1. **Application name:** `F16 Admin`.
2. **Session duration:** e.g. 24h (your call).
3. **Public hostname:** subdomain `admin`, domain `assuryalconseil.fr`, path **blank**
   (gate the **whole** hostname — app + `/v1/admin` + `/ws`).
4. **Add a policy:**
   - Name: `Admins`, Action: **Allow**.
   - Include → **Emails** → add Achraf's email **and** Ridaa's email
     (`ridaa.birdman@gmail.com`).
5. **Identity / login method:** **One-time PIN** (email OTP) — no IdP needed.
6. Save.

Now any request to `admin.assuryalconseil.fr` (including the API and WS paths) requires
an Access login by one of those two emails. The admin's existing
**`requireAdminAuth` bearer-token** middleware stays enabled as **defense-in-depth**
behind Access — do not disable it.

> Access sits in front of the tunnel, so it gates the API and WS subpaths too; you do
> not need a separate Access app per path.

---

## 5. Per-session checklist (boot FULL-LIVE so agents can message Achraf)

The Simulation page injects a real lead through the real pipeline; for the agents to
actually message Achraf on WhatsApp/voice, the backend must be **full-live** and the
Chrome-extension WS bridge must be up.

1. **Asterisk / voice** (if testing voice): the voice stack launcher already brings this
   up — `scripts/deploy/start-voice-stack.ps1` (or it's already running at logon).
2. **Backend, FULL-LIVE on `:3001`** — `WAHA_BASE_URL` **must be set** in the
   environment (this is what flips WhatsApp customer-sends live; the Simulation banner
   reads it via `/v1/admin/sim/status`):

   ```bash
   cd backend
   # ensure WAHA_BASE_URL (and the WAHA creds) are present in backend/.env,
   # then start the backend:
   pnpm dev          # or: npx tsx src/index.ts   (PORT=3001)
   ```

   If `WAHA_BASE_URL` is unset, inject still creates the lead (pipeline/scoring testable)
   but the page shows the **offline** banner and the agent cannot send.

3. **Extension WS bridge** — so Maxance/quote-in-chat actions and agent sends work:

   ```bash
   cd backend && pnpm extension:ws
   ```

4. **Admin static** on `:5173` — §1 (`vite preview --host --port 5173`).
5. **Tunnel** — already running (`hooks` + now `admin`); verify
   `Get-Process cloudflared` shows it up. The named tunnel is stable; no re-registration.
6. **Confirm live:** open `https://admin.assuryalconseil.fr` → pass the Access OTP →
   go to **Simulation**. The status banner must show **live** (WhatsApp registered).
   If it shows "Mode hors-ligne", `WAHA_BASE_URL` wasn't set when the backend booted —
   fix `backend/.env` and restart the backend.

---

## Quick reference

| Item               | Value                                                                               |
| ------------------ | ----------------------------------------------------------------------------------- |
| Tunnel model       | remotely-managed named tunnel `f16` (`config_src: cloudflare`)                      |
| Tunnel run command | `cloudflared tunnel run --token $CLOUDFLARE_TUNNEL_TOKEN`                           |
| Local config file  | none (no `config.yml` / `cert.pem`; `~/.cloudflared` empty)                         |
| Ingress lives in   | Cloudflare (dashboard Public Hostnames / API)                                       |
| Admin host         | `admin.assuryalconseil.fr` → `:5173` (app), `:3001` (`/v1/admin/*`, `/ws/*`)        |
| DNS                | CNAME `admin` → `<CLOUDFLARE_TUNNEL_ID>.cfargotunnel.com` (proxied)                 |
| Gate               | Cloudflare Access (Allow: Achraf + Ridaa, one-time PIN) + `requireAdminAuth` bearer |
| Existing host      | `hooks.assuryalconseil.fr` → `:3001` (keep it in ingress)                           |
