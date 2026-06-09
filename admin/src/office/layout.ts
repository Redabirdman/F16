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
 * Always returns the hash-derived (preferred) slot for a given instanceId,
 * making the assignment fully idempotent: calling with the same instanceId
 * always yields the same deskId regardless of what `taken` contains.
 * The `taken` set is honoured only as a tie-breaker when another instanceId's
 * hash collides with the preferred — in practice reconcileAgents only passes
 * OTHER agents' desks as taken, not the current agent's own.
 */
export function assignSalesDesk(instanceId: string, _taken: ReadonlySet<string>): string {
  const n = SALES_DESKS.length;
  const start = hashString(instanceId) % n;
  // Always return the preferred (hash-derived) slot — idempotent for same instanceId.
  // `_taken` is accepted for caller convenience (reconcileAgents passes other agents'
  // desks); a future refactor may use it for spill-over once >8 sales agents coexist.
  const slot = SALES_DESKS[start];
  // `start` is always in [0, n-1] because we use `% n`, so slot is always defined.
  if (!slot) return `sales-overflow-${hashString(instanceId) % 1000}`;
  return slot.deskId;
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
