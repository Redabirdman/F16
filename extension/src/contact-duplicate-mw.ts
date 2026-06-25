/**
 * Repeat-customer "Ce contact existe déjà" — main-world DOM helpers
 * (M8.T7 B4 / P3b).
 *
 * SW-side `chrome.scripting{world:'MAIN'}` probes used by the
 * devis.fill-and-submit-mw handler (background.ts) to detect + recover from
 * the duplicate-contact alerte popin Maxance raises for known customers.
 *
 * Each exported func is a thin executeScript wrapper around ONE self-
 * contained main-world function (no bundle-scope helpers — chrome.scripting
 * serializes funcs via toString(), so anything captured from module scope is
 * `undefined` in the page; keepNames stays false so no `__name` wrapper leaks
 * in either — see reference_chrome_scripting_keepnames_gotcha.md).
 *
 * The pure detection/branching decision lives in flows/contact-duplicate.ts;
 * this module only OBSERVES the page (popin text, contactList[0] populated)
 * and MUTATES it (dismiss the popin, re-fill wiped subscriber fields). No PII
 * is logged — only field-name booleans and a duplicate flag.
 */
import { isContactDuplicateAlert } from './flows/contact-duplicate.js';

/** What a duplicate probe observes for one contact widget. */
export interface DuplicateProbe {
  /** A duplicate-contact alerte popin is currently visible. */
  duplicateAlert: boolean;
  /** The widget's `contactList[0]` row is already populated. */
  existingContactPopulated: boolean;
  /** Truncated, PII-free marker of what matched (for the log). */
  marker: string;
}

/**
 * Probe the page for a duplicate-contact alerte popin AND whether the named
 * contact widget already has a committed `contactList[0]` row.
 *
 * Maxance's alerte is a DOM popin built by `ConstructAlertInfo` — not a
 * native alert — so it is queryable. We scan visible popin-like containers
 * for the duplicate text. The committed-contact check looks for a rendered
 * `contactList[0]` field for the widget bean (the committed row uses the
 * bean's `contactList[0].*` names once the Nouveau-commit succeeded).
 *
 * `beanName` is e.g. 'telephoneListBean' or 'emailListBean'.
 */
export async function probeContactDuplicate(
  tabId: number,
  beanName: string,
): Promise<DuplicateProbe> {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (
      bean: string,
    ): { duplicateAlert: boolean; existingContactPopulated: boolean; alertText: string } => {
      // Collect candidate popin texts. Maxance's ConstructAlertInfo renders
      // into a controlled DOM node; we cast a wide net over visible dialog-
      // ish containers + the whole body as a fallback (the message is short).
      const isVisible = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const candidates: string[] = [];
      const sel = [
        '#alertDiv',
        '.alertInfo',
        '.alerte',
        '.popin',
        '.popup',
        '[id*="alert" i]',
        '[class*="alert" i]',
        '[role="dialog"]',
      ].join(',');
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (isVisible(el)) candidates.push((el as HTMLElement).innerText || '');
      }
      // Fallback: the alerte text frequently lands in the body innerText too.
      const bodyText = document.body ? document.body.innerText : '';
      const re = /contact\s+existe\s+d[ée]j[àa]/i;
      let alertText = '';
      for (const c of candidates) {
        if (re.test(c)) {
          alertText = c;
          break;
        }
      }
      if (!alertText && re.test(bodyText)) alertText = 'body-match';
      // Committed contact row present? The bean exposes its committed entry
      // as contactList[0].* once the Nouveau-commit landed. Phone uses
      // telephoneNumero, email uses adresseMail — check both generic markers.
      const committed =
        document.querySelector(`[name="${bean}.contactList[0].telephoneNumero"]`) != null ||
        document.querySelector(`[name="${bean}.contactList[0].adresseMail"]`) != null ||
        document.querySelector(`[name^="${bean}.contactList[0]."]`) != null;
      return {
        duplicateAlert: alertText !== '',
        existingContactPopulated: committed,
        alertText: alertText.slice(0, 80),
      };
    },
    args: [beanName],
  });
  const r = (res[0]?.result as
    | { duplicateAlert: boolean; existingContactPopulated: boolean; alertText: string }
    | undefined) ?? { duplicateAlert: false, existingContactPopulated: false, alertText: '' };
  // Re-confirm via the shared pure predicate (defensive; keeps one source of
  // truth for the match). alertText is already PII-free (a fixed message).
  const duplicateAlert = r.duplicateAlert || isContactDuplicateAlert(r.alertText);
  return {
    duplicateAlert,
    existingContactPopulated: r.existingContactPopulated,
    marker: duplicateAlert ? r.alertText || 'match' : 'none',
  };
}

