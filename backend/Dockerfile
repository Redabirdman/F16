# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @f16/backend (pnpm workspace-aware).
#
# IMPORTANT: build context MUST be the F16 monorepo root, NOT backend/, so the
# workspace metadata (pnpm-workspace.yaml, lockfile, sibling package.jsons) is
# visible to pnpm. From F16/:
#   DOCKER_BUILDKIT=1 docker build -f backend/Dockerfile -t f16-backend .
#
# Note: the `COPY stagehand/package.json` line below is commented out because
# that workspace doesn't have its package.json yet (lands in M1.T5). Uncomment
# once that task ships — without it, the lockfile won't fully resolve. We don't
# actually build this image until M16, so the Dockerfile being un-runnable
# today is acceptable; the logic just needs to be correct so M16 is a
# flip-the-switch operation.
#
ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.33.0

# ---------- deps: install full workspace dep tree (incl. dev) for the build ----------
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Workspace metadata — required for pnpm to recognize every workspace.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json backend/package.json
COPY admin/package.json admin/package.json
# Uncomment after M1.T5 creates its package.json:
# COPY stagehand/package.json stagehand/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @f16/backend...

# ---------- build: compile TypeScript to dist/ ----------
FROM deps AS build
WORKDIR /repo
COPY backend ./backend
WORKDIR /repo/backend
RUN pnpm run build

# ---------- runtime: minimal image, prod-only deps, non-root user ----------
FROM ${NODE_IMAGE} AS runtime
ARG PNPM_VERSION
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Re-copy workspace metadata (same set as deps) so prod install resolves identically.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json backend/package.json
COPY admin/package.json admin/package.json
# Uncomment after M1.T5 creates its package.json:
# COPY stagehand/package.json stagehand/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter @f16/backend...

COPY --from=build /repo/backend/dist ./backend/dist

USER node
WORKDIR /app/backend

EXPOSE 3001

# Use Node 22's built-in fetch — no extra runtime deps for the healthcheck.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
