/**
 * Surface tests for the three flow modules.
 *
 * DOM-touching tests need jsdom which isn't in the scaffold yet — phase
 * 2c will add it alongside HTML fixtures pulled from the real Maxance
 * pages. For now we just assert the three flows export a `runX` function
 * with the expected (cmd) => Promise<Response> signature.
 *
 * These tests also exercise the cross-workspace imports (selectors,
 * dom/iframe helpers, wire schemas) — a module-load failure here would
 * surface as a static import error before any DOM logic runs.
 */
import { describe, it, expect } from 'vitest';
import { runLoginEnsure } from '../src/flows/login.js';
import { runQuotePreview } from '../src/flows/quote-preview.js';
import { runQuoteConfirm } from '../src/flows/quote-confirm.js';

describe('flow module surface', () => {
  it('exports runLoginEnsure as a function', () => {
    expect(typeof runLoginEnsure).toBe('function');
    expect(runLoginEnsure.length).toBe(1); // takes (cmd)
  });

  it('exports runQuotePreview as a function', () => {
    expect(typeof runQuotePreview).toBe('function');
    expect(runQuotePreview.length).toBe(1);
  });

  it('exports runQuoteConfirm as a function', () => {
    expect(typeof runQuoteConfirm).toBe('function');
    expect(runQuoteConfirm.length).toBe(1);
  });
});
