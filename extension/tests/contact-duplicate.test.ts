/**
 * Repeat-customer "Ce contact existe déjà" — detection + branching unit
 * tests (M8.T7 B4 / P3b).
 *
 * Pure logic only: `isContactDuplicateAlert` (text match) and
 * `decideContactRecovery` (skip-commit vs retry vs fail vs proceed given a
 * simulated DOM/state). The DOM-touching main-world probes
 * (probeContactDuplicate / dismissDuplicateAlert / refillAndRetryOk) are
 * exercised live with a real repeat customer — see P6 watchouts.
 *
 * The wire check pins that the distinct error code is documented + that an
 * error response carrying it round-trips through ResponseSchema (the code is
 * a free string, not an enum, so this guards the doc-comment + the contract).
 */
import { describe, it, expect } from 'vitest';
import {
  CONTACT_DUPLICATE_ERROR,
  decideContactRecovery,
  isContactDuplicateAlert,
} from '../src/flows/contact-duplicate.js';
import { ResponseSchema } from '../src/wire.js';

describe('isContactDuplicateAlert', () => {
  it('matches the canonical Maxance alerte text', () => {
    expect(isContactDuplicateAlert('Ce contact existe déjà')).toBe(true);
    expect(isContactDuplicateAlert('Ce contact existe déjà pour ce client.')).toBe(true);
  });

  it('tolerates unaccented / reframed variants', () => {
    expect(isContactDuplicateAlert('Le contact existe deja')).toBe(true);
    expect(isContactDuplicateAlert('Attention : contact   existe   déjà')).toBe(true);
    expect(isContactDuplicateAlert('CONTACT EXISTE DÉJÀ')).toBe(true);
  });

  it('does NOT match unrelated alerte text or empty input', () => {
    expect(isContactDuplicateAlert('La valeur du champ Nom est obligatoire.')).toBe(false);
    expect(isContactDuplicateAlert('Un problème technique est survenu.')).toBe(false);
    expect(isContactDuplicateAlert('')).toBe(false);
    expect(isContactDuplicateAlert(null)).toBe(false);
    expect(isContactDuplicateAlert(undefined)).toBe(false);
  });
});

describe('decideContactRecovery', () => {
  it('proceeds when there is no duplicate alert', () => {
    expect(
      decideContactRecovery({
        duplicateAlert: false,
        existingContactPopulated: false,
        alreadyRetried: false,
      }),
    ).toBe('proceed');
    // Even a populated contact + no alert means nothing to recover from.
    expect(
      decideContactRecovery({
        duplicateAlert: false,
        existingContactPopulated: true,
        alreadyRetried: false,
      }),
    ).toBe('proceed');
  });

  it('skips the commit + retries when the existing contact is already populated', () => {
    expect(
      decideContactRecovery({
        duplicateAlert: true,
        existingContactPopulated: true,
        alreadyRetried: false,
      }),
    ).toBe('skip_commit_retry');
  });

  it('retries when the alert fired but the contact is not yet populated', () => {
    expect(
      decideContactRecovery({
        duplicateAlert: true,
        existingContactPopulated: false,
        alreadyRetried: false,
      }),
    ).toBe('retry');
  });

  it('fails with the distinct code once the single retry is exhausted', () => {
    // After one retry, any persisting duplicate alert gives up — regardless
    // of whether the contact row is populated.
    expect(
      decideContactRecovery({
        duplicateAlert: true,
        existingContactPopulated: true,
        alreadyRetried: true,
      }),
    ).toBe('fail');
    expect(
      decideContactRecovery({
        duplicateAlert: true,
        existingContactPopulated: false,
        alreadyRetried: true,
      }),
    ).toBe('fail');
  });
});

describe('wire: maxance_devis_contact_duplicate error code', () => {
  it('exposes the stable distinct error-code constant', () => {
    expect(CONTACT_DUPLICATE_ERROR).toBe('maxance_devis_contact_duplicate');
  });

  it('round-trips an error response carrying the distinct code', () => {
    const parsed = ResponseSchema.parse({
      id: '00000000-0000-0000-0000-000000000000',
      kind: 'error',
      errorCode: CONTACT_DUPLICATE_ERROR,
      detail: 'contact existe déjà — recovery exhausted',
    });
    expect(parsed.kind).toBe('error');
    if (parsed.kind === 'error') {
      expect(parsed.errorCode).toBe('maxance_devis_contact_duplicate');
    }
  });
});
