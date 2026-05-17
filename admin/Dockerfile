# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @f16/admin (pnpm workspace-aware).
#
# IMPORTANT: build context MUST be the F16 monorepo root, NOT admin/, so the
# workspace metadata (pnpm-workspace.yaml, lockfile, sibling package.jsons) is
# visible to pnpm. From F16/:
#   DOCKER_BUILDKIT=1 docker build -f admin/Dockerfile -t f16-admin .
#
ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.33.0
# Pin Caddy to a minor version so a future base-image revision doesn't
# silently change the prod runtime (e.g. flag/header semantics).
ARG CADDY_IMAGE=caddy:2.8-alpine

# ---------- deps: install full workspace dep tree (incl. dev) for the build ----------
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Workspace metadata — required for pnpm to recognize every workspace.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json backend/package.json
COPY admin/package.json admin/package.json
COPY stagehand/package.json stagehand/package.json

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

# Install wget explicitly (~200 KB) so HEALTHCHECK doesn't break if a future
# Caddy base image drops it.
RUN apk add --no-cache wget

WORKDIR /srv

COPY --from=build /repo/admin/dist /srv
COPY admin/Caddyfile /etc/caddy/Caddyfile

# Listen on :8080 inside the container so we can run as the unprivileged
# `caddy` user (binding :80 requires CAP_NET_BIND_SERVICE).
EXPOSE 8080

# Drop privileges. The caddy:alpine image ships a `caddy` user/group.
USER caddy

# HEALTHCHECK polls the SPA root via wget (installed above).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:8080/ || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
