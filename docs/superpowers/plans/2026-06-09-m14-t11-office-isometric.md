# M14.T11 — `/office` 2D Isometric Live View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the live "Bureau" admin view — a PixiJS top-down isometric office where the real F16 agents appear as warm game-style sprites at desks, animate by their live state, walk on key handoffs, and open a live detail panel on click.

**Architecture:** Frontend-only (`admin/`), three hard-decoupled layers — a **pure state core** (`office/reducer.ts` + `office/layout.ts`, no IO/pixi/react, fully unit-tested), a **thin IO bridge** (`office/state-bridge.ts`: SSE + 5s poll → reducer → subscribers), and a **PixiJS renderer** (`office/scene.ts`) mounted by the route page (`pages/Office.tsx`). The state core is the V2-stable seam: the future Three.js swap touches only `scene.ts`.

**Tech Stack:** Vite 5 + React 18 + TypeScript (strict) + react-router-dom 6 + @tanstack/react-query 5 + Tailwind 3 + **pixi.js 8.6.6 (already a dependency)** + vitest 3 (jsdom). Spec: `docs/superpowers/specs/2026-06-09-m14-t11-office-isometric-design.md`.

**Conventions (must follow):**

- Commits: conventional, **lowercase subject**, scope ∈ {backend, admin, stagehand, extension, pipecat, infra, docs, deps, ci, tooling, repo, release} — use **`admin`** for all code here (NOT `admin/office` — commitlint rejects it). End every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Husky auto-runs prettier+eslint on staged files.
- Admin tests live in `admin/tests/**/*.test.ts(x)`; run with `pnpm test` (vitest), `globals: false` (import `describe/it/expect/vi` explicitly). Lint: `pnpm lint`. Typecheck: `pnpm typecheck`. Build: `pnpm build`.
- TS is strict + eslint `--max-warnings 0`: every function needs an explicit return type; no `any`; no unused vars.
- All commands run from `admin/` unless stated. `cd Assuryal/F16/admin` first.

---

## File Structure

| File                                      | Responsibility                                                                                                                                                               | Layer  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `admin/src/office/types.ts`               | Shared types: `SpriteState`, `ZoneId`, `OfficeAgent`, `OfficeState`, `OfficeEffect`, `BridgeSnapshot`.                                                                       | core   |
| `admin/src/office/layout.ts`              | Pure geometry: zone table, isometric projection, desk-slot table, deterministic ephemeral desk assignment. No IO.                                                            | core   |
| `admin/src/office/reducer.ts`             | Pure reducers: `reconcileAgents(prev, rows)` → `OfficeState`; `reduceEvent(state, evt, now)` → `{ state, effects }`. No IO.                                                  | core   |
| `admin/src/office/state-bridge.ts`        | `OfficeBridge` class: owns `EventSource` + 5s poll, calls reducers, fans out to `subscribe()` listeners. Injectable `fetchFn`/`EventSourceCtor` for tests. No pixi/react.    | io     |
| `admin/src/office/assets.ts`              | Asset manifest: `textureUrl(role, spriteState)` + `PLACEHOLDER_MODE` flag + role accent colors.                                                                              | render |
| `admin/src/office/scene.ts`               | `OfficeScene` class wrapping a pixi `Application`: floor/zones, sprite create/destroy, tween animation + walking, pointer hit-test → `onSelect`. Reads state, never fetches. | render |
| `admin/src/pages/Office.tsx`              | Route page: mounts canvas in a ref, wires bridge↔scene, renders the React side-panel overlay, lifecycle (dispose/pause).                                                     | render |
| `admin/src/App.tsx` (modify)              | Add lazy `/office` route + "Bureau" nav link.                                                                                                                                | wiring |
| `admin/public/office/*.png`               | Warm Nano-Banana art (P4). Static assets, not bundled.                                                                                                                       | assets |
| `admin/tests/office/layout.test.ts`       | Unit tests for `layout.ts`.                                                                                                                                                  | test   |
| `admin/tests/office/reducer.test.ts`      | Unit tests for `reducer.ts` (the bulk of coverage).                                                                                                                          | test   |
| `admin/tests/office/state-bridge.test.ts` | Unit tests for `OfficeBridge` with injected fakes.                                                                                                                           | test   |
| `admin/tests/smoke.test.tsx` (modify)     | Refactor the bundle-size guard to assert the **entry** chunk stays lean (pixi must be a separate lazy chunk).                                                                | test   |

---

## PHASE 1 — Shell (route, lazy mount, static isometric floor)

_Demo at end: navigating to `/office` shows the empty open-studio office (floor + labeled zones) rendered by PixiJS; landing-page bundle stays lean._

### Task 1.1: Shared types

**Files:**

- Create: `admin/src/office/types.ts`

- [ ] **Step 1: Write the types**

```ts
// admin/src/office/types.ts
// Shared types for the /office isometric view. Pure data — no pixi, no react.

/** Visual animation state of an agent sprite. */
export type SpriteState = 'idle' | 'working' | 'talking' | 'blocked' | 'walking';

/** The fixed zones of the open-studio floor plan. */
export type ZoneId =
  | 'sales-floor'
  | 'ads-wing'
  | 'maxance-booth'
  | 'reporter-office'
  | 'supervisor-corner';

/** One agent currently shown in the office. Derived from AgentStateRow + live events. */
export interface OfficeAgent {
  /** `${role}#${instanceId}` — stable identity. */
  key: string;
  role: string;
  instanceId: string;
  /** Raw agents_state.status: running|starting|stopping|stopped|crashed. */
  status: string;
  model: string;
  queue: string;
  priority: number | null;
  lastHeartbeatAt: string;
  error: string | null;
  zone: ZoneId;
  /** Resolved desk slot id within the zone. */
  deskId: string;
  spriteState: SpriteState;
  /** epoch ms of the last activity that promoted this agent to `working`. */
  lastActiveAt: number;
}

/** Reconciled, renderable snapshot. */
export interface OfficeState {
  agents: Map<string, OfficeAgent>;
  generatedAt: number;
}

/** Transient one-shot effects the renderer animates then forgets. */
export type OfficeEffect =
  | { kind: 'message'; toRole: string; intent: string; correlationId: string | null; at: number }
  | { kind: 'attention'; severity: number; at: number }
  | { kind: 'marquee-quote'; toRole: 'maxance-operator'; at: number };

/** What the bridge hands subscribers on every update. */
export interface BridgeSnapshot {
  state: OfficeState;
  effects: OfficeEffect[];
}
```

- [ ] **Step 2: Typecheck**

Run: `cd Assuryal/F16/admin && pnpm typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add admin/src/office/types.ts
git commit -m "feat(admin): office view shared types"
```

---

### Task 1.2: Layout geometry (zones, iso projection, desks) — TDD

**Files:**

- Create: `admin/src/office/layout.ts`
- Test: `admin/tests/office/layout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// admin/tests/office/layout.test.ts
import { describe, it, expect } from 'vitest';
import {
  ZONES,
  isoToScreen,
  homeDeskFor,
  assignSalesDesk,
  PERSISTENT_HOME,
} from '../../src/office/layout';

describe('layout: zones', () => {
  it('defines all five zones', () => {
    expect(Object.keys(ZONES).sort()).toEqual([
      'ads-wing',
      'maxance-booth',
      'reporter-office',
      'sales-floor',
      'supervisor-corner',
    ]);
  });
});

describe('layout: isoToScreen', () => {
  it('maps grid origin to the configured screen origin', () => {
    const p = isoToScreen(0, 0);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(0);
  });
  it('produces the diamond transform (x grows right+down, y grows left+down)', () => {
    const a = isoToScreen(1, 0);
    const b = isoToScreen(0, 1);
    expect(a.x).toBeGreaterThan(0);
    expect(a.y).toBeGreaterThan(0);
    expect(b.x).toBeLessThan(0);
    expect(b.y).toBeGreaterThan(0);
  });
});

describe('layout: persistent home desks', () => {
  it('maps each persistent role to a fixed zone+desk', () => {
    expect(homeDeskFor('supervisor')).toEqual(PERSISTENT_HOME['supervisor']);
    expect(homeDeskFor('maxance-operator').zone).toBe('maxance-booth');
    expect(homeDeskFor('ads-manager-agent').zone).toBe('ads-wing');
    expect(homeDeskFor('creative-agent').zone).toBe('ads-wing');
    expect(homeDeskFor('human-router').zone).toBe('reporter-office');
  });
  it('returns a sales-floor home for unknown/ephemeral roles', () => {
    expect(homeDeskFor('sales-agent').zone).toBe('sales-floor');
    expect(homeDeskFor('totally-new-agent').zone).toBe('sales-floor');
  });
});