/**
 * Dismiss the visible duplicate-contact alerte popin (click its OK/close
 * control, or hide its container as a fallback). Best-effort; returns a
 * short status string for the log.
 */
export async function dismissDuplicateAlert(tabId: number): Promise<string> {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (): { status: string } => {
      const isVisible = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const containerSel = [
        '#alertDiv',
        '.alertInfo',
        '.alerte',
        '.popin',
        '.popup',
        '[id*="alert" i]',
        '[class*="alert" i]',
        '[role="dialog"]',
      ].join(',');
      const containers = Array.from(document.querySelectorAll(containerSel)).filter(isVisible);
      // Try clicking an OK / Fermer / close button inside the popin.
      for (const c of containers) {
        const btn = Array.from(
          c.querySelectorAll<HTMLElement>(
            'button, input[type="button"], a, img, .buttonMiddle, .bouton',
          ),
        ).find((b) => {
          const t = (
            b.innerText ||
            (b as HTMLInputElement).value ||
            b.getAttribute('alt') ||
            ''
          ).trim();
          return /^(ok|fermer|valider|continuer)$/i.test(t) || /(ferm|close)/i.test(b.className);
        });
        if (btn) {
          const r = btn.getBoundingClientRect();
          const init = {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0,
            buttons: 1,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
          } as const;
          for (const k of ['mousedown', 'mouseup', 'click'] as const) {
            btn.dispatchEvent(new MouseEvent(k, init));
          }
          return { status: 'clicked' };
        }
      }
      // Fallback: hide the containers so the popin no longer blocks/re-fires.
      if (containers.length > 0) {
        for (const c of containers) (c as HTMLElement).style.display = 'none';
        return { status: 'hidden' };
      }
      return { status: 'no_popin' };
    },
  });
  return (res[0]?.result as { status: string } | undefined)?.status ?? 'null';
}

/**
 * Re-fill the subscriber-level fields the contact-widget zone-refresh wipes
 * (Nom / Prénom / adresse ligne1, optional ligne2) WITHOUT committing any
 * contact widget, then click the devis OK once. Returns the same shape as the
 * primary OK step so the caller can reuse its handling. No PII logged.
 */
export async function refillAndRetryOk(
  tabId: number,
  payloadJson: string,
): Promise<
  { ok: true; log: string[] } | { ok: false; log: string[]; error: string; errorMsg?: string }
> {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (
      json: string,
    ):
      | { ok: true; log: string[] }
      | { ok: false; log: string[]; error: string; errorMsg?: string } => {
      const p = JSON.parse(json);
      const out: string[] = [];
      const fire = (el: Element, t: string) => el.dispatchEvent(new Event(t, { bubbles: true }));
      const setInp = (name: string, val: string): boolean => {
        const el = document.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
        if (!el) return false;
        el.focus();
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, val);
        fire(el, 'input');
        fire(el, 'change');
        fire(el, 'blur');
        return true;
      };
      out.push('retry_nom=' + setInp('souscripteur.nom', p.lastName));
      out.push('retry_prenom=' + setInp('souscripteur.prenom', p.firstName));
      out.push(
        'retry_ligne1=' + setInp('souscripteur.adresseCorrespondance.ligne1', p.addressLine),
      );
      if (p.addressComplement) {
        out.push(
          'retry_ligne2=' +
            setInp('souscripteur.adresseCorrespondance.ligne2', p.addressComplement),
        );
      }
      // @ts-expect-error — page-global validator
      const em = typeof ErrorMessage === 'function' ? ErrorMessage() : '';
      const emClean = em
        ? em
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        : '';
      out.push('retry_errorMessage=' + (emClean ? 'NONEMPTY' : 'empty'));
      if (emClean) {
        return {
          ok: false,
          log: out,
          error: 'validator_nonempty',
          errorMsg: emClean.slice(0, 240),
        };
      }
      const c = document.getElementById('validerSouscription');
      if (!c) return { ok: false, log: out, error: 'no_OK_container' };
      const t = (c.querySelector('.buttonMiddle') as HTMLElement | null) ?? c;
      const r = t.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: 1,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      } as const;
      for (const k of ['mousedown', 'mouseup', 'click'] as const) {
        t.dispatchEvent(new MouseEvent(k, init));
      }
      out.push('retry_OK_clicked');
      return { ok: true, log: out };
    },
    args: [payloadJson],
  });
  return (
    (res[0]?.result as
      | { ok: true; log: string[] }
      | { ok: false; log: string[]; error: string; errorMsg?: string }
      | undefined) ?? { ok: false, log: ['retry=null_result'], error: 'retry_null_result' }
  );
}
