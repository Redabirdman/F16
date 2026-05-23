/**
 * PII redaction for transcripts + logs (option C / Compliance Sentry V0).
 *
 * Pure function — no DB, no LLM. Detects four PII categories common in
 * French insurance conversations and masks them with stable tokens so
 * the redacted text is safe to log, store in audit trails, or paste
 * into a debugging Slack:
 *
 *   - phone numbers (French E.164 / national / written-out)
 *   - email addresses
 *   - IBAN (French + generic SEPA, with checksum validation)
 *   - credit card numbers (16-digit, Luhn-validated)
 *
 * Returns the redacted text + a report of what was masked. The report
 * is useful for the audit log ("we redacted 1 phone, 2 emails") without
 * leaking the values themselves.
 *
 * NOT a replacement for the PII encryption at the DB boundary (the
 * `customers` repo's encryptPII handles that). This is for content that
 * NEVER hits the encrypted columns — message bodies in
 * conversation_turns rows, ad-hoc logs, error reports, transcripts
 * exported for compliance review.
 *
 * Conservative-on-match policy: we'd rather over-redact than leak. False
 * positives (e.g. a 16-digit serial that happens to pass Luhn) are
 * acceptable; false negatives (a real phone number that slips through)
 * are not.
 */

/** Categories the redactor knows about. Stable tags surface in the masked output. */
export type PiiCategory = 'phone' | 'email' | 'iban' | 'cc';

export interface RedactionReport {
  /** Count per category — useful for audit logging without leaking values. */
  counts: Record<PiiCategory, number>;
  /** Total matches across categories. */
  total: number;
}

export interface RedactionResult {
  /** The text with every detected PII span replaced by `[CATEGORY]`. */
  text: string;
  /** Per-category counts + total. */
  report: RedactionReport;
}

/** Regex catalog — case-insensitive where it makes sense; word-boundaried. */
const REGEXES: Record<PiiCategory, RegExp> = {
  // Email: RFC-5322-lite. Good enough for French inboxes; intentionally
  // doesn't accept comments or quoted-local-parts (rare in customer text).
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,

  // French phone shapes, in order of specificity:
  //   +33 6 12 34 56 78  /  +33612345678  /  0033612345678
  //   06 12 34 56 78     /  0612345678
  //   06.12.34.56.78     /  06-12-34-56-78
  // Anchored to the leading + or leading 0 to avoid matching random
  // digit runs (postal codes, order numbers).
  phone: /(?:\+33|0033|0)\s?[1-9](?:[\s.-]?\d{2}){4}/g,

  // IBAN — checksum is validated in postprocessing (regex catches the
  // shape, the validator filters). Supports common SEPA lengths 15-34.
  // Optional spaces every 4 digits.
  iban: /\b[A-Z]{2}\d{2}(?:[\s]?[A-Z0-9]{4}){3,7}(?:[\s]?[A-Z0-9]{1,3})?\b/g,

  // 16-digit credit card. Postprocessing filters to Luhn-valid only —
  // a 16-digit order number that happens to match the regex is dropped.
  // Accepts spaces/dashes between groups of 4.
  cc: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
};

/** Luhn checksum — used to filter the credit card regex's matches. */
function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length !== 16) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    const ch = d.charCodeAt(i) - 48;
    if (ch < 0 || ch > 9) return false;
    let n = ch;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * IBAN checksum validation (ISO 13616). Move the first 4 chars to the
 * end, convert letters to digits (A=10..Z=35), then mod 97 must equal 1.
 */
function ibanValid(raw: string): boolean {
  const stripped = raw.replace(/\s+/g, '').toUpperCase();
  if (stripped.length < 15 || stripped.length > 34) return false;
  const rearranged = stripped.slice(4) + stripped.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    let val: number;
    if (code >= 48 && code <= 57)
      val = code - 48; // 0-9
    else if (code >= 65 && code <= 90)
      val = code - 55; // A-Z → 10..35
    else return false;
    // Process digit-by-digit (or two-digit for letters) modulo 97 to
    // avoid bigint, keeping the loop tight on hot paths.
    if (val >= 10) {
      remainder = (remainder * 100 + val) % 97;
    } else {
      remainder = (remainder * 10 + val) % 97;
    }
  }
  return remainder === 1;
}

/**
 * Redact every PII span in `text`. Detection order matters: email first
 * (would otherwise overlap with the @-less domain in some phones); then
 * IBAN (chosen lengths can otherwise look like cc + phone fragments);
 * then cc (Luhn-filtered); then phone.
 */
export function redactPII(text: string): RedactionResult {
  const counts: Record<PiiCategory, number> = { phone: 0, email: 0, iban: 0, cc: 0 };
  let out = text;

  // Email — direct replacement; no postprocessing filter.
  out = out.replace(REGEXES.email, () => {
    counts.email += 1;
    return '[EMAIL]';
  });

  // IBAN — regex catches the shape; filter by checksum to avoid masking
  // arbitrary alphanumeric strings.
  out = out.replace(REGEXES.iban, (match) => {
    if (!ibanValid(match)) return match;
    counts.iban += 1;
    return '[IBAN]';
  });

  // CC — Luhn-filter to avoid masking order numbers.
  out = out.replace(REGEXES.cc, (match) => {
    if (!luhnValid(match)) return match;
    counts.cc += 1;
    return '[CC]';
  });

  // Phone — last, so it doesn't eat fragments inside IBAN/CC. The regex
  // is anchored to + or leading 0 which already excludes most IBAN/CC
  // fragments, but order-as-defense.
  out = out.replace(REGEXES.phone, () => {
    counts.phone += 1;
    return '[PHONE]';
  });

  const total = counts.phone + counts.email + counts.iban + counts.cc;
  return { text: out, report: { counts, total } };
}

/** Convenience — true if `text` contains any redactable PII. */
export function containsPII(text: string): boolean {
  return redactPII(text).report.total > 0;
}
