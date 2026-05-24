/**
 * Quiet-hours helper (M11) — pure unit tests, no I/O.
 *
 * Every assertion picks a UTC instant whose corresponding Europe/Paris
 * local time + weekday is unambiguous (i.e. far enough from DST hour
 * changes that the offset is locked).
 */
import { describe, expect, it } from 'vitest';
import { isQuietNow, parisParts } from '../../../src/agents/engagement-agent/quiet-hours.js';

describe('parisParts — Europe/Paris extraction', () => {
  it('maps a winter UTC instant to Paris (UTC+1)', () => {
    // 2026-01-12T10:00:00Z is Monday 11:00 in Paris (CET, UTC+1).
    const p = parisParts(new Date('2026-01-12T10:00:00Z'));
    expect(p.isoWeekday).toBe(1); // Monday
    expect(p.hour).toBe(11);
  });

  it('maps a summer UTC instant to Paris (UTC+2)', () => {
    // 2026-07-15T10:00:00Z is Wednesday 12:00 in Paris (CEST, UTC+2).
    const p = parisParts(new Date('2026-07-15T10:00:00Z'));
    expect(p.isoWeekday).toBe(3);
    expect(p.hour).toBe(12);
  });

  it('returns weekday 6 for Saturday', () => {
    // 2026-05-23T12:00:00Z = Saturday 14:00 Paris.
    expect(parisParts(new Date('2026-05-23T12:00:00Z')).isoWeekday).toBe(6);
  });

  it('returns weekday 7 for Sunday', () => {
    // 2026-05-24T12:00:00Z = Sunday 14:00 Paris.
    expect(parisParts(new Date('2026-05-24T12:00:00Z')).isoWeekday).toBe(7);
  });
});

describe('isQuietNow — weekend gates', () => {
  it('is quiet at any hour on Saturday Paris time', () => {
    // 2026-05-23T12:00:00Z = Saturday 14:00 Paris (broad daylight, weekend).
    expect(isQuietNow(new Date('2026-05-23T12:00:00Z'))).toBe(true);
  });

  it('is quiet at any hour on Sunday Paris time', () => {
    // 2026-05-24T10:00:00Z = Sunday 12:00 Paris.
    expect(isQuietNow(new Date('2026-05-24T10:00:00Z'))).toBe(true);
  });
});

describe('isQuietNow — weekday quiet window', () => {
  it('is quiet at 22:00 Paris on a Tuesday', () => {
    // 2026-05-19T20:00:00Z = Tuesday 22:00 Paris (CEST UTC+2).
    expect(isQuietNow(new Date('2026-05-19T20:00:00Z'))).toBe(true);
  });

  it('is quiet at 07:30 Paris on a Wednesday', () => {
    // 2026-05-20T05:30:00Z = Wednesday 07:30 Paris.
    expect(isQuietNow(new Date('2026-05-20T05:30:00Z'))).toBe(true);
  });

  it('is NOT quiet at 09:00 Paris on a Wednesday', () => {
    // 2026-05-20T07:00:00Z = Wednesday 09:00 Paris.
    expect(isQuietNow(new Date('2026-05-20T07:00:00Z'))).toBe(false);
  });

  it('is NOT quiet at 20:59 Paris on a Friday (just before the gate)', () => {
    // 2026-05-22T18:59:00Z = Friday 20:59 Paris.
    expect(isQuietNow(new Date('2026-05-22T18:59:00Z'))).toBe(false);
  });

  it('is quiet at exactly 21:00 Paris on a Friday', () => {
    // 2026-05-22T19:00:00Z = Friday 21:00 Paris (gate start, inclusive).
    expect(isQuietNow(new Date('2026-05-22T19:00:00Z'))).toBe(true);
  });

  it('is NOT quiet at exactly 08:00 Paris on a Monday (gate end, exclusive)', () => {
    // 2026-05-25T06:00:00Z = Monday 08:00 Paris.
    expect(isQuietNow(new Date('2026-05-25T06:00:00Z'))).toBe(false);
  });
});
