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
