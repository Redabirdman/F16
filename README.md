# F16

Autonomous AI organization for Assuryal Conseil — see docs/plans/2026-05-17-f16-design.md.

This monorepo contains the following workspaces:

- `backend/` — Node 22 / TypeScript / Hono / Drizzle / BullMQ / Claude Agent SDK
- `admin/` — Vite + React 18 admin SPA (shadcn/ui, Tailwind, PixiJS)
- `pipecat/` — Python voice workspace (not managed by pnpm)
- `stagehand/` — Browser automation workspace
- `infra/` — Compose files and deployment docs

See `docs/plans/2026-05-17-f16-design.md` and `docs/plans/2026-05-17-f16-implementation.md` for the authoritative design and implementation roadmap.
