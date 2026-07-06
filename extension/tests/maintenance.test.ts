/**
 * Unit tests for the maintenance-page classifier (2026-07-06 self-heal).
 *
 * The harness is plain Node (no jsdom, no chrome.* mocks — see
 * vitest.config.ts), so we exercise the PURE `classifyMaintenance` core.
 * The thin `isMaintenancePage` DOM probe and the background.ts create-tab /
 * reload-retry plumbing are covered by live runs (same posture as every
 * other SW-side behavior in this extension).
 */
import { describe, expect, it } from 'vitest';
import {
  MAINTENANCE_ERROR_CODE,
  MAINTENANCE_TEXT_RE,
  classifyMaintenance,
} from '../src/flows/maintenance.js';

const probe = (
  bodyText: string,
  overrides: Partial<{ hasLoginForm: boolean; hasPortalMarkers: boolean }> = {},
) => ({
  bodyText,
  hasLoginForm: false,
  hasPortalMarkers: false,
  ...overrides,
});

describe('classifyMaintenance', () => {
  it('detects the closed-portal wordings', () => {
    expect(classifyMaintenance(probe('Site en cours de maintenance'))).toBe(true);
    expect(classifyMaintenance(probe('Le site est momentanément indisponible'))).toBe(true);
    expect(classifyMaintenance(probe('SITE INDISPONIBLE — revenez plus tard'))).toBe(true);
    expect(classifyMaintenance(probe('Maintenance planifiée du portail'))).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(classifyMaintenance(probe('EN COURS DE MAINTENANCE'))).toBe(true);
    expect(MAINTENANCE_TEXT_RE.test('MOMENTANÉMENT INDISPONIBLE')).toBe(true);
  });

  it('does not fire without maintenance wording', () => {
    expect(classifyMaintenance(probe('Bienvenue sur Proximéo — Tarif - Nouveau Client'))).toBe(
      false,
    );
    expect(classifyMaintenance(probe(''))).toBe(false);
  });

  it('is conservative: a login page mentioning maintenance is NOT maintenance', () => {
    expect(
      classifyMaintenance(probe('Connexion — maintenance prévue dimanche', { hasLoginForm: true })),
    ).toBe(false);
  });

  it('is conservative: a portal page mentioning maintenance is NOT maintenance', () => {
    // e.g. a news blurb or garanties wording containing the word on a page
    // that still renders the Proximéo menu / wizard / dashboard chrome.
    expect(
      classifyMaintenance(
        probe('Actualité : maintenance du réseau prévue', { hasPortalMarkers: true }),
      ),
    ).toBe(false);
  });

  it('exports the tagged error code the SW + backend key on', () => {
    expect(MAINTENANCE_ERROR_CODE).toBe('maxance_maintenance');
  });
});