describe('layout: assignSalesDesk', () => {
  it('is deterministic for the same instanceId across calls', () => {
    const taken = new Set<string>();
    const a = assignSalesDesk('inst-abc', taken);
    const a2 = assignSalesDesk('inst-abc', new Set([a]));
    expect(a2).toBe(a); // same instance keeps its preferred slot when free
  });
  it('avoids collisions: a taken preferred slot yields a different free slot', () => {
    const first = assignSalesDesk('inst-abc', new Set());
    const second = assignSalesDesk('inst-xyz', new Set([first]));
    expect(second).not.toBe(first);
  });
  it('always returns a non-empty desk id', () => {
    expect(assignSalesDesk('whatever', new Set())).toMatch(/^sales-/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Assuryal/F16/admin && pnpm test -- office/layout`
Expected: FAIL ("Cannot find module '../../src/office/layout'").

- [ ] **Step 3: Implement `layout.ts`**

```ts
// admin/src/office/layout.ts
// Pure geometry + placement for the isometric office. No IO, no pixi.
import type { ZoneId } from './types';

export interface ScreenPoint {
  x: number;
  y: number;
}
export interface DeskRef {
  zone: ZoneId;
  deskId: string;
  /** grid coordinates (col,row) of the desk within the floor grid. */
  col: number;
  row: number;
}

/** Tile half-dimensions for the 2:1 isometric projection. */
export const TILE_W = 64;
export const TILE_H = 32;

/** Convert isometric grid (col,row) to screen-space (pre-camera) coordinates. */
export function isoToScreen(col: number, row: number): ScreenPoint {
  return {
    x: (col - row) * (TILE_W / 2),
    y: (col + row) * (TILE_H / 2),
  };
}

export interface ZoneDef {
  id: ZoneId;
  label: string;
  /** bounding grid rectangle [col0,row0 .. col1,row1] inclusive. */
  rect: { col0: number; row0: number; col1: number; row1: number };
  accent: number; // hex color for the zone rug/label
}

/**
 * Open-studio floor plan on a 12x12 grid. Central sales floor, four corners.
 *   - ads-wing      : top-left
 *   - supervisor    : top-right
 *   - maxance-booth : bottom-left
 *   - reporter      : bottom-right
 *   - sales-floor   : center
 */
export const ZONES: Record<ZoneId, ZoneDef> = {
  'ads-wing': {
    id: 'ads-wing',
    label: 'Aile Pub',
    rect: { col0: 0, row0: 0, col1: 3, row1: 2 },
    accent: 0xfb923c,
  },
  'supervisor-corner': {
    id: 'supervisor-corner',
    label: 'Coin Superviseur',
    rect: { col0: 9, row0: 0, col1: 11, row1: 2 },
    accent: 0xf87171,
  },
  'maxance-booth': {
    id: 'maxance-booth',
    label: 'Cabine Maxance',
    rect: { col0: 0, row0: 9, col1: 3, row1: 11 },
    accent: 0xfbbf24,
  },
  'reporter-office': {
    id: 'reporter-office',
    label: 'Bureau Reporter',
    rect: { col0: 9, row0: 9, col1: 11, row1: 11 },
    accent: 0x34d399,
  },
  'sales-floor': {
    id: 'sales-floor',
    label: 'Open Sales Floor',
    rect: { col0: 4, row0: 3, col1: 8, row1: 9 },
    accent: 0x38bdf8,
  },
};

/** Fixed home desks for the persistent agent roles. */
export const PERSISTENT_HOME: Record<string, DeskRef> = {
  supervisor: { zone: 'supervisor-corner', deskId: 'sup-1', col: 10, row: 1 },
  'maxance-operator': { zone: 'maxance-booth', deskId: 'max-1', col: 1, row: 10 },
  'human-router': { zone: 'reporter-office', deskId: 'rep-1', col: 10, row: 10 },
  'ads-manager-agent': { zone: 'ads-wing', deskId: 'ads-1', col: 1, row: 1 },
  'creative-agent': { zone: 'ads-wing', deskId: 'ads-2', col: 2, row: 1 },
  'voice-operator': { zone: 'sales-floor', deskId: 'sales-voice', col: 8, row: 4 },
  'engagement-agent': { zone: 'sales-floor', deskId: 'sales-engage', col: 8, row: 6 },
  'lead-scorer': { zone: 'sales-floor', deskId: 'sales-scorer', col: 4, row: 3 },
};

/** Sales-floor desk slots available to ephemeral sales-agent instances. */
export const SALES_DESKS: DeskRef[] = [
  { zone: 'sales-floor', deskId: 'sales-1', col: 5, row: 4 },
  { zone: 'sales-floor', deskId: 'sales-2', col: 6, row: 4 },
  { zone: 'sales-floor', deskId: 'sales-3', col: 7, row: 4 },
  { zone: 'sales-floor', deskId: 'sales-4', col: 5, row: 6 },
  { zone: 'sales-floor', deskId: 'sales-5', col: 6, row: 6 },
  { zone: 'sales-floor', deskId: 'sales-6', col: 7, row: 6 },
  { zone: 'sales-floor', deskId: 'sales-7', col: 5, row: 8 },
  { zone: 'sales-floor', deskId: 'sales-8', col: 6, row: 8 },
];

/** Door / entrance grid position where ephemerals walk in/out. */
export const ENTRANCE: ScreenPoint = isoToScreen(6, 11);

/** Home desk for a role. Unknown/ephemeral roles default to the sales floor. */
export function homeDeskFor(role: string): DeskRef {
  const home = PERSISTENT_HOME[role];
  if (home) return home;
  return { zone: 'sales-floor', deskId: 'sales-floor-home', col: 6, row: 6 };
}

/** Simple stable string hash → non-negative int. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Deterministically assign an ephemeral sales-agent to a desk slot.
 * Prefers the hash-derived slot; if taken, scans forward to the next free
 * slot; overflow falls back to a synthetic back-row id so we never collide.
 */
export function assignSalesDesk(instanceId: string, taken: ReadonlySet<string>): string {
  const n = SALES_DESKS.length;
  const start = hashString(instanceId) % n;
  for (let i = 0; i < n; i += 1) {
    const slot = SALES_DESKS[(start + i) % n];
    if (!taken.has(slot.deskId)) return slot.deskId;
  }
  // All slots taken — synthesize a stable overflow id from the instance.
  return `sales-overflow-${hashString(instanceId) % 1000}`;
}

/** Resolve a deskId to its grid coordinates (for rendering position). */
export function deskCoords(deskId: string): ScreenPoint {
  for (const d of Object.values(PERSISTENT_HOME)) {
    if (d.deskId === deskId) return isoToScreen(d.col, d.row);
  }
  for (const d of SALES_DESKS) {
    if (d.deskId === deskId) return isoToScreen(d.col, d.row);
  }
  // overflow / unknown — drop near the sales-floor center.
  return isoToScreen(6, 7);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Assuryal/F16/admin && pnpm test -- office/layout`
Expected: PASS (all layout tests green).

- [ ] **Step 5: Commit**

```bash
git add admin/src/office/layout.ts admin/tests/office/layout.test.ts
git commit -m "feat(admin): office floor-plan geometry + desk assignment"
```

---

### Task 1.3: Asset manifest (placeholder mode)

**Files:**

- Create: `admin/src/office/assets.ts`

- [ ] **Step 1: Write the manifest**

```ts
// admin/src/office/assets.ts
// Maps (role, spriteState) → texture URL. In PLACEHOLDER_MODE the scene draws
// programmatic shapes instead of loading PNGs (P1–P3). P4 flips the flag and
// drops the warm Nano-Banana art into admin/public/office/.
import type { SpriteState } from './types';

/** Flip to false in P4 once the warm art lands in public/office/. */
export const PLACEHOLDER_MODE = true;

/** Accent color per role for placeholder sprites + side-panel chips. */
export const ROLE_COLOR: Record<string, number> = {
  'sales-agent': 0x38bdf8,
  'voice-operator': 0xa78bfa,
  'maxance-operator': 0xfbbf24,
  supervisor: 0xf87171,
  'human-router': 0x34d399,
  'engagement-agent': 0x5eead4,
  'ads-manager-agent': 0xfb923c,
  'creative-agent': 0xf472b6,
  'lead-scorer': 0x94a3b8,
};

export function roleColor(role: string): number {
  return ROLE_COLOR[role] ?? 0x94a3b8;
}

/** Public URL for a character texture. Only used when PLACEHOLDER_MODE=false. */
export function textureUrl(role: string, state: SpriteState): string {
  const pose = state === 'walking' || state === 'talking' || state === 'working' ? state : 'idle';
  return `/office/char-${role}-${pose}.png`;
}

/** Public URLs for environment textures (P4). */
export const ENV_TEXTURES = {
  floorTile: '/office/floor-tile.png',
  desk: '/office/prop-desk.png',
  plant: '/office/prop-plant.png',
  maxanceBooth: '/office/prop-maxance.png',
  door: '/office/prop-door.png',
} as const;
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd Assuryal/F16/admin && pnpm typecheck`
Expected: PASS.

```bash
git add admin/src/office/assets.ts
git commit -m "feat(admin): office asset manifest + placeholder mode"
```

---

### Task 1.4: PixiJS scene — static floor + zones

**Files:**

- Create: `admin/src/office/scene.ts`

> The scene is a plain class wrapping a pixi `Application`. In P1 it renders only the floor + zone rugs + labels. Sprites/animation come in P2/P3. Pixi v8 API: `app.init(...)` is async; `Graphics` uses the chained `.rect().fill()` style; containers are added via `app.stage.addChild`.

- [ ] **Step 1: Implement the P1 scene**

```ts
// admin/src/office/scene.ts
// PixiJS renderer for the isometric office. Reads OfficeState, never fetches.
// V2 (Three.js) replaces THIS file only — the state core stays untouched.
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { ZONES, isoToScreen, TILE_W, TILE_H } from './layout';
import type { ZoneDef } from './layout';

export interface OfficeSceneOptions {
  /** Called when the user taps a sprite. agentKey is `role#instanceId`. */
  onSelect?: (agentKey: string | null) => void;
}

export class OfficeScene {
  private app: Application;
  private world: Container;
  private floorLayer: Container;
  private ready = false;

  constructor(private readonly opts: OfficeSceneOptions = {}) {
    this.app = new Application();
    this.world = new Container();
    this.floorLayer = new Container();
  }

  /** Async init — must be awaited before any draw call. */
  async mount(host: HTMLDivElement): Promise<void> {
    await this.app.init({
      resizeTo: host,
      antialias: true,
      backgroundColor: 0x0f172a,
      autoDensity: true,
      resolution: globalThis.devicePixelRatio ?? 1,
    });
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.world);
    this.world.addChild(this.floorLayer);
    this.world.eventMode = 'static';
    this.world.on('pointertap', () => this.opts.onSelect?.(null)); // background tap clears
    this.ready = true;
    this.drawFloor();
    this.centerCamera(host);
  }

  private centerCamera(host: HTMLDivElement): void {
    // Center the 12x12 diamond in the viewport.
    const mid = isoToScreen(6, 6);
    this.world.position.set(host.clientWidth / 2 - mid.x, host.clientHeight / 2 - mid.y - 40);
    this.world.scale.set(1);
  }

  private drawFloor(): void {
    this.floorLayer.removeChildren();
    // Draw each zone rug as a filled isometric rectangle of tiles.
    for (const zone of Object.values(ZONES)) {
      this.drawZone(zone);
    }
  }

  private drawZone(zone: ZoneDef): void {
    const g = new Graphics();
    const { col0, row0, col1, row1 } = zone.rect;
    for (let c = col0; c <= col1; c += 1) {
      for (let r = row0; r <= row1; r += 1) {
        const p = isoToScreen(c, r);
        // diamond tile
        g.moveTo(p.x, p.y - TILE_H / 2);
        g.lineTo(p.x + TILE_W / 2, p.y);
        g.lineTo(p.x, p.y + TILE_H / 2);
        g.lineTo(p.x - TILE_W / 2, p.y);
        g.closePath();
      }
    }
    g.fill({ color: zone.accent, alpha: 0.16 });
    g.stroke({ color: zone.accent, alpha: 0.5, width: 1 });
    this.floorLayer.addChild(g);

    // Zone label at the top corner of its rect.
    const labelPos = isoToScreen(zone.rect.col0, zone.rect.row0);
    const style = new TextStyle({ fill: 0xe2e8f0, fontSize: 12, fontWeight: '700' });
    const label = new Text({ text: zone.label, style });
    label.position.set(labelPos.x - TILE_W / 2, labelPos.y - TILE_H);
    this.floorLayer.addChild(label);
  }

  /** Re-center on container resize. */
  handleResize(host: HTMLDivElement): void {
    if (!this.ready) return;
    this.centerCamera(host);
  }

  pause(): void {
    if (this.ready) this.app.ticker.stop();
  }

  resume(): void {
    if (this.ready) this.app.ticker.start();
  }

  destroy(): void {
    // Pixi v8: destroy removes the canvas + frees GPU resources.
    this.app.destroy(true, { children: true, texture: true });
    this.ready = false;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd Assuryal/F16/admin && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add admin/src/office/scene.ts
git commit -m "feat(admin): office pixi scene with static floor + zones"
```

---

### Task 1.5: Office route page (mount canvas) + lazy route + nav

**Files:**

- Create: `admin/src/pages/Office.tsx`
- Modify: `admin/src/App.tsx`

- [ ] **Step 1: Implement the P1 page**

```tsx
// admin/src/pages/Office.tsx
import { useEffect, useRef, type ReactElement } from 'react';
import { OfficeScene } from '@/office/scene';

export default function OfficePage(): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let scene: OfficeScene | null = new OfficeScene();
    let disposed = false;

    void scene.mount(host).then(() => {
      // StrictMode double-invokes effects in dev; if we were torn down
      // during the async mount, destroy immediately.
      if (disposed) scene?.destroy();
    });

    const onResize = (): void => scene?.handleResize(host);
    const onVisibility = (): void => {
      if (document.hidden) scene?.pause();
      else scene?.resume();
    };
    globalThis.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      globalThis.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      scene?.destroy();
      scene = null;
    };
  }, []);

  return (
    <div className="relative h-[calc(100vh-57px)] w-full overflow-hidden bg-slate-900">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute top-4 left-4 rounded-md bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-200">
        Bureau F16 — vue live
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire a lazy route + nav link in `App.tsx`**

In `admin/src/App.tsx`:

Add at the top with the other imports (use `lazy`/`Suspense` so pixi is code-split out of the landing bundle):

```tsx
import { lazy, Suspense, type ReactElement } from 'react';
```

(Replace the existing `import type { ReactElement } from 'react';` line with the line above.)

Add after the other page imports:

```tsx
const OfficePage = lazy(() => import('@/pages/Office'));
```

Add the nav link inside `<Nav>` immediately after the `/dashboard` NavLink:

```tsx
<NavLink to="/office" className={navItemClass}>
  Bureau
</NavLink>
```

Add the route inside `<Routes>` (after the `/dashboard` route):

```tsx
<Route
  path="/office"
  element={
    <Suspense
      fallback={<div className="text-muted-foreground p-6 text-sm">Chargement du bureau…</div>}
    >
      <OfficePage />
    </Suspense>
  }
/>
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd Assuryal/F16/admin && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Build to confirm pixi is code-split (not in the entry chunk)**

Run: `cd Assuryal/F16/admin && pnpm build`
Expected: build succeeds; Vite output lists a **separate** chunk for the Office/pixi import (e.g. `Office-*.js` of a few hundred KB) distinct from the main `index-*.js`.

- [ ] **Step 5: Commit**

```bash
git add admin/src/pages/Office.tsx admin/src/App.tsx
git commit -m "feat(admin): office route, lazy pixi mount + bureau nav"
```

---

### Task 1.6: Fix the bundle-size guard to assert the entry chunk (not total)

The smoke test currently sums **all** `dist/assets` bytes and caps at 2 MB to catch "pixi bundled into the landing page". Now that pixi is a legitimate lazy chunk, the correct expression of that intent is: the **entry** chunk referenced by `index.html` stays lean, AND a separate office/pixi chunk exists.

**Files:**

- Modify: `admin/tests/smoke.test.tsx`

- [ ] **Step 1: Replace the `build artifact (shape)` describe block**

Replace the entire `describe('build artifact (shape)', ...)` block (currently lines ~83–110) with:

```tsx
// Build-artifact smoke check — only runs if `pnpm build` has produced dist/.
describe('build artifact (shape)', () => {
  it.skipIf(!existsSync(distDir))(
    'index.html references a lean entry chunk; pixi is code-split into its own chunk',
    async () => {
      const indexPath = join(distDir, 'index.html');
      expect(existsSync(indexPath)).toBe(true);

      const { readFileSync, readdirSync } = await import('node:fs');
      const html = readFileSync(indexPath, 'utf8');
      expect(html).toMatch(/<script[^>]+src="\/assets\/[^"]+\.js"/);
      expect(html).toMatch(/<link[^>]+href="\/assets\/[^"]+\.css"/);
      expect(html).toContain('<div id="root">');

      const assetsDir = join(distDir, 'assets');
      expect(existsSync(assetsDir)).toBe(true);
      const files = readdirSync(assetsDir);

      // The ENTRY chunk (referenced directly by index.html) must stay lean:
      // pixi/recharts must NOT be bundled into it.
      const entryMatch = html.match(/<script[^>]+src="\/assets\/([^"]+\.js)"/);
      expect(entryMatch).not.toBeNull();
      const entryFile = entryMatch![1];
      const entryBytes = statSync(join(assetsDir, entryFile)).size;
      expect(entryBytes).toBeLessThan(800_000); // ~lean entry; pixi lives elsewhere

      // A separate (lazy) chunk must carry the office/pixi code.
      const hasLazyChunk = files.some(
        (f) => /Office|pixi|index-[A-Za-z0-9_-]+\.js/.test(f) && f !== entryFile,
      );
      expect(hasLazyChunk).toBe(true);
    },
  );
});
```

- [ ] **Step 2: Run the smoke test against the fresh build**

Run: `cd Assuryal/F16/admin && pnpm test -- smoke`
Expected: PASS (entry chunk < 800 KB; a separate lazy chunk exists).

- [ ] **Step 3: Commit**

```bash
git add admin/tests/smoke.test.tsx
git commit -m "test(admin): assert lean entry chunk + code-split office bundle"
```

> Note: commit scope `test` is not in the enum — use `admin`. Reword to `git commit -m "test(admin): ..."` → actually use: `git commit -m "chore(admin): guard lean entry chunk + code-split office"`. Use scope **admin**, type `chore`.

---

### ✅ Phase 1 live-verify (on this PC)

- [ ] Ensure infra up: `docker compose -f infra/docker-compose.dev.yml up -d` (pg 5435, redis 6380).
- [ ] Backend: from `Assuryal/F16/backend`, Bash background: `env -u ANTHROPIC_API_KEY PORT=3001 npx tsx src/index.ts`.
- [ ] Admin: from `Assuryal/F16/admin`, `pnpm dev`. Open `http://localhost:5173/office`.
- [ ] Confirm: the isometric floor renders with five labeled zones; navbar shows **Bureau**; no console errors; switching tabs pauses (no CPU spin).
- [ ] Log progress to ruflo (`m14-t11-P1-DONE`).

---

## PHASE 2 — Live wiring (state core + bridge + sprites + side panel)

_Demo at end: real agents from the running backend appear as colored sprites at their desks, update on the 5s poll, and clicking one opens a live side panel._

### Task 2.1: Pure reducers — `reconcileAgents` + `reduceEvent` (TDD)

**Files:**

- Create: `admin/src/office/reducer.ts`
- Test: `admin/tests/office/reducer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// admin/tests/office/reducer.test.ts
import { describe, it, expect } from 'vitest';
import { emptyState, reconcileAgents, reduceEvent } from '../../src/office/reducer';
import type { AgentStateRow } from '../../src/lib/api';

function row(p: Partial<AgentStateRow> & { role: string; instanceId: string }): AgentStateRow {
  return {
    model: 'sonnet',
    queue: 'default',
    status: 'running',
    priority: null,
    startedAt: '2026-06-09T10:00:00.000Z',
    lastHeartbeatAt: '2026-06-09T10:00:00.000Z',
    stoppedAt: null,
    error: null,
    inMemory: true,
    ...p,
  };
}

describe('reconcileAgents', () => {
  it('places a persistent role at its home desk + idle', () => {
    const s = reconcileAgents(emptyState(), [row({ role: 'supervisor', instanceId: 'i1' })], 1000);
    const a = s.agents.get('supervisor#i1');
    expect(a?.zone).toBe('supervisor-corner');
    expect(a?.deskId).toBe('sup-1');
    expect(a?.spriteState).toBe('idle');
  });

  it('assigns ephemeral sales agents to distinct sales desks', () => {
    const s = reconcileAgents(
      emptyState(),
      [
        row({ role: 'sales-agent', instanceId: 'a' }),
        row({ role: 'sales-agent', instanceId: 'b' }),
      ],
      1000,
    );
    const a = s.agents.get('sales-agent#a');
    const b = s.agents.get('sales-agent#b');
    expect(a?.zone).toBe('sales-floor');
    expect(a?.deskId).not.toBe(b?.deskId);
  });

  it('keeps a sales agent on the same desk across reconciles', () => {
    const s1 = reconcileAgents(emptyState(), [row({ role: 'sales-agent', instanceId: 'a' })], 1000);
    const desk1 = s1.agents.get('sales-agent#a')?.deskId;
    const s2 = reconcileAgents(s1, [row({ role: 'sales-agent', instanceId: 'a' })], 2000);
    expect(s2.agents.get('sales-agent#a')?.deskId).toBe(desk1);
  });

  it('maps crashed / error status to blocked', () => {
    const s = reconcileAgents(
      emptyState(),
      [row({ role: 'supervisor', instanceId: 'i1', status: 'crashed' })],
      1000,
    );
    expect(s.agents.get('supervisor#i1')?.spriteState).toBe('blocked');
  });

  it('removes agents that disappear from the roster', () => {
    const s1 = reconcileAgents(emptyState(), [row({ role: 'sales-agent', instanceId: 'a' })], 1000);
    const s2 = reconcileAgents(s1, [], 2000);
    expect(s2.agents.has('sales-agent#a')).toBe(false);
  });

  it('preserves lastActiveAt across reconciles', () => {
    let s = reconcileAgents(emptyState(), [row({ role: 'supervisor', instanceId: 'i1' })], 1000);
    s = reduceEvent(
      s,
      { type: 'agent_message', toRole: 'supervisor', intent: 'X', correlationId: null },
      5000,
    ).state;
    const active = s.agents.get('supervisor#i1')?.lastActiveAt;
    s = reconcileAgents(s, [row({ role: 'supervisor', instanceId: 'i1' })], 6000);
    expect(s.agents.get('supervisor#i1')?.lastActiveAt).toBe(active);
  });
});

describe('reduceEvent: agent_message', () => {
  it('flips the target role to talking + emits a message effect', () => {
    const base = reconcileAgents(
      emptyState(),
      [row({ role: 'maxance-operator', instanceId: 'm' })],
      1000,
    );
    const { state, effects } = reduceEvent(
      base,
      { type: 'agent_message', toRole: 'maxance-operator', intent: 'PING', correlationId: 'c1' },
      2000,
    );
    expect(state.agents.get('maxance-operator#m')?.spriteState).toBe('talking');
    expect(state.agents.get('maxance-operator#m')?.lastActiveAt).toBe(2000);
    expect(effects).toContainEqual({
      kind: 'message',
      toRole: 'maxance-operator',
      intent: 'PING',
      correlationId: 'c1',
      at: 2000,
    });
  });

  it('emits a marquee-quote effect for QUOTE intents to maxance-operator', () => {
    const base = reconcileAgents(
      emptyState(),
      [row({ role: 'maxance-operator', instanceId: 'm' })],
      1000,
    );
    const { effects } = reduceEvent(
      base,
      {
        type: 'agent_message',
        toRole: 'maxance-operator',
        intent: 'QUOTE.REQUESTED',
        correlationId: null,
      },
      2000,
    );
    expect(effects.some((e) => e.kind === 'marquee-quote')).toBe(true);
  });

  it('does not emit marquee for non-quote intents', () => {
    const base = reconcileAgents(
      emptyState(),
      [row({ role: 'maxance-operator', instanceId: 'm' })],
      1000,
    );
    const { effects } = reduceEvent(
      base,
      { type: 'agent_message', toRole: 'maxance-operator', intent: 'HELLO', correlationId: null },
      2000,
    );
    expect(effects.some((e) => e.kind === 'marquee-quote')).toBe(false);
  });
});

describe('reduceEvent: human_action', () => {
  it('emits an attention effect for high-severity INSERTs', () => {
    const { effects } = reduceEvent(
      emptyState(),
      { type: 'human_action', op: 'INSERT', status: 'pending', severity: 3, correlationId: null },
      2000,
    );
    expect(effects).toContainEqual({ kind: 'attention', severity: 3, at: 2000 });
  });

  it('ignores low-severity or non-insert human actions', () => {
    const a = reduceEvent(
      emptyState(),
      { type: 'human_action', op: 'UPDATE', status: 'resolved', severity: 3, correlationId: null },
      2000,
    );
    const b = reduceEvent(
      emptyState(),
      { type: 'human_action', op: 'INSERT', status: 'pending', severity: 1, correlationId: null },
      2000,
    );
    expect(a.effects.length).toBe(0);
    expect(b.effects.length).toBe(0);
  });
});

describe('decay: talking returns to resting after the window', () => {
  it('reverts talking → idle once the talk window elapses', () => {
    let s = reconcileAgents(emptyState(), [row({ role: 'supervisor', instanceId: 'i1' })], 1000);
    s = reduceEvent(
      s,
      { type: 'agent_message', toRole: 'supervisor', intent: 'X', correlationId: null },
      2000,
    ).state;
    expect(s.agents.get('supervisor#i1')?.spriteState).toBe('talking');
    // Re-reconcile well after the talk window — should settle to working (recent) or idle.
    const after = reconcileAgents(
      s,
      [row({ role: 'supervisor', instanceId: 'i1' })],
      2000 + 60_000,
    );
    expect(after.agents.get('supervisor#i1')?.spriteState).toBe('idle');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Assuryal/F16/admin && pnpm test -- office/reducer`
Expected: FAIL ("Cannot find module '../../src/office/reducer'").

- [ ] **Step 3: Implement `reducer.ts`**

```ts
// admin/src/office/reducer.ts
// Pure state reducers for the office. No IO, no pixi, no react. This is the
// V2-stable seam: a Three.js renderer would consume the same OfficeState.
import type { AgentStateRow } from '@/lib/api';
import type { OfficeAgent, OfficeEffect, OfficeState, SpriteState } from './types';
import { assignSalesDesk, homeDeskFor, SALES_DESKS } from './layout';

/** How long after activity an agent shows `working`. */
const WORKING_WINDOW_MS = 12_000;
/** How long a `talking` flash lasts before settling. */
const TALKING_WINDOW_MS = 3_000;
/** Severity at/above which a human_action raises an attention effect. */
const ATTENTION_SEVERITY = 3;

export type BridgeEvent =
  | { type: 'agent_message'; toRole: string; intent: string; correlationId: string | null }
  | {
      type: 'human_action';
      op: 'INSERT' | 'UPDATE';
      status: string;
      severity: number;
      correlationId: string | null;
    };

export function emptyState(): OfficeState {
  return { agents: new Map(), generatedAt: 0 };
}

function isSalesEphemeral(role: string): boolean {
  return role === 'sales-agent';
}

/** Resting sprite state from raw status + activity recency. */
function restingState(
  status: string,
  error: string | null,
  lastActiveAt: number,
  now: number,
): SpriteState {
  if (status === 'crashed' || error) return 'blocked';
  if (status === 'starting' || status === 'stopping') return 'walking';
  if (now - lastActiveAt < WORKING_WINDOW_MS) return 'working';
  return 'idle';
}

/**
 * Rebuild OfficeState from the authoritative agents roster. Preserves
 * per-agent desk assignment and lastActiveAt across reconciles; drops
 * agents no longer present (or fully stopped).
 */
export function reconcileAgents(
  prev: OfficeState,
  rows: AgentStateRow[],
  now: number,
): OfficeState {
  const agents = new Map<string, OfficeAgent>();
  // Desks already taken this pass (so ephemerals don't collide).
  const takenSalesDesks = new Set<string>();

  // First pass: keep stable desks for sales agents that already had one.
  for (const r of rows) {
    if (!isSalesEphemeral(r.role)) continue;
    const key = `${r.role}#${r.instanceId}`;
    const existing = prev.agents.get(key);
    if (existing && SALES_DESKS.some((d) => d.deskId === existing.deskId)) {
      takenSalesDesks.add(existing.deskId);
    }
  }

  for (const r of rows) {
    if (r.status === 'stopped') continue; // stopped agents leave the floor
    const key = `${r.role}#${r.instanceId}`;
    const prevAgent = prev.agents.get(key);
    const lastActiveAt = prevAgent?.lastActiveAt ?? 0;

    let zone: OfficeAgent['zone'];
    let deskId: string;
    if (isSalesEphemeral(r.role)) {
      deskId =
        prevAgent && SALES_DESKS.some((d) => d.deskId === prevAgent.deskId)
          ? prevAgent.deskId
          : assignSalesDesk(r.instanceId, takenSalesDesks);
      takenSalesDesks.add(deskId);
      zone = 'sales-floor';
    } else {
      const home = homeDeskFor(r.role);
      zone = home.zone;
      deskId = home.deskId;
    }

    agents.set(key, {
      key,
      role: r.role,
      instanceId: r.instanceId,
      status: r.status,
      model: r.model,
      queue: r.queue,
      priority: r.priority,
      lastHeartbeatAt: r.lastHeartbeatAt,
      error: r.error,
      zone,
      deskId,
      spriteState: restingState(r.status, r.error, lastActiveAt, now),
      lastActiveAt,
    });
  }

  return { agents, generatedAt: now };
}

/** Apply a live SSE event, returning a new state + any one-shot effects. */
export function reduceEvent(
  state: OfficeState,
  evt: BridgeEvent,
  now: number,
): { state: OfficeState; effects: OfficeEffect[] } {
  const effects: OfficeEffect[] = [];

  if (evt.type === 'agent_message') {
    effects.push({
      kind: 'message',
      toRole: evt.toRole,
      intent: evt.intent,
      correlationId: evt.correlationId,
      at: now,
    });
    if (/quote/i.test(evt.intent) && evt.toRole === 'maxance-operator') {
      effects.push({ kind: 'marquee-quote', toRole: 'maxance-operator', at: now });
    }
    const agents = new Map(state.agents);
    for (const [key, a] of agents) {
      if (a.role === evt.toRole) {
        agents.set(key, { ...a, spriteState: 'talking', lastActiveAt: now });
      }
    }
    return { state: { agents, generatedAt: now }, effects };
  }

  // human_action
  if (evt.op === 'INSERT' && evt.severity >= ATTENTION_SEVERITY) {
    effects.push({ kind: 'attention', severity: evt.severity, at: now });
  }
  return { state, effects };
}

/** Settle expired `talking` flashes (called by the bridge on a timer/poll). */
export function settleTalking(state: OfficeState, now: number): OfficeState {
  let changed = false;
  const agents = new Map(state.agents);
  for (const [key, a] of agents) {
    if (a.spriteState === 'talking' && now - a.lastActiveAt >= TALKING_WINDOW_MS) {
      agents.set(key, { ...a, spriteState: restingState(a.status, a.error, a.lastActiveAt, now) });
      changed = true;
    }
  }
  return changed ? { agents, generatedAt: now } : state;
}
```

> Note: `TALKING_WINDOW_MS` (3 s) < `WORKING_WINDOW_MS` (12 s), so the decay test (which jumps 60 s) settles to `idle`. The `settleTalking` helper is used by the bridge in Task 2.2.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Assuryal/F16/admin && pnpm test -- office/reducer`
Expected: PASS (all reducer tests green).

- [ ] **Step 5: Commit**

```bash
git add admin/src/office/reducer.ts admin/tests/office/reducer.test.ts
git commit -m "feat(admin): office pure state reducers + tests"
```

---

### Task 2.2: IO bridge — SSE + poll wiring (TDD with injected fakes)

**Files:**

- Create: `admin/src/office/state-bridge.ts`
- Test: `admin/tests/office/state-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// admin/tests/office/state-bridge.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OfficeBridge } from '../../src/office/state-bridge';
import type { AgentStateRow } from '../../src/lib/api';
import type { BridgeSnapshot } from '../../src/office/types';

function row(role: string, instanceId: string): AgentStateRow {
  return {
    role,
    instanceId,
    model: 'sonnet',
    queue: 'default',
    status: 'running',
    priority: null,
    startedAt: '2026-06-09T10:00:00.000Z',
    lastHeartbeatAt: '2026-06-09T10:00:00.000Z',
    stoppedAt: null,
    error: null,
    inMemory: true,
  };
}

/** Minimal fake EventSource we can drive from tests. */
class FakeEventSource {
  listeners = new Map<string, (e: MessageEvent) => void>();
  closed = false;
  constructor(public url: string) {}
  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    this.listeners.set(type, cb);
  }
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
  close(): void {
    this.closed = true;
  }
}

describe('OfficeBridge', () => {
  it('polls agents on start and notifies subscribers with a snapshot', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ rows: [row('supervisor', 'i1')] });
    const bridge = new OfficeBridge({
      fetchAgents: fetchFn,
      EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
      pollMs: 10_000,
      now: () => 1000,
    });
    const seen: BridgeSnapshot[] = [];
    bridge.subscribe((s) => seen.push(s));
    bridge.start();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.at(-1)?.state.agents.get('supervisor#i1')?.zone).toBe('supervisor-corner');
    bridge.dispose();
  });

  it('applies an agent_message SSE event to the snapshot', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ rows: [row('maxance-operator', 'm')] });
    let clock = 1000;
    const bridge = new OfficeBridge({
      fetchAgents: fetchFn,
      EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
      pollMs: 10_000,
      now: () => clock,
    });
    const seen: BridgeSnapshot[] = [];
    bridge.subscribe((s) => seen.push(s));
    bridge.start();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));

    clock = 2000;
    const es = bridge.__esForTest() as unknown as FakeEventSource;
    es.emit('agent_message', {
      id: 'x',
      intent: 'QUOTE.REQUESTED',
      toRole: 'maxance-operator',
      correlationId: null,
      priority: 5,
    });

    const last = seen.at(-1)!;
    expect(last.state.agents.get('maxance-operator#m')?.spriteState).toBe('talking');
    expect(last.effects.some((e) => e.kind === 'marquee-quote')).toBe(true);
    bridge.dispose();
  });

  it('closes the EventSource and stops polling on dispose', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ rows: [] });
    const bridge = new OfficeBridge({
      fetchAgents: fetchFn,
      EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
      pollMs: 10_000,
      now: () => 1000,
    });
    bridge.start();
    const es = bridge.__esForTest() as unknown as FakeEventSource;
    bridge.dispose();
    expect(es.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Assuryal/F16/admin && pnpm test -- office/state-bridge`
Expected: FAIL ("Cannot find module '../../src/office/state-bridge'").

- [ ] **Step 3: Implement `state-bridge.ts`**

```ts
// admin/src/office/state-bridge.ts
// Thin IO layer: owns the SSE EventSource + 5s agents poll, runs the pure
// reducers, and fans out BridgeSnapshots to subscribers. No pixi, no react.
import { getAdminToken, listAgents, type AgentStateRow, type ListAgentsResponse } from '@/lib/api';
import type { BridgeSnapshot, OfficeEffect, OfficeState } from './types';
import {
  emptyState,
  reconcileAgents,
  reduceEvent,
  settleTalking,
  type BridgeEvent,
} from './reducer';

export interface OfficeBridgeOptions {
  /** Override the agents fetch (tests). Defaults to listAgents(). */
  fetchAgents?: () => Promise<ListAgentsResponse>;
  /** Override EventSource (tests). Defaults to the global. */
  EventSourceCtor?: typeof EventSource;
  /** Poll cadence; default 5000. */
  pollMs?: number;
  /** Clock injection for tests; default Date.now. */
  now?: () => number;
}

type Listener = (snapshot: BridgeSnapshot) => void;

export class OfficeBridge {
  private state: OfficeState = emptyState();
  private listeners = new Set<Listener>();
  private es: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private settleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchAgents: () => Promise<ListAgentsResponse>;
  private readonly ESCtor: typeof EventSource;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(opts: OfficeBridgeOptions = {}) {
    this.fetchAgents = opts.fetchAgents ?? listAgents;
    this.ESCtor = opts.EventSourceCtor ?? (globalThis.EventSource as typeof EventSource);
    this.pollMs = opts.pollMs ?? 5000;
    this.now = opts.now ?? (() => Date.now());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): OfficeState {
    return this.state;
  }

  start(): void {
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.pollMs);
    // Settle expired talking flashes between polls.
    this.settleTimer = setInterval(() => {
      const next = settleTalking(this.state, this.now());
      if (next !== this.state) {
        this.state = next;
        this.emit([]);
      }
    }, 1000);
    this.openSse();
  }

  private openSse(): void {
    if (!this.ESCtor) return; // no EventSource (very old env) — poll-only.
    const token = getAdminToken();
    const url = token ? `/v1/admin/events?token=${encodeURIComponent(token)}` : '/v1/admin/events';
    const es = new this.ESCtor(url);
    es.addEventListener('agent_message', (e: MessageEvent) => {
      this.applyEvent(this.parse(e, 'agent_message'));
    });
    es.addEventListener('human_action', (e: MessageEvent) => {
      this.applyEvent(this.parse(e, 'human_action'));
    });
    this.es = es;
  }

  private parse(e: MessageEvent, type: 'agent_message' | 'human_action'): BridgeEvent | null {
    try {
      const d = JSON.parse(e.data as string) as Record<string, unknown>;
      if (type === 'agent_message') {
        return {
          type,
          toRole: String(d.toRole),
          intent: String(d.intent),
          correlationId: (d.correlationId as string | null) ?? null,
        };
      }
      return {
        type,
        op: d.op === 'UPDATE' ? 'UPDATE' : 'INSERT',
        status: String(d.status ?? ''),
        severity: Number(d.severity ?? 0),
        correlationId: (d.correlationId as string | null) ?? null,
      };
    } catch {
      return null;
    }
  }

  private applyEvent(evt: BridgeEvent | null): void {
    if (!evt) return;
    const { state, effects } = reduceEvent(this.state, evt, this.now());
    this.state = state;
    this.emit(effects);
  }

  private async poll(): Promise<void> {
    try {
      const rows: AgentStateRow[] = (await this.fetchAgents()).rows;
      this.state = reconcileAgents(this.state, rows, this.now());
      this.emit([]);
    } catch {
      // transient — keep last good state; next tick retries.
    }
  }

  private emit(effects: OfficeEffect[]): void {
    const snap: BridgeSnapshot = { state: this.state, effects };
    for (const fn of this.listeners) fn(snap);
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.settleTimer) clearInterval(this.settleTimer);
    this.es?.close();
    this.es = null;
    this.listeners.clear();
  }

  /** Test-only accessor for the underlying EventSource. */
  __esForTest(): EventSource | null {
    return this.es;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Assuryal/F16/admin && pnpm test -- office/state-bridge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/src/office/state-bridge.ts admin/tests/office/state-bridge.test.ts
git commit -m "feat(admin): office io bridge (sse + poll) + tests"
```

---

### Task 2.3: Render sprites + selection in the scene

**Files:**

- Modify: `admin/src/office/scene.ts`

- [ ] **Step 1: Add a sprite layer + `applySnapshot` + placeholder sprites**

Add imports at the top of `scene.ts`:

```ts
import { roleColor, PLACEHOLDER_MODE } from './assets';
import { deskCoords } from './layout';
import type { OfficeAgent, OfficeState } from './types';
```

Add fields to the class (next to `floorLayer`):

```ts
  private spriteLayer: Container = new Container();
  private sprites = new Map<string, Container>();
```

In `mount()`, after `this.world.addChild(this.floorLayer);` add:

```ts
this.world.addChild(this.spriteLayer);
```

Add these methods to the class:

```ts
  /** Reconcile the sprite set to a new state snapshot. */
  applySnapshot(state: OfficeState): void {
    if (!this.ready) return;
    // Remove sprites no longer present.
    for (const [key, node] of this.sprites) {
      if (!state.agents.has(key)) {
        node.destroy({ children: true });
        this.sprites.delete(key);
      }
    }
    // Add / update.
    for (const agent of state.agents.values()) {
      let node = this.sprites.get(agent.key);
      if (!node) {
        node = this.makeSprite(agent);
        this.sprites.set(agent.key, node);
        this.spriteLayer.addChild(node);
      }
      this.positionSprite(node, agent);
      this.styleSprite(node, agent);
    }
    // Depth-sort by screen Y so nearer desks overlap correctly.
    this.spriteLayer.children.sort((a, b) => a.y - b.y);
  }

  private makeSprite(agent: OfficeAgent): Container {
    const node = new Container();
    node.eventMode = 'static';
    node.cursor = 'pointer';
    node.on('pointertap', (e) => {
      e.stopPropagation();
      this.opts.onSelect?.(agent.key);
    });
    if (PLACEHOLDER_MODE) {
      const body = new Graphics();
      body.label = 'body';
      node.addChild(body);
      const badge = new Graphics();
      badge.label = 'badge';
      node.addChild(badge);
    }
    return node;
  }

  private positionSprite(node: Container, agent: OfficeAgent): void {
    const p = deskCoords(agent.deskId);
    node.position.set(p.x, p.y - 14); // lift so the sprite stands on the tile
  }

  private styleSprite(node: Container, agent: OfficeAgent): void {
    if (!PLACEHOLDER_MODE) return; // textures handled in P4
    const body = node.getChildByLabel('body') as Graphics | null;
    const badge = node.getChildByLabel('badge') as Graphics | null;
    if (body) {
      body.clear();
      body.roundRect(-9, -22, 18, 26, 5).fill({ color: roleColor(agent.role) });
      body.circle(0, -26, 7).fill({ color: 0xffe8cf }); // head
      body.alpha = agent.spriteState === 'idle' ? 0.92 : 1;
    }
    if (badge) {
      badge.clear();
      if (agent.spriteState === 'blocked') {
        badge.circle(10, -28, 5).fill({ color: 0xef4444 });
      } else if (agent.spriteState === 'talking') {
        badge.circle(11, -30, 4).fill({ color: 0x38bdf8 });
      }
    }
  }
```

- [ ] **Step 2: Typecheck**

Run: `cd Assuryal/F16/admin && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add admin/src/office/scene.ts
git commit -m "feat(admin): office sprite rendering + click selection"
```

---

### Task 2.4: Wire bridge → scene + side panel in the page

**Files:**

- Modify: `admin/src/pages/Office.tsx`

- [ ] **Step 1: Replace `Office.tsx` with the wired version**

```tsx
// admin/src/pages/Office.tsx
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { OfficeScene } from '@/office/scene';
import { OfficeBridge } from '@/office/state-bridge';
import { roleColor } from '@/office/assets';
import type { OfficeAgent, OfficeState } from '@/office/types';

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

export default function OfficePage(): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<OfficeState | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let disposed = false;
    const scene = new OfficeScene({ onSelect: (k) => setSelectedKey(k) });
    const bridge = new OfficeBridge();

    const unsub = bridge.subscribe((snap) => {
      setState(snap.state);
      scene.applySnapshot(snap.state);
      scene.applyEffects(snap.effects);
    });

    void scene.mount(host).then(() => {
      if (disposed) {
        scene.destroy();
        return;
      }
      scene.applySnapshot(bridge.getSnapshot());
      bridge.start();
    });

    const onResize = (): void => scene.handleResize(host);
    const onVisibility = (): void => (document.hidden ? scene.pause() : scene.resume());
    globalThis.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      globalThis.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      unsub();
      bridge.dispose();
      scene.destroy();
    };
  }, []);

  const selected: OfficeAgent | null =
    selectedKey && state ? (state.agents.get(selectedKey) ?? null) : null;

  return (
    <div className="relative h-[calc(100vh-57px)] w-full overflow-hidden bg-slate-900">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute top-4 left-4 rounded-md bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-200">
        Bureau F16 — {state ? state.agents.size : 0} agents
      </div>
      {selected && <AgentPanel agent={selected} onClose={() => setSelectedKey(null)} />}
    </div>
  );
}

function AgentPanel({ agent, onClose }: { agent: OfficeAgent; onClose: () => void }): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="absolute top-0 right-0 h-full w-80 overflow-y-auto border-l border-slate-700 bg-slate-800/95 p-5 text-slate-100 shadow-xl">
      <div className="flex items-center justify-between">
        <span
          className="rounded-full px-2 py-0.5 text-xs font-bold text-slate-900"
          style={{ backgroundColor: `#${roleColor(agent.role).toString(16).padStart(6, '0')}` }}
        >
          {agent.role}
        </span>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-100"
          aria-label="Fermer"
        >
          ✕
        </button>
      </div>
      <dl className="mt-4 space-y-2 text-sm">
        <Row
          label="Instance"
          value={<span className="font-mono text-xs">{agent.instanceId}</span>}
        />
        <Row label="État" value={agent.spriteState} />
        <Row label="Statut" value={agent.status} />
        <Row label="Modèle" value={agent.model} />
        <Row label="Queue" value={agent.queue} />
        <Row label="Priorité" value={agent.priority === null ? '—' : String(agent.priority)} />
        <Row label="Heartbeat" value={relativeTime(agent.lastHeartbeatAt)} />
        {agent.error && (
          <Row label="Erreur" value={<span className="text-rose-300">{agent.error}</span>} />
        )}
      </dl>
      <a href="/agents" className="mt-5 inline-block text-sm text-sky-400 hover:underline">
        Voir dans le registre Agents →
      </a>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }): ReactElement {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right text-slate-100">{value}</dd>
    </div>
  );
}
```

> `scene.applyEffects(...)` is referenced here but implemented in Phase 3. Add a **no-op stub** now so P2 typechecks: in `scene.ts` add `applyEffects(_effects: OfficeEffect[]): void { /* P3 */ }` (import `OfficeEffect` from `./types`). Phase 3 fills it in.

- [ ] **Step 2: Add the `applyEffects` stub to `scene.ts`**

In `scene.ts`, update the types import to include `OfficeEffect`, and add the stub method:

```ts
// in the existing: import type { OfficeAgent, OfficeState } from './types';
import type { OfficeAgent, OfficeEffect, OfficeState } from './types';
```

```ts
  applyEffects(_effects: OfficeEffect[]): void {
    /* Implemented in Phase 3 (motion). */
  }
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd Assuryal/F16/admin && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add admin/src/pages/Office.tsx admin/src/office/scene.ts
git commit -m "feat(admin): wire office bridge to scene + agent side panel"
```

---

### ✅ Phase 2 live-verify (on this PC)

- [ ] Infra + backend + admin dev running (as Phase 1).
- [ ] Open `/office`. Confirm: persistent agents (supervisor, maxance-operator, human-router, ads-manager, creative, voice, engagement, scorer) appear as colored sprites at the right zones; numbers match `/agents`.
- [ ] Trigger a real lead (whatever the normal intake is) → a `sales-agent` instance appears on the sales floor within ~5 s (poll).
- [ ] Click a sprite → side panel shows live status/model/queue/heartbeat; Esc closes; "Voir dans le registre Agents" links to `/agents`.
- [ ] `pnpm test` all green; `pnpm lint` + `pnpm typecheck` clean.
- [ ] Log `m14-t11-P2-DONE` to ruflo.

---

## PHASE 3 — Motion (in-place animation, pulse-lines, walking, marquee)

_Demo at end: agents bob/glow/talk/shake by state; messages draw a pulse-line to the target; ephemeral sales agents walk in/out; QUOTE→Maxance triggers the marquee walk._

### Task 3.1: Ticker-driven in-place animation

**Files:**

- Modify: `admin/src/office/scene.ts`

- [ ] **Step 1: Add an animation registry + ticker update**

Add a field:

```ts
  private animState = new Map<string, { spriteState: string; bobPhase: number }>();
