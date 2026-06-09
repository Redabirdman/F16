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

  it('maps running + non-null error to blocked', () => {
    const s = reconcileAgents(
      emptyState(),
      [row({ role: 'supervisor', instanceId: 'i1', status: 'running', error: 'OOM' })],
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
    expect(effects.some((e: { kind: string }) => e.kind === 'marquee-quote')).toBe(true);
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
    expect(effects.some((e: { kind: string }) => e.kind === 'marquee-quote')).toBe(false);
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
