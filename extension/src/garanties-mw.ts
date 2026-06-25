/**
 * Garanties closing controls — SW-side main-world orchestration (M8.T7 B1).
 *
 * Applies formule / commission / fractionnement on the Garanties tab via a
 * sequence of self-contained synchronous main-world executeScript steps with
 * SW-owned waits between them — the exact pattern proven by
 * devis.fill-and-submit-mw (background.ts): each step's effect is
 * deterministic before the next starts, no async main-world funcs, no
 * bundle-scope helpers (chrome.scripting serializes funcs via toString(),
 * so anything not defined INSIDE the func is undefined in the page).
 *
 * Live-verified DOM facts (2026-06-11 survey — see selectors.ts):
 *   - Formule radios name="codeFormuleSelected" (NV10/NV20/NV30), inline
 *     onclick="submitFormule();" (page-global) fires the AJAX re-render.
 *   - Commission input id="garantieTauxCommissionEffectif": native value
 *     setter + input/change/blur events — the generated inline onblur runs
 *     the AJAX (~5-6s; "Chargement" in body text while in-flight; input
 *     re-reads "22.0" afterwards; prices change, 78.85 → 83.71 at 22%).
 *   - Fractionnement select name="mouvement.codeFractionnement" (M/S/A),
 *     inline onchange=doSubmitFormCustomWithCacheAJAX(...) — set value +
 *     dispatch change, then wait for the re-render.
 *
 * Every step appends a log entry; the handler returns {ok, log,
 * finalCommission}. Garanties-additionnelles checkboxes are NEVER touched.
 */
import {
  COMMISSION_INPUT_ID,
  FORMULE_RADIO_NAME,
  FRACTIONNEMENT_SELECT_NAME,
} from './maxance/selectors.js';
import type { GarantiesConfigureRequest, GarantiesConfigureResponse } from './content-protocol.js';

/** Give the AJAX a beat to raise the "Chargement" indicator before polling. */
const RERENDER_INITIAL_SLEEP_MS = 1_000;
/** Poll cadence while waiting for the re-render to clear. */
const RERENDER_POLL_MS = 500;
/** Re-render budget for formule / fractionnement (typical ~5-6s live). */
const RERENDER_TIMEOUT_MS = 15_000;
/** Commission gets a wider budget — we also require the value re-read. */
const COMMISSION_RERENDER_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RenderState {
  chargement: boolean;
  commissionValue: string | null;
}

/** Read the in-flight indicator + the commission input's current value. */
async function readRenderState(tabId: number): Promise<RenderState> {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (commissionInputId: string): { chargement: boolean; commissionValue: string | null } => {
      const body = document.body ? document.body.innerText : '';
      const el = document.getElementById(commissionInputId) as HTMLInputElement | null;
      return { chargement: /Chargement/i.test(body), commissionValue: el ? el.value : null };
    },
    args: [COMMISSION_INPUT_ID],
  });
  return (
    (res[0]?.result as RenderState | undefined) ?? { chargement: false, commissionValue: null }
  );
}

/**
 * Wait for the AJAX re-render to settle: "Chargement" cleared from the body
 * text and — when `expectCommissionPct` is given — the commission input
 * re-reads the target (parseFloat compare: portal renders "22.0" for 22).
 * Throws a tagged error on timeout so the caller surfaces garanties.err.
 */
async function waitForRerender(
  tabId: number,
  opts: { timeoutMs: number; expectCommissionPct?: number },
): Promise<string> {
  const t0 = Date.now();
  await sleep(RERENDER_INITIAL_SLEEP_MS);
  const deadline = t0 + opts.timeoutMs;
  let last: RenderState = { chargement: true, commissionValue: null };
  while (Date.now() < deadline) {
    last = await readRenderState(tabId);
    const commissionOk =
      opts.expectCommissionPct === undefined ||
      Number.parseFloat(last.commissionValue ?? '') === opts.expectCommissionPct;
    if (!last.chargement && commissionOk) {
      return `rerender=ok:${Date.now() - t0}ms`;
    }
    await sleep(RERENDER_POLL_MS);
  }
  throw new Error(
    `rerender_timeout:chargement=${last.chargement}:commission=${last.commissionValue ?? 'null'}`,
  );
}

/**
 * Apply the requested Garanties configuration. Steps run in order:
 *   (a) formule radio (when provided and not already checked),
 *   (b) commission (ALWAYS — skip-set only when the input already matches),
 *   (c) fractionnement (when provided and differs).
 * Each mutating step waits for the AJAX re-render before the next starts.
 */