```

In `makeSprite`, seed the anim state (vary phase by key hash so they don't bob in lockstep):

```ts
this.animState.set(agent.key, {
  spriteState: agent.spriteState,
  bobPhase: (agent.key.length % 10) * 0.6,
});
```

In `mount()`, after the scene is ready, register the ticker:

```ts
this.app.ticker.add((ticker) => this.tick(ticker.deltaMS));
```

Add the `tick` method:

```ts
  private tick(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (const [key, node] of this.sprites) {
      const a = this.animState.get(key);
      if (!a) continue;
      a.bobPhase += dt * (a.spriteState === 'working' ? 4 : 2);
      const body = node.getChildByLabel('body');
      if (body) {
        const amp = a.spriteState === 'idle' ? 1.2 : a.spriteState === 'working' ? 2.2 : 1.6;
        body.y = Math.sin(a.bobPhase) * amp;
        if (a.spriteState === 'blocked') body.x = Math.sin(a.bobPhase * 8) * 1.5;
        else body.x = 0;
      }
    }
    this.advanceWalks(dt);
    this.advancePulses(dt);
  }
```

In `styleSprite`, keep `animState` in sync:

```ts
const a = this.animState.get(agent.key);
if (a) a.spriteState = agent.spriteState;
```

> `advanceWalks` and `advancePulses` are added in Tasks 3.2/3.3. Add empty stubs now so it typechecks:
>
> ```ts
>   private advanceWalks(_dt: number): void { /* 3.2 */ }
>   private advancePulses(_dt: number): void { /* 3.3 */ }
> ```

- [ ] **Step 2: Typecheck + commit**

Run: `cd Assuryal/F16/admin && pnpm typecheck`
Expected: PASS.

```bash
git add admin/src/office/scene.ts
git commit -m "feat(admin): office in-place sprite animation loop"
```

---

### Task 3.2: Walking (ephemeral spawn/despawn + marquee)

**Files:**

- Modify: `admin/src/office/scene.ts`

- [ ] **Step 1: Implement walk tweens**

Add a walk registry field:

```ts
  private walks = new Map<string, { from: { x: number; y: number }; to: { x: number; y: number }; t: number; dur: number; then?: () => void }>();
