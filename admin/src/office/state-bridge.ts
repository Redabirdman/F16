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
    this.fetchAgents = opts.fetchAgents ?? ((): Promise<ListAgentsResponse> => listAgents());
    this.ESCtor = opts.EventSourceCtor ?? (globalThis.EventSource as typeof EventSource);
    this.pollMs = opts.pollMs ?? 5000;
    this.now = opts.now ?? ((): number => Date.now());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return (): void => {
      this.listeners.delete(fn);
    };
  }

  getSnapshot(): OfficeState {
    return this.state;
  }

  start(): void {
    void this.poll();
    this.pollTimer = setInterval((): void => {
      void this.poll();
    }, this.pollMs);
    // Settle expired talking flashes between polls.
    this.settleTimer = setInterval((): void => {
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
          toRole: String(d['toRole']),
          intent: String(d['intent']),
          correlationId: (d['correlationId'] as string | null) ?? null,
        };
      }
      return {
        type,
        op: d['op'] === 'UPDATE' ? 'UPDATE' : 'INSERT',
        status: String(d['status'] ?? ''),
        severity: Number(d['severity'] ?? 0),
        correlationId: (d['correlationId'] as string | null) ?? null,
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
