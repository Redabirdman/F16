# Postgres / pgvector / pgcrypto Verification (M2.T1)

End-to-end verification that `infra/docker-compose.dev.yml` brings up Postgres 16
with `pgvector` and `pgcrypto` extensions loaded via `init.sql`.

## Last verified

- **Date:** 2026-05-17
- **Image:** `pgvector/pgvector:pg16`
- **Postgres:** `PostgreSQL 16.14 (Debian 16.14-1.pgdg12+1)`
- **pgvector:** `0.8.2`
- **pgcrypto:** `1.3`

## How to re-verify

```bash
# 1. Bring up the data plane
docker compose -f infra/docker-compose.dev.yml up -d postgres

# 2. Wait ~10s for the healthcheck; confirm "(healthy)"
docker compose -f infra/docker-compose.dev.yml ps

# 3. List extensions -- expect `vector` and `pgcrypto`
docker compose -f infra/docker-compose.dev.yml exec postgres \
  psql -U f16 -d f16 -c '\dx'

# 4. Capture versions
docker compose -f infra/docker-compose.dev.yml exec postgres \
  psql -U f16 -d f16 \
    -c 'SELECT version();' \
    -c "SELECT extversion FROM pg_extension WHERE extname IN ('vector','pgcrypto');"

# 5. Tear down (keep volume)
docker compose -f infra/docker-compose.dev.yml down
```

If host port `5433` is already occupied by another project, either stop the
conflicting container or run an ephemeral verifier on a free port:

```bash
docker run --rm -d --name f16-verify-pg \
  -e POSTGRES_USER=f16 -e POSTGRES_PASSWORD=f16 -e POSTGRES_DB=f16 \
  -p 5434:5432 \
  -v "$(pwd)/infra/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro" \
  pgvector/pgvector:pg16
```

## Smoke tests

### pgvector — nearest-neighbour query

```sql
CREATE TABLE _verify_vector (id int, v vector(3));
INSERT INTO _verify_vector VALUES (1, '[1,2,3]'), (2, '[4,5,6]');
SELECT id, v <=> '[1,2,3]'::vector AS dist
  FROM _verify_vector ORDER BY dist LIMIT 1;
DROP TABLE _verify_vector;
```

Expected: `id = 1`, `dist = 0`.

### pgcrypto — digest + symmetric round-trip

```sql
SELECT encode(digest('hello','sha256'),'hex');
-- 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824

SELECT pgp_sym_decrypt(pgp_sym_encrypt('secret','password'), 'password');
-- secret
```