```

Add imports for entrance:

```ts
// extend the layout import:
import { ZONES, isoToScreen, TILE_W, TILE_H, deskCoords, ENTRANCE, homeDeskFor } from './layout';
```

Replace the `advanceWalks` stub:

```ts
  private advanceWalks(dt: number): void {
    for (const [key, w] of this.walks) {
      w.t += dt;
      const k = Math.min(1, w.t / w.dur);
      const node = this.sprites.get(key);
      if (node) {
        node.position.set(w.from.x + (w.to.x - w.from.x) * k, (w.from.y + (w.to.y - w.from.y) * k) - 14);
      }
      if (k >= 1) {
        this.walks.delete(key);
        w.then?.();
      }
    }
  }

  /** Walk an existing sprite from the entrance to its desk (spawn). */
  private walkIn(key: string): void {
    const node = this.sprites.get(key);
    if (!node) return;
    const dest = this.deskFor(key);
    this.walks.set(key, { from: { ...ENTRANCE }, to: dest, t: 0, dur: 1.2 });
  }

  /** Find a sprite's destination desk coordinates from current state cache. */
  private deskFor(key: string): { x: number; y: number } {
    const cached = this.lastDeskByKey.get(key);
    return cached ? deskCoords(cached) : isoToScreen(6, 6);
  }

  /** Marquee: send a representative sales sprite to the Maxance booth and back. */
  marqueeToMaxance(): void {
    // Pick the most-recently-added sales sprite present.
    const salesKey = [...this.sprites.keys()].reverse().find((k) => k.startsWith('sales-agent#'));
    if (!salesKey) return;
    const node = this.sprites.get(salesKey);
    if (!node) return;
    const home = this.deskFor(salesKey);
    const booth = deskCoords(homeDeskFor('maxance-operator').deskId);
    this.walks.set(salesKey, {
      from: home, to: booth, t: 0, dur: 1.0,
      then: () => {
        this.walks.set(salesKey, { from: booth, to: home, t: 0, dur: 1.0 });
      },
    });
  }
