/**
 * Subscription main-world handlers — SW-side (M8.T7 B3).
 *
 * Self-contained synchronous main-world `executeScript` steps that drive the
 * Maxance souscription closing pages, following the exact pattern proven by
 * garanties-mw.ts / reprise-mw.ts: each func is fully self-contained
 * (chrome.scripting serializes funcs via toString(), so anything not defined
 * INSIDE the func is undefined in the page — bundle-scope helpers and imports
 * are unreachable there). The SW owns the sleeps between steps.
 *
 *   1. `handleSubscriptionInfosComplMw` — fill `mouvement.numeroSerieVehicule`
 *      ("1234567" placeholder) on the Infos complémentaires page. The Suivant
 *      that follows reuses the existing `click.main-world` handler.
 *   2. `handleSubscriptionBancairesMw` — the Coordonnées + bancaires page:
 *        a) type the birth-place commune + click its row search link → INSEE
 *           lookup AJAX,
 *        b) (SW waits) select `souscripteurNaissanceZonier.key` by INSEE prefix,
 *        c) split the IBAN across `#ibanPart0..6`, set BIC + Titulaire, verify
 *           the jour de prélèvement default, check "Je dispose du comptant",
 *           read the "Comptant à régler" block + `ErrorMessage()`.
 *   3. `handleSubscriptionValiderFinaleMw` — the destructive final submit:
 *      set `window.confirm = () => true`, call
 *      `doSubmitConfirm('SouscriptionContratVehiculeForm', validerFinaleDo,
 *      window.labelAN)`, then click any ConstructConfirmInfo CONFIRMATION
 *      popin's 'Valider'. NEVER `doSubmitForm` directly (→ "Erreur applicative").
 *
 * PII discipline: IBAN/BIC arrive ONLY as MAIN-world func args and are NEVER
 * echoed into the returned `log` (which carries set/missing booleans only).
 */
import {
  BIC_INPUT_NAME,
  COMPTANT_CHECKBOX_NAME,
  IBAN_PART_COUNT,
  IBAN_PART_ID_PREFIX,
  IBAN_PART_LENGTHS,
  JOUR_PRELEVEMENT_DEFAULT,
  JOUR_PRELEVEMENT_INPUT_NAME,
  NAISSANCE_COMMUNE_INPUT_NAME,
  NAISSANCE_KEY_SELECT_NAME,
  SERIE_INPUT_NAME,
  SOUSCRIPTION_FORM_NAME,
  TITULAIRE_INPUT_ID,
} from './maxance/selectors.js';
import type {
  SubscriptionBancairesRequest,
  SubscriptionBancairesResponse,
  SubscriptionInfosComplResponse,
  SubscriptionValiderFinaleResponse,
} from './content-protocol.js';

/** AJAX-settle budget for the commune INSEE lookup (~4s live; widen for cold). */
const COMMUNE_LOOKUP_TIMEOUT_MS = 12_000;
const COMMUNE_POLL_MS = 400;
const COMMUNE_INITIAL_SLEEP_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Infos complémentaires: set the N° de série (placeholder). Native value
 * setter + input/change/blur so the Maxance framework caches the value.
 */
export async function handleSubscriptionInfosComplMw(
  tabId: number,
  serialNumber: string,
): Promise<SubscriptionInfosComplResponse> {
  const log: string[] = [];
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (serieName: string, serie: string): { status: string; log: string[] } => {
        const out: string[] = [];
        const fire = (el: Element, t: string): void => {
          el.dispatchEvent(new Event(t, { bubbles: true }));
        };
        const input = document.querySelector(
          `input[name="${serieName}"]`,
        ) as HTMLInputElement | null;
        if (!input) return { status: 'err:serie_input_not_found', log: out };
        input.focus();
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(input, serie);
        fire(input, 'input');
        fire(input, 'change');
        fire(input, 'blur');
        out.push('serie=set');
        return { status: 'ok', log: out };
      },
      args: [SERIE_INPUT_NAME, serialNumber],
    });
    const r = (res[0]?.result as { status: string; log: string[] } | undefined) ?? {
      status: 'err:null_result',
      log: [],
    };
    log.push(...r.log);
    if (r.status.startsWith('err:')) {
      return { kind: 'subscription.infos.err', log, error: r.status.slice(4) };
    }
    return { kind: 'subscription.infos.ok', log };
  } catch (err) {
    return {
      kind: 'subscription.infos.err',
      log,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 240),
    };
  }
}

