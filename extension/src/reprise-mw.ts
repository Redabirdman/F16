/**
 * Reprise main-world handlers — SW-side (M8.T7 B2).
 *
 * Two self-contained synchronous main-world executeScript steps that drive
 * the Maxance framework widgets the resume flow needs, following the exact
 * pattern proven by garanties-mw.ts / devis.fill-and-submit-mw: each func is
 * fully self-contained (chrome.scripting serializes funcs via toString(), so
 * anything not defined INSIDE the func is undefined in the page — bundle-scope
 * helpers and imports are unreachable there).
 *
 *   1. `handleRepriseSearchMw` — fill the ACCES PORTEFEUILLE search bar
 *      (`critereSelected`=NO + `#valeurCritere`=devisNumber) and click the
 *      search anchor (`#mainSearchLink`, href `javascript:doSubmit(...)`) so
 *      the inline handler navigates to the "Visualisation du devis" page.
 *   2. `handleRepriseSubmitMw` — call `doSubmit('repriseDevisMoto.do')`
 *      (page-global) to start the reprise → resumed VÉHICULE tab.
 *
 * The two Suivant clicks (`#validerVehicule`, `#validerConducteur`) reuse the
 * existing `click.main-world` handler (button-container `.buttonMiddle`
 * mouse-event dispatch) — no new handler needed here.
 *
 * No PII handled here — devisNumber is a non-PII reference. The funcs return
 * status logs only.
 */
import {
  CRITERE_SELECT_NAME,
  CRITERE_VALUE_DEVIS,
  MAIN_SEARCH_LINK_ID,
  VALEUR_CRITERE_ID,
} from './maxance/selectors.js';
import type { RepriseSearchResponse, RepriseSubmitResponse } from './content-protocol.js';

/**
 * Fill the search criterion + value and click the search link in MAIN world.
 * The criterion select carries `critereSelected`; the value input is
 * `#valeurCritere`; the anchor `#mainSearchLink` has an inline
 * `javascript:doSubmit(...)` href whose click navigates the top frame.
 */
export async function handleRepriseSearchMw(
  tabId: number,
  devisNumber: string,
): Promise<RepriseSearchResponse> {
  const log: string[] = [];
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (
        critereName: string,
        critereValue: string,
        valeurId: string,
        linkId: string,
        devis: string,
      ): { status: string; log: string[] } => {
        const out: string[] = [];
        const fire = (el: Element, t: string): void => {
          el.dispatchEvent(new Event(t, { bubbles: true }));
        };
        // Criterion select → 'NO' (numéro de devis). Best-effort: the bar may
        // already default to it; we set it explicitly when present.
        const sel = document.querySelector(
          `select[name="${critereName}"]`,
        ) as HTMLSelectElement | null;
        if (sel) {
          sel.value = critereValue;
          fire(sel, 'input');
          fire(sel, 'change');
          out.push(`critere=${sel.value === critereValue ? 'set' : 'mismatch'}`);
        } else {
          out.push('critere=absent');
        }
        // Value input → devis number.
        const input = document.getElementById(valeurId) as HTMLInputElement | null;
        if (!input) return { status: 'err:valeur_input_not_found', log: out };
        input.focus();
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(input, devis);
        fire(input, 'input');
        fire(input, 'change');
        out.push('valeur=set');
        // Search anchor → click (inline href is javascript:doSubmit(...)).
        const link = document.getElementById(linkId) as HTMLElement | null;
        if (!link) return { status: 'err:search_link_not_found', log: out };
        const rect = link.getBoundingClientRect();
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 1,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        } as const;
        for (const k of ['mousedown', 'mouseup', 'click'] as const) {
          link.dispatchEvent(new MouseEvent(k, init));
        }
        out.push('search=clicked');
        return { status: 'ok', log: out };
      },
      args: [
        CRITERE_SELECT_NAME,
        CRITERE_VALUE_DEVIS,
        VALEUR_CRITERE_ID,
        MAIN_SEARCH_LINK_ID,
        devisNumber,
      ],
    });
    const r = (res[0]?.result as { status: string; log: string[] } | undefined) ?? {
      status: 'err:null_result',
      log: [],
    };
    log.push(...r.log);
    if (r.status.startsWith('err:')) {
      return { kind: 'reprise.search.err', log, error: r.status.slice(4) };
    }
    return { kind: 'reprise.search.ok', log };
  } catch (err) {
    return {
      kind: 'reprise.search.err',
      log,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 240),
    };
  }
}

/**
 * Call `doSubmit('repriseDevisMoto.do')` in MAIN world. The devis is already
 * in the Maxance session after the search landed on the Visualisation page,
 * so no params are needed. Navigates the top frame to the resumed VÉHICULE
 * tab.
 */
export async function handleRepriseSubmitMw(
  tabId: number,
  repriseDo: string,
): Promise<RepriseSubmitResponse> {
  const log: string[] = [];
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (action: string): { status: string } => {
        const w = window as unknown as { doSubmit?: (a: string) => void };
        if (typeof w.doSubmit !== 'function') {
          return { status: 'err:doSubmit_unavailable' };
        }
        try {
          w.doSubmit(action);
          return { status: 'submitted' };
        } catch (e) {
          return { status: 'err:' + (e instanceof Error ? e.message : String(e)).slice(0, 120) };
        }
      },
      args: [repriseDo],
    });
    const status = (res[0]?.result as { status: string } | undefined)?.status ?? 'err:null_result';
    log.push(`reprise=${status}`);
    if (status.startsWith('err:')) {
      return { kind: 'reprise.submit.err', log, error: status.slice(4) };
    }
    return { kind: 'reprise.submit.ok', log };
  } catch (err) {
    return {
      kind: 'reprise.submit.err',
      log,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 240),
    };
  }
}
