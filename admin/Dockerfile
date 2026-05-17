# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @f16/admin (pnpm workspace-aware).
#
# IMPORTANT: build context MUST be the F16 monorepo root, NOT admin/, so the
# workspace metadata (pnpm-workspace.yaml, lockfile, sibling package.jsons) is
# visible to pnpm. From F16/:
#   DOCKER_BUILDKIT=1 docker build -f admin/Dockerfile -t f16-admin .
#
# The stagehand workspace's package.json doesn't exist yet (lands in M1.T5).
# That COPY line is commented out — uncomment it once M1.T5 ships.
#
ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.33.0
ARG CADDY_IMAGE=caddy:2-alpine

# ---------- deps: install full workspace dep tree (incl. dev) for the build ----------
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Workspace metadata — required for pnpm to recognize every workspace.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json backend/package.json
COPY admin/package.json admin/package.json
# Uncomment after M1.T5 creates stagehand/package.json:
# COPY stagehand/package.json stagehand/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @f16/admin...

# ---------- build: produce dist/ via Vite ----------
FROM deps AS build
WORKDIR /repo
COPY admin ./admin
WORKDIR /repo/admin
RUN pnpm run build

# ---------- runtime: static SPA served by Caddy, non-root ----------
FROM ${CADDY_IMAGE} AS runtime
WORKDIR /srv

COPY --from=build /repo/admin/dist /srv
COPY admin/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80

# Caddy ships with `wget`; HEALTHCHECK polls the SPA root. -q quiet, -O- to
# stdout (discarded), --spider does HEAD-like fetch without saving.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1/ || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