/** Read whether the commune-key select has any option (lookup populated). */
async function communeKeyOptionCount(tabId: number): Promise<number> {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (selectName: string): number => {
      const sel = document.querySelector(
        `select[name="${selectName}"]`,
      ) as HTMLSelectElement | null;
      if (!sel) return -1;
      // Count non-empty option values (the placeholder option has value "").
      return Array.from(sel.options).filter((o) => o.value && o.value.trim() !== '').length;
    },
    args: [NAISSANCE_KEY_SELECT_NAME],
  });
  return (res[0]?.result as number | undefined) ?? -1;
}

/**
 * Coordonnées + bancaires page. Multi-step with SW-owned waits.
 */
export async function handleSubscriptionBancairesMw(
  tabId: number,
  payload: SubscriptionBancairesRequest['payload'],
): Promise<SubscriptionBancairesResponse> {
  const log: string[] = [];
  try {
    // (a) Type the commune + click its row search link (img search.gif) to
    //     fire the INSEE lookup AJAX. A plain blur does NOT trigger it.
    const ra = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (communeName: string, city: string): { status: string; log: string[] } => {
        const out: string[] = [];
        const fire = (el: Element, t: string): void => {
          el.dispatchEvent(new Event(t, { bubbles: true }));
        };
        const input = document.querySelector(
          `input[name="${communeName}"]`,
        ) as HTMLInputElement | null;
        if (!input) return { status: 'err:commune_input_not_found', log: out };
        input.focus();
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(input, city);
        fire(input, 'input');
        fire(input, 'change');
        out.push('commune=typed');
        // Find the row's search link: an <a> containing the search.gif img,
        // within the same row (<tr>) as the commune input.
        const row = input.closest('tr') ?? input.parentElement ?? document.body;
        let link: HTMLElement | null = null;
        const anchors = Array.from(row.querySelectorAll('a'));
        for (const a of anchors) {
          if (a.querySelector('img[src*="search"], img[src*="loupe"], img[alt*="echerch"]')) {
            link = a as HTMLElement;
            break;
          }
        }
        // Fallback: any img whose src includes "search.gif" nearby.
        if (!link) {
          const img = row.querySelector(
            'img[src*="search.gif"], img[src*="search"], img[alt*="echerch"]',
          ) as HTMLElement | null;
          link = (img?.closest('a') as HTMLElement | null) ?? img;
        }
        if (!link) return { status: 'err:commune_search_link_not_found', log: out };
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
        out.push('commune_search=clicked');
        return { status: 'ok', log: out };
      },
      args: [NAISSANCE_COMMUNE_INPUT_NAME, payload.birthPlaceCity],
    });
    const a = (ra[0]?.result as { status: string; log: string[] } | undefined) ?? {
      status: 'err:null_result',
      log: [],
    };
    log.push(...a.log);
    if (a.status.startsWith('err:')) {
      return { kind: 'subscription.bancaires.err', log, error: a.status.slice(4) };
    }

    // (b) Wait for the lookup AJAX to populate the key select, then select the
    //     option whose value starts with the matching INSEE.
    await sleep(COMMUNE_INITIAL_SLEEP_MS);
    const deadline = Date.now() + COMMUNE_LOOKUP_TIMEOUT_MS;
    let populated = false;
    while (Date.now() < deadline) {
      const count = await communeKeyOptionCount(tabId);
      if (count > 0) {
        populated = true;
        break;
      }
      await sleep(COMMUNE_POLL_MS);
    }
    if (!populated) {
      return { kind: 'subscription.bancaires.err', log, error: 'commune_lookup_no_options' };
    }
    const rb = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (selectName: string): { status: string; picked?: string } => {
        const sel = document.querySelector(
          `select[name="${selectName}"]`,
        ) as HTMLSelectElement | null;
        if (!sel) return { status: 'err:commune_key_select_not_found' };
        const opts = Array.from(sel.options).filter((o) => o.value && o.value.trim() !== '');
        if (opts.length === 0) return { status: 'err:commune_key_no_options' };
        // Prefer the first non-empty option (the lookup returns the matching
        // commune first). The INSEE prefix (e.g. "75001|") is the value head.
        const picked = opts[0];
        if (!picked) return { status: 'err:commune_key_no_options' };
        sel.value = picked.value;
        if (sel.value !== picked.value) return { status: 'err:commune_key_set_failed' };
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        // Return only the INSEE prefix (before the first '|') — non-PII.
        const prefix = picked.value.split('|')[0] ?? picked.value;
        return { status: 'ok', picked: prefix };
      },
      args: [NAISSANCE_KEY_SELECT_NAME],
    });
    const b = (rb[0]?.result as { status: string; picked?: string } | undefined) ?? {
      status: 'err:null_result',
    };
    if (b.status.startsWith('err:')) {
      return { kind: 'subscription.bancaires.err', log, error: b.status.slice(4) };
    }
    log.push(`commune_key=set:${b.picked ?? '?'}`);

    // (c) IBAN split + BIC + Titulaire + jour prélèvement verify + checkbox,
    //     then read the comptant block + ErrorMessage(). IBAN/BIC are passed
    //     as args ONLY — the returned log carries booleans, never the values.
    const rc = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (
        ibanPartPrefix: string,
        ibanPartCount: number,
        partLengthsJson: string,
        bicName: string,
        titulaireId: string,
        checkboxName: string,
        jourName: string,
        jourDefault: string,
        iban: string,
        bic: string,
        accountHolder: string,
      ): { status: string; log: string[]; comptantText: string; errorMessage: string } => {
        const out: string[] = [];
        const fire = (el: Element, t: string): void => {
          el.dispatchEvent(new Event(t, { bubbles: true }));
        };
        const setNative = (el: HTMLInputElement, val: string): void => {
          el.focus();
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (desc && desc.set) desc.set.call(el, val);
          fire(el, 'input');
          fire(el, 'change');
          fire(el, 'keyup');
        };
        // IBAN: strip spaces, split across the 7 segmented inputs by length.
        const clean = iban.replace(/\s+/g, '').toUpperCase();
        const lengths = JSON.parse(partLengthsJson) as number[];
        let cursor = 0;
        let allParts = true;
        for (let i = 0; i < ibanPartCount; i += 1) {
          const len = lengths[i] ?? 4;
          const seg = clean.slice(cursor, cursor + len);
          cursor += len;
          const part = document.getElementById(`${ibanPartPrefix}${i}`) as HTMLInputElement | null;
          if (!part) {
            allParts = false;
            continue;
          }
          setNative(part, seg);
        }
        out.push('iban_parts=' + (allParts ? 'all_set' : 'some_missing'));
        // BIC.
        const bicEl = document.querySelector(`input[name="${bicName}"]`) as HTMLInputElement | null;
        if (bicEl) {
          setNative(bicEl, bic);
          out.push('bic=set');
        } else {
          out.push('bic=missing');
        }
        // Titulaire.
        const titEl = document.getElementById(titulaireId) as HTMLInputElement | null;
        if (titEl) {
          setNative(titEl, accountHolder);
          out.push('titulaire=set');
        } else {
          out.push('titulaire=missing');
        }
        // Jour de prélèvement — verify default; only set if empty.
        const jourEl = document.querySelector(
          `input[name="${jourName}"]`,
        ) as HTMLInputElement | null;
        if (jourEl) {
          if (!jourEl.value || jourEl.value.trim() === '') {
            setNative(jourEl, jourDefault);
            out.push('jour=defaulted');
          } else {
            out.push('jour=' + jourEl.value);
          }
        } else {
          out.push('jour=missing');
        }
        // "Je dispose du comptant" checkbox → check it.
        const cb = document.querySelector(
          `input[name="${checkboxName}"]`,
        ) as HTMLInputElement | null;
        if (cb) {
          if (!cb.checked) {
            cb.checked = true;
            fire(cb, 'click');
            fire(cb, 'change');
          }
          out.push('comptant_checkbox=checked');
        } else {
          out.push('comptant_checkbox=missing');
        }
        // Read the body for the "Comptant à régler" block (the flow parses it).
        const comptantText = document.body ? document.body.innerText : '';
        // ErrorMessage() — non-empty means required-field failures.
        const w = window as unknown as { ErrorMessage?: () => string };
        let em = '';
        if (typeof w.ErrorMessage === 'function') {
          const raw = w.ErrorMessage() ?? '';
          em = raw
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        }
        out.push('errorMessage=' + (em ? 'NONEMPTY' : 'empty'));
        return { status: 'ok', log: out, comptantText, errorMessage: em };
      },
      args: [
        IBAN_PART_ID_PREFIX,
        IBAN_PART_COUNT,
        JSON.stringify(IBAN_PART_LENGTHS),
        BIC_INPUT_NAME,
        TITULAIRE_INPUT_ID,
        COMPTANT_CHECKBOX_NAME,
        JOUR_PRELEVEMENT_INPUT_NAME,
        JOUR_PRELEVEMENT_DEFAULT,
        payload.iban,
        payload.bic,
        payload.accountHolder,
      ],
    });
    const c = (rc[0]?.result as
      | { status: string; log: string[]; comptantText: string; errorMessage: string }
      | undefined) ?? { status: 'err:null_result', log: [], comptantText: '', errorMessage: '' };
    log.push(...c.log);
    if (c.status.startsWith('err:')) {
      return { kind: 'subscription.bancaires.err', log, error: c.status.slice(4) };
    }
    return {
      kind: 'subscription.bancaires.ok',
      log,
      comptantText: c.comptantText,
      errorMessage: c.errorMessage,
    };
  } catch (err) {
    return {
      kind: 'subscription.bancaires.err',
      log,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 240),
    };
  }
}