```

Add a `lastDeskByKey` cache field and populate it in `applySnapshot`:

```ts
  private lastDeskByKey = new Map<string, string>();
```

In `applySnapshot`, inside the add/update loop, after `this.positionSprite(...)`:

```ts
const wasNew = !this.lastDeskByKey.has(agent.key);
this.lastDeskByKey.set(agent.key, agent.deskId);
if (wasNew && agent.role === 'sales-agent') this.walkIn(agent.key);
```

And in the removal loop, when deleting a sprite also `this.lastDeskByKey.delete(key); this.animState.delete(key); this.walks.delete(key);`.

- [ ] **Step 2: Typecheck + commit**

Run: `cd Assuryal/F16/admin && pnpm typecheck`
Expected: PASS.

```bash
git add admin/src/office/scene.ts
git commit -m "feat(admin): office walking (spawn walk-in + maxance marquee)"
```

---

### Task 3.3: Message pulse-lines + wire effects

**Files:**

- Modify: `admin/src/office/scene.ts`

- [ ] **Step 1: Implement pulses + fill in `applyEffects`**

Add a pulse registry + layer:

```ts
  private pulseLayer: Container = new Container();
  private pulses: { g: Graphics; from: { x: number; y: number }; to: { x: number; y: number }; t: number; dur: number }[] = [];
