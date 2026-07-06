/**
 * Maxance maintenance-page detection (2026-07-06, Ridaa's self-heal mission).
 *
 * The Proximéo platform is shut down outside business hours (nights
 * 20:00-08:00 Moroccan + weekends) and serves a "maintenance / site
 * momentanément indisponible" page instead of the portal. Two failure
 * modes this module addresses:
 *   1. A quote launched while Maxance shows the maintenance page must be
 *      PARKED by the backend, not failed to the customer → the content
 *      script reports the tagged error `maxance_maintenance` and the
 *      maxance-operator re-parks the job (bounded, see agent.ts).
 *   2. A tab left on the maintenance page overnight is STALE the next
 *      morning → background.ts reloads the tab once and retries the
 *      command before surfacing the error.
 *
 * Detection is CONSERVATIVE: the maintenance text alone is not enough
 * (a news blurb or garanties wording could mention "maintenance") — the
 * page must ALSO lack every normal login / dashboard / Proximéo marker.
 *
 * `classifyMaintenance` is pure (unit-testable in plain Node, no jsdom);
 * `isMaintenancePage` is the thin DOM probe used by the content script.
 */

/** Tagged error code consumed by background.ts (reload-once) + the backend
 *  maxance-operator (park instead of QUOTE.FAILED). */
export const MAINTENANCE_ERROR_CODE = 'maxance_maintenance';

/** Maintenance wording observed on portal-closed pages. Case-insensitive. */
export const MAINTENANCE_TEXT_RE =
  /maintenance|momentanément indisponible|site indisponible|en cours de maintenance/i;

/** Structural probe — built from the live DOM by `isMaintenancePage`, or
 *  by hand in unit tests (the extension test harness has no jsdom). */
export interface MaintenanceProbe {
  /** Full body text (innerText preferred, textContent fallback). */
  bodyText: string;
  /** A password input exists → this is the real login page, NOT maintenance. */
  hasLoginForm: boolean;
  /** Any Proximéo/dashboard chrome marker exists (menu strip, portefeuille
   *  search, wizard fields, "Accès Proximéo" link text) → normal portal page. */
  hasPortalMarkers: boolean;
}

/** Pure classifier: maintenance text present AND no normal-page marker. */
export function classifyMaintenance(probe: MaintenanceProbe): boolean {
  if (!MAINTENANCE_TEXT_RE.test(probe.bodyText)) return false;
  if (probe.hasLoginForm) return false;
  if (probe.hasPortalMarkers) return false;
  return true;
}

/**
 * DOM probe for the content script. Markers, all live-verified elsewhere in
 * the flows:
 *   - `input[type=password]` → public login form (login.ts case 3).
 *   - `#TRF` / `#MOTO` → the Proximéo top-menu strip present on EVERY
 *     Proximéo page (quote-preview.ts navigation notes).
 *   - `RechercheGeneriqueForm` → ACCES PORTEFEUILLE search (selectors.ts).
 *   - `vehiculeMarque` / `currentConducteur.flagAucunPermis` → wizard tabs.
 *   - "Accès Proximéo" body text → extranet dashboard (login.ts case 2).
 */
export function isMaintenancePage(doc: Document = document): boolean {
  const body = doc.body;
  const bodyText = (body ? body.innerText || body.textContent : '') ?? '';
  const hasPortalMarkers =
    doc.getElementById('TRF') !== null ||
    doc.getElementById('MOTO') !== null ||
    doc.querySelector('form[name="RechercheGeneriqueForm"]') !== null ||
    doc.querySelector('select[name="vehiculeMarque"]') !== null ||
    doc.querySelector('input[name="currentConducteur.flagAucunPermis"]') !== null ||
    /acc[èe]s proxim[ée]o/i.test(bodyText);
  return classifyMaintenance({
    bodyText,
    hasLoginForm: doc.querySelector('input[type="password"]') !== null,
    hasPortalMarkers,
  });
}