export async function handleGarantiesConfigureMw(
  tabId: number,
  payload: GarantiesConfigureRequest['payload'],
): Promise<GarantiesConfigureResponse> {
  const log: string[] = [];
  try {
    // (a) Formule radio.
    if (payload.formuleCode) {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (radioName: string, code: string): { status: string } => {
          const radio = document.querySelector(
            `input[name="${radioName}"][value="${code}"]`,
          ) as HTMLInputElement | null;
          if (!radio) return { status: 'err:formule_radio_not_found' };
          if (radio.checked) return { status: 'already' };
          radio.checked = true;
          radio.dispatchEvent(new Event('change', { bubbles: true }));
          // The radios' inline onclick is `submitFormule();` (page-global).
          // Call it directly — exactly once — instead of synthesizing a
          // click (which would ALSO run the inline handler → double submit).
          const w = window as unknown as { submitFormule?: () => void };
          if (typeof w.submitFormule !== 'function') {
            return { status: 'err:submitFormule_unavailable' };
          }
          w.submitFormule();
          return { status: 'submitted' };
        },
        args: [FORMULE_RADIO_NAME, payload.formuleCode],
      });
      const status = (r[0]?.result as { status: string } | undefined)?.status ?? 'err:null_result';
      log.push(`formule=${status}`);
      if (status.startsWith('err:')) return { kind: 'garanties.err', log, error: status.slice(4) };
      if (status === 'submitted') {
        log.push(await waitForRerender(tabId, { timeoutMs: RERENDER_TIMEOUT_MS }));
      }
    }

    // (b) Commission — ALWAYS applied (caller defaults to 22).
    const target = payload.commissionPct;
    const rb = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (inputId: string, targetStr: string): { status: string; value?: string } => {
        const el = document.getElementById(inputId) as HTMLInputElement | null;
        if (!el) return { status: 'err:commission_input_not_found' };
        const current = Number.parseFloat(el.value);
        const tgt = Number.parseFloat(targetStr);
        if (Number.isFinite(current) && current === tgt) {
          return { status: 'already', value: el.value };
        }
        el.focus();
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, targetStr);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // The generated inline onblur (garantieTauxCommissionEffectif…
        // setSliderValue0) runs the AJAX. Run it exactly once: invoke the
        // property handler directly when present, else dispatch a blur
        // event (which triggers the same inline handler).
        if (typeof el.onblur === 'function') {
          el.onblur(new FocusEvent('blur'));
          return { status: 'set_onblur_called' };
        }
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return { status: 'set_blur_dispatched' };
      },
      args: [COMMISSION_INPUT_ID, String(target)],
    });
    const cb = (rb[0]?.result as { status: string; value?: string } | undefined) ?? {
      status: 'err:null_result',
    };
    log.push(`commission=${cb.status}`);
    if (cb.status.startsWith('err:')) {
      return { kind: 'garanties.err', log, error: cb.status.slice(4) };
    }
    if (cb.status !== 'already') {
      log.push(
        await waitForRerender(tabId, {
          timeoutMs: COMMISSION_RERENDER_TIMEOUT_MS,
          expectCommissionPct: target,
        }),
      );
    }

    // (c) Fractionnement.
    if (payload.fractionnementCode) {
      const rc = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (selectName: string, code: string): { status: string } => {
          const sel = document.querySelector(
            `select[name="${selectName}"]`,
          ) as HTMLSelectElement | null;
          if (!sel) return { status: 'err:fractionnement_select_not_found' };
          if (sel.value === code) return { status: 'already' };
          sel.value = code;
          if (sel.value !== code) return { status: 'err:fractionnement_option_missing' };
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          // Inline onchange = doSubmitFormCustomWithCacheAJAX(...) → fires
          // on the synthetic change event in MAIN world.
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { status: 'changed' };
        },
        args: [FRACTIONNEMENT_SELECT_NAME, payload.fractionnementCode],
      });
      const status = (rc[0]?.result as { status: string } | undefined)?.status ?? 'err:null_result';
      log.push(`fractionnement=${status}`);
      if (status.startsWith('err:')) return { kind: 'garanties.err', log, error: status.slice(4) };
      if (status === 'changed') {
        log.push(await waitForRerender(tabId, { timeoutMs: RERENDER_TIMEOUT_MS }));
      }
    }

    // Final commission read — proof that the forced 22% actually stuck.
    const finalState = await readRenderState(tabId);
    const finalCommission = finalState.commissionValue ?? '';
    if (Number.parseFloat(finalCommission) !== target) {
      log.push(`finalCommission=${finalCommission || 'null'}`);
      return { kind: 'garanties.err', log, error: 'commission_not_applied' };
    }
    log.push(`finalCommission=${finalCommission}`);
    return { kind: 'garanties.ok', log, finalCommission };
  } catch (err) {
    return {
      kind: 'garanties.err',
      log,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 240),
    };
  }
}
