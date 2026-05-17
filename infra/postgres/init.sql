-- F16 dev Postgres init -- runs only on first container creation.
-- (Re-runs require wiping the f16_postgres_data volume.)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
