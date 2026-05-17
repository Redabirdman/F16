# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @f16/stagehand (pnpm workspace-aware).
#
# IMPORTANT: build context MUST be the F16 monorepo root, NOT stagehand/, so
# the workspace metadata (pnpm-workspace.yaml, lockfile, sibling package.jsons)
# is visible to pnpm. From F16/:
#   DOCKER_BUILDKIT=1 docker build -f stagehand/Dockerfile -t f16-stagehand .
#
# Runtime base is Playwright's official Ubuntu image — it ships with every
# system library Chromium/Firefox/WebKit need preinstalled (libnss3, libasound2,
# fonts, etc.). Rolling our own on alpine is doable but fragile; this is the
# path Playwright themselves recommend for containerized browser automation.
#
ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.33.0
# Pin to a specific Playwright image tag so a future revision can't silently
# change Chromium's behavior under us. jammy = Ubuntu 22.04 LTS.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.60.0-jammy

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
    pnpm install --frozen-lockfile --filter @f16/stagehand...

# ---------- build: compile TypeScript to dist/ ----------
FROM deps AS build
WORKDIR /repo
COPY stagehand ./stagehand
WORKDIR /repo/stagehand
RUN pnpm run build

# ---------- runtime: Playwright image (browsers + sys deps preinstalled) ----------
FROM ${PLAYWRIGHT_IMAGE} AS runtime
ARG PNPM_VERSION
ENV NODE_ENV=production \
    PORT=4001
WORKDIR /app

# Playwright image ships Node 22 + corepack; just activate the pinned pnpm.
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Re-copy workspace metadata (same set as deps) so prod install resolves identically.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json backend/package.json
COPY admin/package.json admin/package.json
COPY stagehand/package.json stagehand/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter @f16/stagehand...

COPY --from=build /repo/stagehand/dist ./stagehand/dist

# Playwright image ships a pre-created unprivileged `pwuser` (uid 1000) that
# owns the browser cache directory at /ms-playwright. Use it.
USER pwuser
WORKDIR /app/stagehand

EXPOSE 4001

# Use Node 22's built-in fetch — no extra runtime deps for the healthcheck.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
