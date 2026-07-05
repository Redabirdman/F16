/**
 * Maxance business window (2026-07-05). Portal is closed nights 20:00-08:00
 * Africa/Casablanca and all weekend. Dates below are UTC instants chosen so
 * the Casablanca wall clock (UTC+1) lands where the label says.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isMaxanceOpen,
  msUntilMaxanceOpen,
  describeMaxanceReopening,
} from '../../../src/agents/maxance-operator/business-hours.js';

const HOUR = 3_600_000;

describe('maxance business hours', () => {
  const KEYS = [
    'MAXANCE_HOURS_OPEN',
    'MAXANCE_HOURS_CLOSE',
    'MAXANCE_HOURS_TZ',
    'MAXANCE_HOURS_247',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      Reflect.deleteProperty(process.env, k);
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });

  it('weekday inside the window is open', () => {
    expect(isMaxanceOpen(new Date('2026-07-08T12:00:00Z'))).toBe(true); // Wed 13:00 Casa
    expect(msUntilMaxanceOpen(new Date('2026-07-08T12:00:00Z'))).toBe(0);
  });

  it('weeknight is closed until next morning', () => {
    const tueNight = new Date('2026-07-07T20:30:00Z'); // Tue 21:30 Casa
    expect(isMaxanceOpen(tueNight)).toBe(false);
    const ms = msUntilMaxanceOpen(tueNight);
    expect(ms).toBeGreaterThan(10 * HOUR);
    expect(ms).toBeLessThan(11 * HOUR);
    expect(describeMaxanceReopening(tueNight)).toContain('demain matin');
  });

  it('early weekday morning reopens the same day', () => {
    const monEarly = new Date('2026-07-06T06:30:00Z'); // Mon 07:30 Casa
    expect(isMaxanceOpen(monEarly)).toBe(false);
    expect(msUntilMaxanceOpen(monEarly)).toBeLessThanOrEqual(HOUR);
    expect(describeMaxanceReopening(monEarly)).toContain('ce matin');
  });

  it('weekend is closed through to Monday', () => {
    const friNight = new Date('2026-07-10T19:30:00Z'); // Fri 20:30 Casa
    expect(isMaxanceOpen(friNight)).toBe(false);
    const ms = msUntilMaxanceOpen(friNight);
    expect(ms).toBeGreaterThan(58 * HOUR);
    expect(ms).toBeLessThan(61 * HOUR);
    expect(describeMaxanceReopening(friNight)).toContain('lundi matin');

    const satNoon = new Date('2026-07-11T11:00:00Z'); // Sat 12:00 Casa
    expect(isMaxanceOpen(satNoon)).toBe(false);
    expect(describeMaxanceReopening(satNoon)).toContain('lundi matin');
  });

  it('closing edge: 19:59 open, 20:01 closed (Casa)', () => {
    expect(isMaxanceOpen(new Date('2026-07-08T18:59:00Z'))).toBe(true); // Wed 19:59 Casa
    expect(isMaxanceOpen(new Date('2026-07-08T19:01:00Z'))).toBe(false); // Wed 20:01 Casa
  });

  it('MAXANCE_HOURS_247=1 disables the gate', () => {
    process.env.MAXANCE_HOURS_247 = '1';
    expect(isMaxanceOpen(new Date('2026-07-11T11:00:00Z'))).toBe(true); // Saturday
    expect(msUntilMaxanceOpen(new Date('2026-07-11T11:00:00Z'))).toBe(0);
  });
});
