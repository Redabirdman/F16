/**
 * Repeat-customer "Ce contact existe déjà" handling (M8.T7 B4 / P3b).
 *
 * When the devis subscriber form is filled for a customer Maxance already
 * knows (same phone/email), committing the contact widget draft via the
 * "Nouveau" button — OR clicking the devis OK — raises a Maxance alerte
 * popin (built by the page-global `ConstructAlertInfo`) whose text contains
 * "Ce contact existe déjà". Today that silently breaks quote.confirm.
 *
 * This module holds the PURE detection + branching logic so it can be unit
 * tested in isolation, away from the DOM/Chrome machinery. The main-world
 * DOM dispatch (dismiss popin, skip the Nouveau-commit, re-fill, retry OK)
 * lives in background.ts's devis.fill-and-submit-mw handler, which delegates
 * the decision to `decideContactRecovery` below.
 *
 * Distinct error code (spec §4.4): when recovery still fails after the single
 * retry, the handler returns `maxance_devis_contact_duplicate` (NOT the
 * generic fill error) so the backend can reason about it (route to a human
 * or reuse-existing-contact strategy after live diagnosis).
 */

/** The error code surfaced to the backend when recovery is exhausted. */
export const CONTACT_DUPLICATE_ERROR = 'maxance_devis_contact_duplicate';

/**
 * True when an alerte popin text is the repeat-customer duplicate-contact
 * message. Tolerates accented/unaccented "déjà"/"deja" and the leading
 * "Ce contact"/"Le contact"/"Contact" framing Maxance uses.
 */
export function isContactDuplicateAlert(text: string | null | undefined): boolean {
  if (!text) return false;
  return /contact\s+existe\s+d[ée]j[àa]/i.test(text);
}

/**
 * State the recovery decision is taken from. Mirrors what the main-world
 * probe can observe without touching the DOM in this pure module:
 *   - `duplicateAlert`  — a duplicate-contact popin is currently showing.
 *   - `existingContactPopulated` — the offending widget's `contactList[0]`
 *     is ALREADY populated (the genuine existing-contact case: Maxance has
 *     the contact, so the Nouveau-commit is redundant and must be skipped).
 *   - `alreadyRetried`  — the OK submit has already been retried once.
 */
export interface ContactRecoveryState {
  duplicateAlert: boolean;
  existingContactPopulated: boolean;
  alreadyRetried: boolean;
}

/**
 * What the handler should do next:
 *   - `proceed`            — no duplicate alert; carry on with the normal flow.
 *   - `skip_commit_retry`  — duplicate alert + existing contact already
 *     populated: dismiss the popin, SKIP the Nouveau-commit, re-fill the
 *     subscriber-level fields the zone-refresh wiped, retry OK once.
 *   - `retry`              — duplicate alert but the contact is NOT yet
 *     populated (edge case): dismiss + re-fill + retry OK once anyway.
 *   - `fail`               — duplicate persists after the single retry:
 *     surface `maxance_devis_contact_duplicate` and let self-healing reset.
 */
export type ContactRecoveryDecision = 'proceed' | 'skip_commit_retry' | 'retry' | 'fail';

/**
 * Decide skip-commit vs retry vs fail from the observed state. Pure: no DOM,
 * no side effects — the handler maps the decision onto main-world dispatch.
 */
export function decideContactRecovery(state: ContactRecoveryState): ContactRecoveryDecision {
  if (!state.duplicateAlert) return 'proceed';
  // A duplicate alert already survived one retry → give up with the distinct
  // code rather than looping forever.
  if (state.alreadyRetried) return 'fail';
  return state.existingContactPopulated ? 'skip_commit_retry' : 'retry';
}