```

In `mount()`, add the pulse layer above sprites: `this.world.addChild(this.pulseLayer);` (after spriteLayer).

Replace the `advancePulses` stub:

```ts
  private advancePulses(dt: number): void {
    for (let i = this.pulses.length - 1; i >= 0; i -= 1) {
      const p = this.pulses[i];
      p.t += dt;
      const k = Math.min(1, p.t / p.dur);
      p.g.clear();
      const x = p.from.x + (p.to.x - p.from.x) * k;
      const y = p.from.y + (p.to.y - p.from.y) * k;
      p.g.circle(x, y - 14, 4).fill({ color: 0x7dd3fc, alpha: 1 - k });
      if (k >= 1) {
        p.g.destroy();
        this.pulses.splice(i, 1);
      }
    }
  }

  private deskCoordsForRole(role: string): { x: number; y: number } {
    // Find a present sprite of that role; else use the role's home desk.
    for (const [key, deskId] of this.lastDeskByKey) {
      if (key.startsWith(`${role}#`)) return deskCoords(deskId);
    }
    return deskCoords(homeDeskFor(role).deskId);
  }
```

Replace the `applyEffects` stub with the real implementation:

```ts
  applyEffects(effects: OfficeEffect[]): void {
    if (!this.ready) return;
    for (const e of effects) {
      if (e.kind === 'message') {
        const g = new Graphics();
        this.pulseLayer.addChild(g);
        const to = this.deskCoordsForRole(e.toRole);
        const from = ENTRANCE; // messages originate from the floor entrance toward the target
        this.pulses.push({ g, from, to, t: 0, dur: 0.9 });
      } else if (e.kind === 'marquee-quote') {
        this.marqueeToMaxance();
      } else if (e.kind === 'attention') {
        // pulse toward the reporter (human-router) desk as the human-action owner
        const g = new Graphics();
        this.pulseLayer.addChild(g);
        const to = this.deskCoordsForRole('human-router');
        this.pulses.push({ g, from: ENTRANCE, to, t: 0, dur: 0.9 });
      }
    }
  }
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd Assuryal/F16/admin && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add admin/src/office/scene.ts
git commit -m "feat(admin): office message pulse-lines + effect wiring"
```

---

### ✅ Phase 3 live-verify (on this PC)

- [ ] Open `/office` with backend live. Confirm: idle agents gently bob; an active agent shows the faster "working" bob/glow; a crashed agent (if any) shakes with a red badge.
- [ ] Cause an agent message (any inbound that routes between agents) → a pulse-line travels to the target, which flashes "talking".
- [ ] Trigger `QUOTE.REQUESTED` to the Maxance operator → a sales sprite walks to the Maxance booth and back.
- [ ] A new `sales-agent` instance walks in from the entrance; on stop it disappears.
- [ ] `pnpm test`/`lint`/`typecheck` clean. Log `m14-t11-P3-DONE`.

---

## PHASE 4 — Warm game art (Nano Banana Pro)

_Demo at end: the office looks like the warm B style — characterful sprites + wood floor + props, replacing placeholders, with no change to the state core._

### Task 4.1: Generate the art set

> Use the **`generate` (Nano Banana Pro)** skill. One shared style directive for coherence: _"warm, friendly isometric office game art, Habbo-Hotel / Stardew-Valley vibe, soft ambient lighting, ¾ top-down isometric angle, clean vector-ish shading, transparent background (PNG), single subject centered."_ Generate at ~256×256 for characters, ~128×64 for the floor tile. Save into `admin/public/office/`.

- [ ] **Step 1: Generate the 9 character sprites (idle pose minimum; add working/talking/walking where the skill makes it easy)**

For each role, generate `char-<role>-idle.png` (and ideally `-working`, `-talking`, `-walking`) into `admin/public/office/`. Roles + character cues:

- `sales-agent` — friendly young salesperson with a headset.
- `voice-operator` — agent with a phone headset, mid-call gesture.
- `maxance-operator` — technician at a terminal/computer booth.
- `supervisor` — manager in a slightly nicer outfit, clipboard.
- `human-router` (Reporter) — note-taker / messenger with papers.
- `engagement-agent` — cheerful person waving / with a chat bubble.
- `ads-manager-agent` — marketer with a megaphone.
- `creative-agent` — designer with a paint palette / tablet.
- `lead-scorer` — analyst with a magnifying glass / chart.

- [ ] **Step 2: Generate environment textures**

`floor-tile.png` (warm wood isometric diamond tile), `prop-desk.png`, `prop-plant.png`, `prop-maxance.png` (computer booth), `prop-door.png` (entrance).

- [ ] **Step 3: Commit the assets**

```bash
git add admin/public/office/
git commit -m "feat(admin): warm game art assets for the office"
```

---

### Task 4.2: Load + render textures (flip placeholder mode off)

**Files:**

- Modify: `admin/src/office/assets.ts`
- Modify: `admin/src/office/scene.ts`

- [ ] **Step 1: Flip the flag**

In `assets.ts`: `export const PLACEHOLDER_MODE = false;`

- [ ] **Step 2: Preload textures + render sprites/floor from textures**

In `scene.ts`, in `mount()` before `drawFloor()`, preload via Pixi Assets:

```ts
import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  Texture,
} from 'pixi.js';
import { ENV_TEXTURES, textureUrl } from './assets';
```

```ts
// Preload environment + character textures (best-effort; falls back to shapes).
const urls = [
  ...Object.values(ENV_TEXTURES),
  ...[
    'sales-agent',
    'voice-operator',
    'maxance-operator',
    'supervisor',
    'human-router',
    'engagement-agent',
    'ads-manager-agent',
    'creative-agent',
    'lead-scorer',
  ].flatMap((r) =>
    (['idle', 'working', 'talking', 'walking'] as const).map((s) => textureUrl(r, s)),
  ),
];
await Promise.all(urls.map((u) => Assets.load(u).catch(() => null)));
```

Update `makeSprite`/`styleSprite` so that when `!PLACEHOLDER_MODE` it uses a `Sprite` from the loaded texture (fallback to the placeholder Graphics if the texture is missing):

```ts
  private makeSprite(agent: OfficeAgent): Container {
    const node = new Container();
    node.eventMode = 'static';
    node.cursor = 'pointer';
    node.on('pointertap', (e) => { e.stopPropagation(); this.opts.onSelect?.(agent.key); });
    this.animState.set(agent.key, { spriteState: agent.spriteState, bobPhase: (agent.key.length % 10) * 0.6 });

    const tex = PLACEHOLDER_MODE ? null : Texture.from(textureUrl(agent.role, agent.spriteState));
    if (tex && tex.label !== Texture.EMPTY.label) {
      const spr = new Sprite(tex);
      spr.label = 'body';
      spr.anchor.set(0.5, 1);
      spr.scale.set(0.28);
      node.addChild(spr);
    } else {
      const body = new Graphics(); body.label = 'body'; node.addChild(body);
      const badge = new Graphics(); badge.label = 'badge'; node.addChild(badge);
    }
    return node;
  }