/**
 * The destructive final Valider. Sets `window.confirm = () => true`, calls
 * `doSubmitConfirm(formName, validerFinaleDo, window.labelAN)`, then clicks
 * any CONFIRMATION popin's 'Valider'. Never calls `doSubmitForm` directly.
 */
export async function handleSubscriptionValiderFinaleMw(
  tabId: number,
  validerFinaleDo: string,
): Promise<SubscriptionValiderFinaleResponse> {
  const log: string[] = [];
  try {
    const r1 = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (formName: string, action: string): { status: string } => {
        const w = window as unknown as {
          confirm?: (m?: string) => boolean;
          labelAN?: string;
          doSubmitConfirm?: (f: string, a: string, l?: string) => void;
        };
        if (typeof w.doSubmitConfirm !== 'function') {
          return { status: 'err:doSubmitConfirm_unavailable' };
        }
        // Native-confirm fallback: if doSubmitConfirm falls back to window.confirm
        // (rather than the custom popin) auto-accept it.
        try {
          w.confirm = () => true;
        } catch {
          /* some pages freeze window.confirm — ignore, the popin path covers it */
        }
        try {
          w.doSubmitConfirm(formName, action, w.labelAN);
          return { status: 'submitted' };
        } catch (e) {
          return { status: 'err:' + (e instanceof Error ? e.message : String(e)).slice(0, 120) };
        }
      },
      args: [SOUSCRIPTION_FORM_NAME, validerFinaleDo],
    });
    const s = (r1[0]?.result as { status: string } | undefined)?.status ?? 'err:null_result';
    log.push(`doSubmitConfirm=${s}`);
    if (s.startsWith('err:')) {
      return { kind: 'subscription.valider.err', log, error: s.slice(4) };
    }

    // Give the ConstructConfirmInfo popin a beat to render, then click its
    // 'Valider' (exact text, NOT 'Valider devis'/'Valider souscription'; the
    // popin title is 'CONFIRMATION').
    await sleep(1_200);
    const r2 = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (): { clicked: boolean; seen: string[] } => {
        const norm = (t: string | null): string => (t ?? '').replace(/\s+/g, ' ').trim();
        const cands = Array.from(
          document.querySelectorAll<HTMLElement>(
            'a, button, input[type=submit], input[type=button], .buttonMiddle, [onclick]',
          ),
        );
        const seen = cands
          .map((el) => norm(el.textContent || (el as HTMLInputElement).value))
          .filter((t) => t && t.length < 24)
          .slice(0, 16);
        const valider = cands.find(
          (el) => norm(el.textContent || (el as HTMLInputElement).value) === 'Valider',
        );
        if (!valider) return { clicked: false, seen };
        const target = (valider.querySelector('.buttonMiddle') as HTMLElement | null) ?? valider;
        const rect = target.getBoundingClientRect();
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
          target.dispatchEvent(new MouseEvent(k, init));
        }
        return { clicked: true, seen };
      },
    });
    const hit = (r2[0]?.result as { clicked: boolean; seen: string[] } | undefined) ?? {
      clicked: false,
      seen: [],
    };
    log.push(`popin_valider=${hit.clicked ? 'clicked' : 'not_found'}`);
    return { kind: 'subscription.valider.ok', log, popinClicked: hit.clicked };
  } catch (err) {
    return {
      kind: 'subscription.valider.err',
      log,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 240),
    };
  }
}
