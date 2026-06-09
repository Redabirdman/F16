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
    bridge.subscribe((s: BridgeSnapshot) => seen.push(s));
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
    bridge.subscribe((s: BridgeSnapshot) => seen.push(s));
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
    expect(last.effects.some((e: { kind: string }) => e.kind === 'marquee-quote')).toBe(true);
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