```

In `styleSprite`, when the body is a `Sprite`, swap its texture by state and skip the Graphics drawing:

```ts
const body = node.getChildByLabel('body');
if (body instanceof Sprite) {
  const t = Texture.from(textureUrl(agent.role, agent.spriteState));
  if (t.label !== Texture.EMPTY.label) body.texture = t;
  const a = this.animState.get(agent.key);
  if (a) a.spriteState = agent.spriteState;
  return;
}
// ...existing placeholder Graphics styling below...
```

In `drawZone`, when `!PLACEHOLDER_MODE` and the floor-tile texture exists, tile the zone with `Sprite`s of `ENV_TEXTURES.floorTile` instead of the diamond Graphics (keep the Graphics path as fallback).

- [ ] **Step 3: Typecheck + lint + build**

Run: `cd Assuryal/F16/admin && pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS. (PNG art lives in `public/` → copied to `dist/` root, not counted against the entry-chunk guard.)

- [ ] **Step 4: Commit**

```bash
git add admin/src/office/assets.ts admin/src/office/scene.ts
git commit -m "feat(admin): render warm art textures in the office scene"
```

---

### ✅ Phase 4 live-verify (on this PC)

- [ ] Open `/office`. Confirm: warm character sprites + wood floor render; states still animate; click still opens the panel; perf smooth.
- [ ] If any sprite is missing/off-style, regenerate just that asset (Task 4.1) and re-verify. Engine still works regardless (placeholder fallback).
- [ ] Log `m14-t11-P4-DONE`.

