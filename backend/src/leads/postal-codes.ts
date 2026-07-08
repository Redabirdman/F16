/**
 * French postal-code validation (2026-07-08 — Ridaa: "verify the zip code
 * against a list of the whole of France, then proceed with quoting").
 *
 * Live incident: CP 75091 (nonexistent) drove the Maxance wizard into its
 * 'Ville obligatoire' loop for 4 minutes and 7 management pings before the
 * failure classifiers landed. With this module the invalid code never
 * reaches Maxance at all — the quote.request tool rejects it and the LLM
 * asks the customer to double-check.
 *
 * Data: src/data/french-postal-codes.json — { [cp]: communes[] }, built
 * from La Poste's official « base officielle des codes postaux » (ODbL)
 * by scripts/build-postal-code-index.ts. 6 328 codes, ~575 KB, loaded once
 * on first use (~10 ms).
 */
import { readFileSync } from 'node:fs';
import { logger } from '../logger.js';

let _index: Record<string, string[]> | null | undefined;

function loadIndex(): Record<string, string[]> | null {
  if (_index !== undefined) return _index;
  try {
    const url = new URL('../data/french-postal-codes.json', import.meta.url);
    _index = JSON.parse(readFileSync(url, 'utf8')) as Record<string, string[]>;
  } catch (err) {
    // Missing/corrupt asset must NEVER block quoting — fall back to
    // "unknown", i.e. validation passes (Maxance stays the final arbiter).
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'postal-codes: index load failed — validation disabled for this process',
    );
    _index = null;
  }
  return _index;
}

/**
 * Three-state check: 'valid' / 'invalid' / 'unknown' (index unavailable).
 * Callers should only hard-fail on 'invalid'.
 */
export function checkFrenchPostalCode(cp: string): 'valid' | 'invalid' | 'unknown' {
  if (!/^\d{5}$/.test(cp)) return 'invalid';
  const index = loadIndex();
  if (!index) return 'unknown';
  return cp in index ? 'valid' : 'invalid';
}

/** Commune names for a postal code (uppercase), [] when unknown/invalid. */
export function communesForPostalCode(cp: string): string[] {
  const index = loadIndex();
  return index?.[cp] ?? [];
}
