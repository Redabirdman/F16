# syntax=docker/dockerfile:1.7
# Multi-stage build for @f16/backend.
# Build with BuildKit enabled (DOCKER_BUILDKIT=1) so the pnpm cache mounts work.

ARG NODE_VERSION=22-alpine
ARG PNPM_VERSION=10.33.0

# -----------------------------------------------------------------------------
# Stage 1 — deps: install full dependency tree (including dev) for the build step
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
ARG PNPM_VERSION
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json ./
# Lockfile lives at the workspace root; expected to be copied in by the
# build context (e.g. `docker build -f backend/Dockerfile .` from the F16 root).
COPY pnpm-lock.yaml* ./
COPY pnpm-workspace.yaml* ./

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --prod=false --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 2 — build: compile TypeScript to dist/
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
ARG PNPM_VERSION
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

RUN pnpm run build

# Drop dev deps so the runtime stage only carries production modules.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts || \
    pnpm prune --prod

# -----------------------------------------------------------------------------
# Stage 3 — runtime: minimal image, non-root user
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001

# node:alpine ships a `node` user (uid 1000) — reuse it instead of creating one.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node

EXPOSE 3001

CMD ["node", "dist/index.js"]
