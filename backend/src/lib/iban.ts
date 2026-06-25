/**
 * IBAN helpers — pure functions, no I/O, no logging (M8.T7 closing).
 *
 * Used by the sales agent's subscription.request tool ("verify the IBAN
 * before filling" — Achraf), the customers repository (normalize before
 * encrypt) and anywhere an IBAN must appear in logs (ALWAYS via maskIban).
 *
 * Validation = ISO 13616 mod-97 checksum + structure + per-country length
 * for the countries we plausibly see (FR focus; the registry below is not
 * exhaustive — unknown country codes fall back to the generic 15–34 bound,
 * the checksum still applies).
 */

/** Official IBAN lengths for countries we expect to encounter. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24,
  AT: 20,
  BE: 16,
  CH: 21,
  DE: 22,
  DZ: 26,
  ES: 24,
  FR: 27,
  GB: 22,
  IE: 22,
  IT: 27,
  LU: 20,
  MA: 28,
  MC: 27,
  NL: 18,
  PT: 25,
  TN: 24,
};

const MIN_IBAN_LENGTH = 15; // Norway, the shortest registered IBAN
const MAX_IBAN_LENGTH = 34; // ISO 13616 ceiling

/** Strip all whitespace and uppercase. Does NOT validate. */
export function normalizeIban(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

/**
 * ISO 13616 validation: structure (CC + 2 check digits + alphanumeric BBAN),
 * length (per-country when known, 15–34 otherwise) and the mod-97 checksum.
 * Accepts spaced/lowercase input — normalizes first.
 */
export function validateIban(input: string): boolean {
  if (typeof input !== 'string') return false;
  const iban = normalizeIban(input);

  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return false;
  if (iban.length < MIN_IBAN_LENGTH || iban.length > MAX_IBAN_LENGTH) return false;

  const expectedLength = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expectedLength !== undefined && iban.length !== expectedLength) return false;

  // mod-97: move the first 4 chars to the end, map A→10 … Z→35, then compute
  // the remainder digit-by-digit (the number exceeds 2^53, so no Number()).
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const mapped = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of mapped) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * Log-safe display form: country + check digits, masked middle, last 4.
 * "FR7630006000011234567890189" → "FR76 •••• 0189". The ONLY form an IBAN
 * may take in logs, progress events or error messages.
 */
export function maskIban(input: string): string {
  const iban = normalizeIban(input);
  if (iban.length < 8) return '••••';
  return `${iban.slice(0, 4)} •••• ${iban.slice(-4)}`;
}
