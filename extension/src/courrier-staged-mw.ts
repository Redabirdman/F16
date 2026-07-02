/**
 * Staged devis-email send in the Courrier composer — SW-side main-world
 * orchestration (2026-07-02 root-cause fix).
 *
 * Why this exists: the previous send path (courrier.fill-send-mw) filled the
 * Mail toolbar, called checkMail, slept 3s, then clicked ANY exact-'Valider'
 * button across frames and reported sent=true. Live mapping (manual browser
 * walkthrough) showed that when the composer failed to generate the letter —
 * which happens whenever the Maxance session's "current instance" is NOT the
 * devis (stale "Visité récemment" dossier → "branche différente" ALERTE) —
 * the popup is EMPTY, checkMail no-ops/closes it, and the blind Valider click
 * hit the letter-editor form submit instead: a fake success, no email.
 *
 * The verified sequence (devis DR0000983186, email received):
 *   A. Await the composer frame (window.name === 'impressionDR') with the
 *      Mail toolbar rendered; fail fast if an ALERTE popin is up instead.
 *   B. Fill mailAdresse / mailObjet in that frame (native setter + events).
 *   C. Call the frame's checkMail('mail','MAIL')  (= Envoyer).
 *   D. Await the "Mail : [Valider][Annuler]" confirmation stage in the SAME
 *      frame — body text starts with "Mail :" — then click its exact
 *      'Valider' .buttonMiddle.
 *   E. Verify the frame navigated to mail.do (the server send action). Only
 *      then return sent:true.
 *
 * Same chrome.scripting rules as every *-mw module: self-contained sync
 * funcs (serialized via toString(); nothing from module scope), MAIN world,
 * allFrames with a window.name gate, SW-owned sleeps between steps.
 */
import type { CourrierStagedSendRequest, CourrierStagedSendResponse } from './content-protocol.js';

/** Name of the composer frame opened by id:impressionDR (live-verified). */
const COMPOSER_FRAME_NAME = 'impressionDR';

/** Budget for the letter PDF + Mail toolbar to render after the popup opens. */
const COMPOSER_READY_TIMEOUT_MS = 30_000;
/** Budget for the "Mail :" confirmation stage to appear after checkMail. */
const CONFIRM_STAGE_TIMEOUT_MS = 15_000;
/** Budget for the frame to land on mail.do after the confirmation Valider. */
const SENT_VERIFY_TIMEOUT_MS = 25_000;
/** Poll cadence for all three waits. */
const POLL_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ComposerProbe {
  here: boolean;
  page: string;
  hasMailbar: boolean;
  confirmStage: boolean;
  alertText: string;
}

/** Probe the composer frame's state (runs in EVERY frame; no-ops elsewhere). */
async function probeComposer(tabId: number): Promise<ComposerProbe> {
  const res = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: (frameName: string): ComposerProbe | null => {
      if (window.name !== frameName) return null;
      const body = document.body ? document.body.innerText : '';
      // The Maxance ALERTE popin (ConstructAlertInfo) renders in the TOP
      // frame, not here — but a generation failure leaves this frame without
      // the Mail toolbar, which the caller times out on. Still, scan for an
      // inline alerte defensively.
      const alertEl = document.querySelector('.alerte, .alertInfo, [id*="alert" i]');
      return {
        here: true,
        page: (location.pathname.split('/').pop() ?? '').slice(0, 40),
        hasMailbar: Boolean(document.querySelector('input[name="mailAdresse"]')),
        confirmStage: /^\s*Mail\s*:/.test(body),
        alertText: alertEl ? ((alertEl as HTMLElement).innerText || '').slice(0, 120) : '',
      };
    },
    args: [COMPOSER_FRAME_NAME],
  });
  const hit = res
    .map((r) => r.result as ComposerProbe | null)
    .find((r): r is ComposerProbe => r !== null && r.here);
  return hit ?? { here: false, page: '', hasMailbar: false, confirmStage: false, alertText: '' };
}

/** Scan the TOP frame for a visible Maxance ALERTE popin (branch mismatch…). */
async function probeTopAlert(tabId: number): Promise<string> {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (): string => {
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
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const t = ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
          if (t && /ALERTE|ne peut être généré|erreur/i.test(t)) return t.slice(0, 160);
        }
      }
      return '';
    },
  });
  return (res[0]?.result as string | undefined) ?? '';
}

/**
 * Run the full staged send. The composer popup must have been opened by the
 * caller (open.mdi-window with id:impressionDR) BEFORE invoking this.
 */
