# F16 on EasyPanel (Hostinger VPS)

This document maps every F16 service to its EasyPanel app spec. F16 ships as a set of independently-deployable apps inside one EasyPanel project, sharing the project's internal Docker network. Local dev (`../docker-compose.dev.yml`) only covers the data plane; production runs the full stack here.

## Service map

| EasyPanel app   | Source                            | Build context  | Port (internal) | Public? | Notes                                              |
| --------------- | --------------------------------- | -------------- | --------------- | ------- | -------------------------------------------------- |
| f16-postgres    | EasyPanel built-in Postgres       | n/a            | 5432            | no      | Pin to v16 + pgvector extension                    |
| f16-redis       | EasyPanel built-in Redis          | n/a            | 6379            | no      | AOF persistence enabled                            |
| f16-backend     | this repo, `backend/Dockerfile`   | F16 root       | 3001            | no      | Behind Caddy; reaches data plane by service name   |
| f16-admin       | this repo, `admin/Dockerfile`     | F16 root       | 8080            | yes     | Public via Caddy on a domain Ridaa picks later     |
| f16-pipecat     | this repo, `pipecat/Dockerfile`   | `pipecat/` ctx | 8000            | no      | Needs SIP outbound; webhook may go public later    |
| f16-stagehand   | this repo, `stagehand/Dockerfile` | F16 root       | 4001            | no      | Headful browser possible in dev, headless in prod  |
| f16-billionmail | external image (defer to deploy)  | n/a            | 25 / 587        | yes     | SMTP-out only; needs TLS cert, MX, SPF, DKIM setup |
| waha            | already deployed on the VPS       | n/a            | 3000            | yes     | Pre-existing -- leave alone, F16 just consumes it  |

## Internal DNS

EasyPanel exposes each app to its project-mates by its **app name** as a DNS hostname on the shared Docker network. So from inside `f16-backend`:

- Postgres is at `f16-postgres:5432` (user/pass/db from EasyPanel env vars)
- Redis is at `f16-redis:6379`
- Pipecat is at `f16-pipecat:8000`
- Stagehand is at `f16-stagehand:4001`
- Waha is at `waha:3000`

No `localhost`, no public domains, no port forwarding -- everything intra-VPS goes through the named service network.

## Public routing

The admin domain is a config knob in EasyPanel (Ridaa decides which subdomain to use), **not** coupled to `assuryalconseil.fr`. EasyPanel terminates TLS via its built-in Caddy and proxies the public domain to `f16-admin:8080` internally. The outer-Caddy template at `../Caddyfile.example` shows the equivalent if you ever want to run Caddy yourself.

By default only `f16-admin` (and eventually `f16-billionmail`'s SMTP ports) are publicly exposed. The backend, pipecat, and stagehand stay private and are reached only by sibling services on the internal network.

## Secrets

**All secrets live in EasyPanel env vars, per app.** Never in code, never in git, never in the compose file.

Per-app env-var checklist (set in EasyPanel UI):

- `f16-backend`: `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, plus whatever LLM/vendor keys the agents need.
- `f16-admin`: build-time public env (e.g. `VITE_API_URL`); no secrets in the SPA bundle.
- `f16-pipecat`: `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY` (or equivalents), SIP provider creds.
- `f16-stagehand`: `BROWSERBASE_API_KEY` (if used), proxy creds.
- `f16-billionmail`: SMTP credentials, DKIM private key.

Rotate via EasyPanel UI; redeploy the app to pick up new values.

## Deployment from GitHub

Once the repo is pushed to GitHub, EasyPanel can auto-deploy each app on push to `main` (configure per-app: repo, branch, Dockerfile path, build context). Until then, the manual path on the VPS is:

```bash
git pull
docker compose build
docker compose up -d
```

## Order of bring-up

1. `f16-postgres` and `f16-redis` -- wait until both are healthy.
2. `f16-backend`, `f16-stagehand`, `f16-pipecat` -- can come up in parallel; they tolerate transient data-plane unavailability via retries.
3. `f16-admin` -- last, so its backend dependency is already serving.
4. `f16-billionmail` -- only when outbound mail is actually needed (defer until the mail flow is built).

Bring-down: reverse order, or just `down` the whole EasyPanel project.
