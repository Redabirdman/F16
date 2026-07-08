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
  // 0 = never active (default for new agents) — show as idle not working.
  if (lastActiveAt > 0 && now - lastActiveAt < WORKING_WINDOW_MS) return 'working';
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
    const lastIntent = prevAgent?.lastIntent ?? null;

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
      lastIntent,
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
        agents.set(key, {
          ...a,
          spriteState: 'talking',
          lastActiveAt: now,
          lastIntent: evt.intent,
        });
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
