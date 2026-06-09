# M14.T11 — `/office` 2D isometric live view — Design

**Date:** 2026-06-09
**Status:** Approved (brainstorm), pending spec review
**Owner:** Ridaa / Achraf (Assuryal F16)
**Plan ref:** `docs/plans/2026-05-17-f16-implementation.md` §M14.T11 · `docs/plans/2026-05-17-f16-design.md` §12.2/§12.3 (`/office`) + §18 (V2 Three.js upgrade keeps the state layer)

## 1. Goal & scope

Build the live "Bureau" — a PixiJS top-down **isometric office** where the real F16 agents appear as warm, game-style character sprites at desks, animate by their live state, walk on key handoffs, and open a live detail panel on click.

- **Route:** `/office`, French nav label **"Bureau"**.
- **Frontend-only** (`admin/`). **No backend changes.** All data already exists:
  - `GET /v1/admin/agents` → `{ rows: AgentStateRow[] }` (authoritative roster; status `running|starting|stopping|stopped|crashed`, model, queue, priority, heartbeats).
  - SSE `GET /v1/admin/events` → events `agent_message { id, intent, toRole, correlationId, priority }`, `human_action { id, op, status, severity, correlationId }`, `hello`, `heartbeat`.
- **Out of scope:** any backend/API change; real 3D (V2, Three.js); per-instance source-role tracking in SSE (not available — see §6 approximation).

### Locked creative decisions (brainstorm 2026-06-09)

- **Art direction:** warm game art (Habbo/Stardew vibe) via Nano Banana Pro — generated **in the core build** (not deferred).
- **Floor plan:** open studio (one room, central open sales floor + specialist corners).
- **Motion model:** calm + marquee — agents mostly animate in place; reserve walking for the sales→Maxance handoff and ephemeral spawn/despawn.
- **State layer is hard-decoupled from the renderer** so the future V2 Three.js swap touches only `scene.ts`.

## 2. Architecture — three decoupled layers

| Layer        | File                               | Responsibility                                                                                                                                                                                                                       | Imports             |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Data / State | `admin/src/office/state-bridge.ts` | Own an `EventSource('/v1/admin/events')` + poll `GET /v1/admin/agents` every 5s; reconcile into an observable `OfficeState`; expose `subscribe` / `getSnapshot` / `dispose`. **No PixiJS, no React.**                                | `lib/api` only      |
| Renderer     | `admin/src/office/scene.ts`        | PixiJS `Application`: build the floor & zones, create/destroy sprites, tween animations + walking, camera fit, pointer hit-testing → emits `onSelect(agentKey)`. Reads an `OfficeState` snapshot + a diff stream; **never fetches**. | `pixi.js`           |
| Mount / UI   | `admin/src/pages/Office.tsx`       | Mount the Pixi canvas into a ref; wire `state-bridge` → `scene`; render the React side-panel overlay; lifecycle (dispose on unmount, pause on tab hidden).                                                                           | `react`, both above |

Rationale: the V2 upgrade replaces `scene.ts` with a Three.js renderer that consumes the **same** `OfficeState` from the **unchanged** `state-bridge.ts`. The contract between them (§5) is the stable seam.

Dependency: add `pixi.js` (v8) to `admin/package.json`. **No `@pixi/react`** — raw Pixi mounted manually gives full control and avoids React-reconciler/version-compat traps; React only renders the absolute-positioned side panel over the canvas.

## 3. Agent roster → zones (real, grounded in `backend/src/agents`)

Registered agent classes: `sales-agent`, `voice-operator`, `maxance-operator`, `supervisor`, `human-router` (Reporter agent registers under this role), `engagement-agent`, `ads-manager-agent`, `creative-agent`, `lead-scorer`.

| Zone (open studio)                            | Agents                                                                           | Persistence                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Open Sales Floor** (central, rows of desks) | `sales-agent` (N instances), `voice-operator`, `engagement-agent`, `lead-scorer` | sales = ephemeral (spawn per lead); others persistent |
| **Aile Pub** (top-left corner)                | `ads-manager-agent`, `creative-agent`                                            | persistent                                            |
| **Cabine Maxance** (bottom-left)              | `maxance-operator`                                                               | persistent                                            |
| **Bureau Reporter** (bottom-right)            | `human-router`                                                                   | persistent                                            |
| **Coin Superviseur** (top-right)              | `supervisor`                                                                     | persistent                                            |

Desk assignment: persistent roles have a fixed home desk. Ephemeral `sales-agent` instances take a free sales-floor desk via a deterministic slot picker keyed on `instanceId` (stable across reconciles); when no free desk, overflow desks are added in a back row.

