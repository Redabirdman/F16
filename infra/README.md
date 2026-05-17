# infra/

Infrastructure manifests for F16.

## What's here

- `docker-compose.dev.yml` -- local-dev data plane (Postgres + Redis + Adminer). The F16 app services (`backend`, `admin`, `pipecat`, `stagehand`) run natively via `pnpm`/`uv` in dev; only the data plane is containerised.
- `postgres/init.sql` -- one-shot init script that enables `vector` and `pgcrypto` extensions on first Postgres startup.
- `Caddyfile.example` -- production reverse-proxy template for the OUTER Caddy on the VPS (in front of all services). Not used in dev.
- `easypanel/README.md` -- service-by-service map of how F16 is laid out on the Hostinger VPS via EasyPanel.

## Run the dev data plane

```bash
docker compose -f infra/docker-compose.dev.yml up -d
```

Wait ~10 seconds for the healthchecks to settle, then connect:

| Service  | How to connect                                       |
| -------- | ---------------------------------------------------- |
| Postgres | `psql postgres://f16:f16@localhost:5433/f16`         |
| Redis    | `redis-cli -p 6380`                                  |
| Adminer  | <http://localhost:8081> (server: `postgres`, user/pass/db: `f16` / `f16` / `f16`) |

Non-standard ports (5433, 6380, 8081) are deliberate -- they avoid colliding with any default Postgres / Redis / dev tool you may already have on 5432 / 6379 / 8080.

## Tear down

```bash
# Stop containers, keep data volumes
docker compose -f infra/docker-compose.dev.yml down

# Stop AND wipe volumes (fresh DB next time)
docker compose -f infra/docker-compose.dev.yml down -v
```

## Production

See [`easypanel/README.md`](./easypanel/README.md) for the EasyPanel layout used on the Hostinger VPS.
