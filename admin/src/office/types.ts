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
  /** Last bus intent addressed to this agent's role — drives the panel's
   *  "tâche en cours" line (redesign 2026-07-08). */
  lastIntent: string | null;
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