export async function handleCourrierStagedSendMw(
  tabId: number,
  payload: CourrierStagedSendRequest['payload'],
): Promise<CourrierStagedSendResponse> {
  const log: string[] = [];
  try {
    // ── A. Await composer ready (Mail toolbar rendered) ──────────────────
    let ready = false;
    const t0 = Date.now();
    while (Date.now() - t0 < COMPOSER_READY_TIMEOUT_MS) {
      const p = await probeComposer(tabId);
      if (p.here && p.hasMailbar) {
        log.push(`composer=ready:${Date.now() - t0}ms:page=${p.page}`);
        ready = true;
        break;
      }
      // Not ready — is a top-frame ALERTE explaining why?
      const alert = await probeTopAlert(tabId);
      if (alert) {
        log.push(`topAlert=${alert}`);
        return {
          kind: 'courrier.staged.err',
          log,
          error: 'maxance_courrier_letter_not_generated',
        };
      }
      await sleep(POLL_MS);
    }
    if (!ready) {
      return { kind: 'courrier.staged.err', log, error: 'maxance_courrier_composer_timeout' };
    }

    // ── B. Fill mailAdresse / mailObjet in the composer frame ────────────
    const rb = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: (frameName: string, to: string, objet: string): { status: string } | null => {
        if (window.name !== frameName) return null;
        const fire = (el: Element, t: string) => el.dispatchEvent(new Event(t, { bubbles: true }));
        const set = (name: string, val: string): boolean => {
          const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
          if (!el) return false;
          el.focus();
          const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (d && d.set) d.set.call(el, val);
          fire(el, 'input');
          fire(el, 'change');
          fire(el, 'blur');
          return true;
        };
        const okTo = set('mailAdresse', to);
        const okObjet = set('mailObjet', objet);
        return { status: `to=${okTo},objet=${okObjet}` };
      },
      args: [COMPOSER_FRAME_NAME, payload.to, payload.objet],
    });
    const fb = rb.map((r) => r.result as { status: string } | null).find((r) => r !== null);
    log.push(`fill=${fb?.status ?? 'frame_not_found'}`);
    if (!fb || !fb.status.includes('to=true')) {
      return { kind: 'courrier.staged.err', log, error: 'maxance_courrier_fill_failed' };
    }

    // ── C. checkMail('mail','MAIL') in the composer frame ────────────────
    const rc = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: (frameName: string): { status: string } | null => {
        if (window.name !== frameName) return null;
        const w = window as unknown as { checkMail?: (a: string, b: string) => void };
        if (typeof w.checkMail !== 'function') return { status: 'checkMail_unavailable' };
        w.checkMail('mail', 'MAIL');
        return { status: 'checkMail_called' };
      },
      args: [COMPOSER_FRAME_NAME],
    });
    const cc = rc.map((r) => r.result as { status: string } | null).find((r) => r !== null);
    log.push(`envoyer=${cc?.status ?? 'frame_not_found'}`);
    if (!cc || cc.status !== 'checkMail_called') {
      return { kind: 'courrier.staged.err', log, error: 'maxance_courrier_checkmail_failed' };
    }

    // ── D. Await the "Mail :" confirmation stage, click its Valider ──────
    let confirmed = false;
    const t1 = Date.now();
    while (Date.now() - t1 < CONFIRM_STAGE_TIMEOUT_MS) {
      const p = await probeComposer(tabId);
      if (p.here && p.confirmStage) {
        log.push(`confirmStage=visible:${Date.now() - t1}ms`);
        confirmed = true;
        break;
      }
      await sleep(POLL_MS);
    }
    if (!confirmed) {
      return { kind: 'courrier.staged.err', log, error: 'maxance_courrier_confirm_stage_timeout' };
    }
    const rd = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: (frameName: string): { status: string } | null => {
        if (window.name !== frameName) return null;
        // Only in the confirm stage (body starts with "Mail :") — click the
        // exact-'Valider' control. Never runs against the letter editor.
        const body = document.body ? document.body.innerText : '';
        if (!/^\s*Mail\s*:/.test(body)) return { status: 'not_confirm_stage' };
        const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
        const cands = Array.from(
          document.querySelectorAll<HTMLElement>('.buttonMiddle, a, button, input[type=button]'),
        );
        const valider = cands.find((el) => norm(el.textContent) === 'Valider');
        if (!valider) return { status: 'valider_not_found' };
        const t = (valider.querySelector('.buttonMiddle') as HTMLElement | null) ?? valider;
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
        return { status: 'valider_clicked' };
      },
      args: [COMPOSER_FRAME_NAME],
    });
    const dd = rd.map((r) => r.result as { status: string } | null).find((r) => r !== null);
    log.push(`valider=${dd?.status ?? 'frame_not_found'}`);
    if (!dd || dd.status !== 'valider_clicked') {
      return { kind: 'courrier.staged.err', log, error: 'maxance_courrier_valider_failed' };
    }

    // ── E. Verify the frame executed mail.do (server-side send) ──────────
    const t2 = Date.now();
    while (Date.now() - t2 < SENT_VERIFY_TIMEOUT_MS) {
      const p = await probeComposer(tabId);
      if (p.here && /mail\.do$/.test(p.page)) {
        log.push(`sent=mail.do:${Date.now() - t2}ms`);
        return { kind: 'courrier.staged.ok', log, sent: true };
      }
      // Frame gone entirely (popup closed after send) also counts as done —
      // but only AFTER the confirm stage was seen and Valider clicked.
      if (!p.here) {
        log.push(`sent=frame_closed:${Date.now() - t2}ms`);
        return { kind: 'courrier.staged.ok', log, sent: true };
      }
      await sleep(POLL_MS);
    }
    return { kind: 'courrier.staged.err', log, error: 'maxance_courrier_sent_verify_timeout' };
  } catch (err) {
    return {
      kind: 'courrier.staged.err',
      log,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 240),
    };
  }
}
