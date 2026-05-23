/**
 * Unit tests for the pure parts of dom.ts.
 *
 * The DOM-touching helpers (waitForVisible, setSelectByLabel, etc.) need
 * jsdom to exercise — out of scope for this scaffold. The PURE helpers
 * (parseEurPrice, sleep) can be tested in plain Node.
 *
 * Phase 2c will add jsdom + a fuller test pass for the DOM helpers,
 * driven by HTML fixtures extracted from real Maxance pages.
 */
import { describe, it, expect } from 'vitest';
import { parseEurPrice, sleep } from '../src/dom.js';

describe('parseEurPrice', () => {
  it('parses comma-decimal Maxance prices', () => {
    expect(parseEurPrice('18,95 €')).toBe(18.95);
    expect(parseEurPrice('Mensuel : 18,95 €')).toBe(18.95);
  });

  it('parses dot-decimal alternative', () => {
    expect(parseEurPrice('18.95 €')).toBe(18.95);
  });

  it('parses prices with thousand separators', () => {
    expect(parseEurPrice('1 234,56 €')).toBe(1234.56);
    expect(parseEurPrice('12 345,67 EUR')).toBe(12345.67);
  });

  it('returns null on no-match', () => {
    expect(parseEurPrice('')).toBeNull();
    expect(parseEurPrice('not a price')).toBeNull();
    expect(parseEurPrice(null)).toBeNull();
    expect(parseEurPrice(undefined)).toBeNull();
  });

  it('parses real-world Maxance Garanties-tab string formats', () => {
    expect(parseEurPrice('Annuel : 90,85 €')).toBe(90.85);
    expect(parseEurPrice('Total mensuel\n18,95 €')).toBe(18.95);
  });
});

describe('sleep', () => {
  it('resolves after roughly the requested duration', async () => {
    const t0 = Date.now();
    await sleep(20);
    const dt = Date.now() - t0;
    // Allow generous slack — test runners can stall under load.
    expect(dt).toBeGreaterThanOrEqual(15);
    expect(dt).toBeLessThan(500);
  });
});