---

## PHASE 5 — Polish, perf, a11y, full verify

_Demo at end: production-ready office — paused when hidden, responsive, with an accessible fallback, verified end-to-end._

### Task 5.1: Loading state + empty state + a11y fallback

**Files:**

- Modify: `admin/src/pages/Office.tsx`

- [ ] **Step 1: Add a loading overlay (until first snapshot) + empty hint + a11y link**

In `Office.tsx`, render an overlay while `state === null`, and an a11y note linking to `/agents` (the screen-reader-friendly table is the accessible equivalent of the canvas):

```tsx
{
  !state && (
    <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">
      Connexion au bureau en direct…
    </div>
  );
}
<a href="/agents" className="sr-only">
  Vue accessible : registre des agents
</a>;
```

- [ ] **Step 2: Typecheck + lint + commit**

```bash
git add admin/src/pages/Office.tsx
git commit -m "feat(admin): office loading + empty + a11y fallback"
```

---

### Task 5.2: Home page link + full test/lint/build gate

**Files:**

- Modify: `admin/src/App.tsx`

- [ ] **Step 1: Add a Bureau bullet to the Home list** (mirror the existing `<li>` items), e.g.:

```tsx
<li>
  <Link className="text-sky-700 hover:underline" to="/office">
    Bureau
  </Link>{' '}
  — vue isométrique live de l’équipe d’agents.
</li>
```

- [ ] **Step 2: Full gate**

Run: `cd Assuryal/F16/admin && pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: ALL PASS. (`pnpm test` runs the office unit suites + the smoke bundle guard.)

- [ ] **Step 3: Commit**

```bash
git add admin/src/App.tsx
git commit -m "feat(admin): link office from admin home"
```

---

### ✅ Phase 5 — final live-verify (Ridaa's "done" bar)

- [ ] Infra + backend (:3001) + admin dev up on THIS PC.
- [ ] Walk the full story live: open `/office` → persistent agents at desks → trigger a real lead → sales agent walks in → drive a quote → marquee walk to Maxance booth → click sprites → panels correct → hide tab (CPU drops) → resize window (re-centers).
- [ ] Confirm against `/agents` that roster + statuses match reality.
- [ ] `pnpm build` clean; entry-chunk guard green.
- [ ] Update project memory: `project_milestone_status.md` (M14.T11 done → M14 fully complete), and ruflo `m14-t11-office-DONE-2026-06-XX` + mark M14 closed.
- [ ] Final commit if any doc updates: `docs: m14.t11 office complete + m14 closed`.

---

## Self-Review notes (author)

- **Spec coverage:** §2 layers → Tasks 2.1/2.2 (core), 1.4/2.3/3.x (scene), 1.5/2.4 (page). §3 zones/roster → 1.2 + reducer 2.1. §4 state model → types 1.1 + reducer 2.1. §5 data flow → bridge 2.2 + page 2.4. §6 motion → Phase 3. §7 art → Phase 4. §8 side panel → 2.4. §9 testing → 1.2/2.1/2.2 unit + live-verify gates. §10 phases → P1–P5. §11 risks → lazy-load (1.5/1.6), marquee approximation (3.2), attention→reporter (3.3), perf pause (1.5).
- **Placeholder scan:** the only deliberately-deferred symbols (`applyEffects`, `advanceWalks`, `advancePulses`) are introduced as explicit typechecking stubs in the task that references them and filled in the named later task — no silent TODOs.
- **Type consistency:** `OfficeBridge`, `OfficeScene`, `applySnapshot`, `applyEffects`, `reconcileAgents`, `reduceEvent`, `settleTalking`, `emptyState`, `assignSalesDesk`, `homeDeskFor`, `deskCoords` names are consistent across tasks and match `types.ts`.
- **Commit scopes:** all use enum-valid scopes (`admin`, `docs`, `chore(admin)`); no `admin/office`.

```

```