## 4. State model

```ts
type SpriteState = 'idle' | 'working' | 'talking' | 'blocked' | 'walking';

interface OfficeAgent {
  key: string; // `${role}#${instanceId}`
  role: string;
  instanceId: string;
  status: string; // raw AgentStateRow.status
  model: string;
  queue: string;
  priority: number | null;
  lastHeartbeatAt: string;
  error: string | null;
  zone: ZoneId;
  deskId: string; // resolved desk slot
  spriteState: SpriteState;
}

interface OfficeState {
  agents: Map<string, OfficeAgent>; // keyed by `role#instanceId`
  generatedAt: number;
}
```

The bridge also emits **transient effects** (not part of the reconciled snapshot, delivered via the diff stream so the renderer can animate then forget):

```ts
type OfficeEffect =
  | { kind: 'message'; toRole: string; intent: string; correlationId: string | null; at: number }
  | { kind: 'attention'; severity: number; at: number } // pending high-sev human_action
  | { kind: 'marquee-quote'; toRole: 'maxance-operator'; at: number };
```

### status → spriteState mapping

- `running` → `idle`; promoted to `working` for ~6s after any `agent_message`/queue activity attributable to that role.
- `starting` / `stopping` → `walking` (in/out) for ephemerals; `idle` for persistents.
- `crashed` or non-null `error` → `blocked`.
- `stopped` → agent removed from the scene (ephemeral walks out; persistent desk shown empty/dimmed).
- `agent_message{toRole}` → that role flashes `talking` ~3s + a pulse line (§6).
- pending high-severity `human_action` (op=INSERT, severity≥ critical threshold) → `attention` effect pulses the **Reporter (`human-router`)** desk (SSE carries no agent role; the Reporter owns the human-action surface, so attribution is deterministic, not guessed).

## 5. Data flow & lifecycle

1. `Office.tsx` mounts → constructs `state-bridge` (starts SSE + 5s poll) and `scene` (Pixi app in the ref div).
2. Bridge initial poll → `OfficeState` snapshot → `scene.applySnapshot(state)` creates sprites at desks.
3. SSE event → bridge updates snapshot (if roster-affecting) and/or emits an `OfficeEffect` → `scene` animates.
4. Every 5s poll → bridge reconciles authoritative roster (adds new instances, removes stopped) → `scene.applySnapshot` diffs and spawns/despawns sprites.
5. Pointer tap on a sprite → `scene.onSelect(key)` → `Office.tsx` opens the side panel for that agent.
6. Tab hidden (`visibilitychange`) → `scene.pause()` (stop ticker); visible → `resume()`.
7. Unmount → `scene.destroy()` (Pixi teardown) + `bridge.dispose()` (close SSE, clear interval).

The bridge opens its **own** `EventSource`, independent of `lib/use-realtime.ts` (different concern; both can coexist — the backend SSE endpoint supports multiple concurrent clients). Token is read via `getAdminToken()` and passed as `?token=` (same pattern as `use-realtime`).

## 6. Motion / choreography (calm + marquee)

| Trigger                                                                     | Animation                                                                                                         |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `idle`                                                                      | gentle vertical bob (sine, ~2s period)                                                                            |
| `working`                                                                   | subtle desk glow + slightly faster bob                                                                            |
| `talking`                                                                   | speech-bubble glyph + scale pulse, ~3s then back to prior state                                                   |
| `blocked`                                                                   | red "!" badge + small shake                                                                                       |
| `agent_message{toRole}`                                                     | a dot travels along a path toward the `toRole` desk; on arrival that agent → `talking`                            |
| ephemeral spawn (`sales-agent` appears)                                     | sprite walks from the entrance door to its free desk, then sits (`idle`)                                          |
| ephemeral despawn (`stopped`)                                               | sprite stands, walks to the exit, fades out                                                                       |
| **marquee** `agent_message` `intent ~ /QUOTE/i` & `toRole=maxance-operator` | the **most-recently-active sales sprite** walks desk → Maxance booth → back; Maxance operator lights up `working` |

All motion is **tween-driven** (position / bob / crossfade between state stills) — **no frame-by-frame walk sheets**. This keeps the Nano-Banana art pipeline tractable (a few stills per role) while preserving the "warm game" feel.

**Documented approximation:** the SSE `agent_message` payload has `toRole` but **no source role/instance**. The marquee walk therefore animates the most-recently-active `sales-agent` sprite (or, if none active, a representative sales desk) as the walker. This is intentional and acceptable for V1; a future backend enhancement could add `fromRole` to make it exact without changing the renderer contract.

## 7. Art pipeline (warm B, in the core build)

Generated with the `generate` (Nano Banana Pro) skill using one shared style directive (consistent palette, lighting, isometric ¾ angle, transparent background) for coherence.

- **Characters (9 roles):** poses `{ idle, working, talking, walking }` — 4 transparent PNG stills per role. Motion comes from tweens + crossfade between stills, not multi-frame sheets.
- **Environment:** isometric wood-floor tile, per-zone rug/marker, desk, plant prop, Maxance booth terminal, entrance/exit door.
- **Storage:** `admin/public/office/` (Vite serves statically; relative URLs in dev + prod). An asset manifest in `scene.ts` maps `role + spriteState → texture URL`.
- **Swap-in:** placeholder flat shapes ship in P1–P3 so the engine is fully verifiable before art exists; P4 swaps textures in. **Art changes never touch `state-bridge.ts`.**
- Bundle: PNGs are static public assets (lazy-loaded by Pixi `Assets`), not bundled JS; keep total office art reasonable (target < ~3 MB) and load with a progress indicator.

## 8. Side panel (click sprite → details)

React overlay, right-aligned, over the canvas. Fields (all from the `OfficeAgent` already in state — no extra fetch): role, instanceId, live `spriteState`, raw status, model, queue, priority, relative heartbeat, error (if any), and a link to `/agents`. Closes on background click or Esc. Live-updates while open (re-renders on bridge updates).

## 9. Testing & verification

- **`state-bridge.ts` — vitest unit tests** (pure TS, no DB, no Pixi): synthetic agent rows + SSE events → assert `OfficeState` transitions and emitted effects: spawn→desk slot, message→talking, crash→blocked, stop→removal, QUOTE→`marquee-quote` effect, attention attribution to `human-router`, desk-slot stability across reconciles, dispose cleans up.
- **`scene.ts` / Pixi:** not unit-tested (canvas); covered by manual live-verify.
- **Lint/build:** admin `eslint` + `tsc` clean; `pnpm build` succeeds.
- **Live-verify on this PC (the "done" bar):** Docker up (pg 5435 / redis 6380), backend on :3001, admin dev; open `/office`; trigger a real lead → watch a `sales-agent` sprite spawn & walk to a desk; observe live status; click a sprite → panel; (where feasible) drive a `QUOTE.REQUESTED` → marquee walk to the Maxance booth.

## 10. Phases (each = working, demoable, committed, live-verified)

1. **P1 — Shell:** add `pixi.js` dep; `/office` route + nav "Bureau" + `Office.tsx` Pixi canvas mount + static open-studio floor & zone labels (placeholder shapes); responsive fit. _Demo: the empty office renders._ Commit `feat(admin/office): isometric scene shell + route`.
2. **P2 — Live wiring:** `state-bridge.ts` + unit tests; render persistent agents as placeholder sprites at home desks with live status colors; click → side panel. _Demo: real agents appear and update live._ Commit `feat(admin/office): live state bridge + agent sprites + side panel`.
3. **P3 — Motion:** in-place state animations + message pulse-lines + ephemeral sales spawn/despawn walks + marquee sales→Maxance walk. _Demo: living office._ Commit `feat(admin/office): live motion + handoff choreography`.
4. **P4 — Warm art:** generate the Nano-Banana B asset set; swap textures in via the manifest; shadows/lighting polish. _Demo: the moonshot look._ Commit `feat(admin/office): warm game art assets`.
5. **P5 — Polish & verify:** tab-hidden ticker pause; responsive sizing; accessible fallback (link to the `/agents` table); perf pass; full live-verify e2e on prod. Commit `feat(admin/office): polish, perf, a11y fallback + live-verify`.

## 11. Risks & mitigations

| Risk                                      | Mitigation                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nano-Banana sprites inconsistent in style | One shared style directive; generate iteratively; keep a small fixed pose set; regenerate off-style assets. Engine works with placeholders regardless. |
| Pixi v8 + Vite/React integration friction | Raw Pixi mounted in a ref; no `@pixi/react`; isolate all Pixi in `scene.ts`.                                                                           |
| SSE lacks source role for handoffs        | Documented marquee approximation (§6); attention attributed to `human-router`; exactness deferred to an optional backend `fromRole` later.             |
| Perf with many ephemeral sprites          | Bounded by max-agents (~15); ticker pause on hidden tab; tween-only animation; texture atlas/lazy load.                                                |
| Scene canvas hard to unit-test            | Heavy logic lives in the pure, tested `state-bridge`; scene verified live on prod per the "done" bar.                                                  |

```

```
