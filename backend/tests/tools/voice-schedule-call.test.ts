/**
 * voice.schedule_call — customer-provided number normalization (2026-07-08,
 * live: the customer gave a different number and the call went to the
 * profile phone instead). Pure tests on the exported normalizer.
 */
import { describe, expect, it } from 'vitest';
import { normalizeDialNumber } from '../../src/tools/builtins/voice-schedule-call.js';

describe('normalizeDialNumber', () => {
  it('normalizes French mobile formats to E.164', () => {
    expect(normalizeDialNumber('+33 7 57 81 87 87')).toBe('+33757818787');
    expect(normalizeDialNumber('07 57 81 87 87')).toBe('+33757818787');
    expect(normalizeDialNumber('0757818787')).toBe('+33757818787');
    expect(normalizeDialNumber('07.57.81.87.87')).toBe('+33757818787');
    expect(normalizeDialNumber('0033757818787')).toBe('+33757818787');
  });

  it('keeps international E.164 as-is', () => {
    expect(normalizeDialNumber('+212650012403')).toBe('+212650012403');
  });

  it('rejects garbage', () => {
    expect(normalizeDialNumber('call me maybe')).toBeNull();
    expect(normalizeDialNumber('123')).toBeNull();
    expect(normalizeDialNumber('07578187')).toBeNull(); // too short for FR
  });
});
