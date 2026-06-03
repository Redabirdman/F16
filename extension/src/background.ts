/**
 * MV3 service worker — F16 Maxance driver.
 *
 * Responsibilities:
 *   1. Persistent outbound WebSocket to ws://127.0.0.1:9223 (the backend's
 *      extension-client.ts, landing in M8.T8 phase 2c). Reconnect-forever
 *      with exponential backoff. Idempotent across SW resurrection.
 *   2. On connect, send a `hello` event with extension version + active
 *      Maxance tab URL.
 *   3. Route inbound Commands:
 *        - `ping` → answer with `pong` directly here (no tab work needed).
 *        - everything else → forward to the active Maxance tab's content
 *          script via chrome.tabs.sendMessage; await its FlowOutcome;
 *          forward the wrapped Response to the backend WS.
 *   4. Handle side-channel messages from the content script:
 *        - `capture_screenshot` → chrome.tabs.captureVisibleTab, reply.
 *        - `progress.forward` → emit a wire ProgressEvent to the backend.
 *
 * Driver gate (matches the backend's MAXANCE_DRIVER env): if no Maxance
 * tab is open, the SW returns a tagged
 * `maxance_extension_no_active_tab` error so the backend's existing
 * QUOTE.FAILED routing surfaces it correctly.
 */
import {
  parseFrame,
  type Command,
  type Event,
  type Response,
  PongResponseSchema,
  ErrorResponseSchema,
  HelloEventSchema,
  ProgressEventSchema,
} from './wire.js';
import type {
  ContentInbound,
  FlowOutcome,
  ScreenshotResponse,
  SwInbound,
} from './content-protocol.js';

/** Backend WS endpoint. Hard-coded for V1 — production = same machine. */
const BACKEND_WS_URL = 'ws://127.0.0.1:9223';

/** Clean Proximéo home — used to RESET the tab after a flow error so the
 *  next run starts from a known-good state (autonomous self-healing). */
const MAXANCE_HOME_URL = 'https://www.maxance.com/Proximeo/accueil.do';

/** Reconnect backoff schedule. Caps at 30s after attempt #5. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000] as const;

/** Read the MV3 manifest version at runtime — sent in the `hello` event. */
function extensionVersion(): string {
  const m = chrome.runtime.getManifest();
  return m.version ?? '0.0.0';
}

/**
 * Find the Maxance tab to drive. Strategy:
 *   1. If there's exactly one Maxance tab → use it.
 *   2. If there are several → prefer the active one in any window.
 *   3. If none → return null and let the caller surface no_active_tab.
 */
async function findMaxanceTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({
    url: ['https://www.maxance.com/*', 'https://extranet.maxance.com/*'],
  });
  if (tabs.length === 0) return null;
  return tabs.find((t) => t.active) ?? tabs[0] ?? null;
}

/** Send a wire frame on the open WS. No-ops silently if not OPEN. */
function sendOnWs(sock: WebSocket | null, frame: Response | Event): void {
  if (!sock || sock.readyState !== WebSocket.OPEN) return;
  try {
    sock.send(JSON.stringify(frame));
  } catch (err) {
    console.warn('[f16-ext] ws send failed', err);
  }
}

/** Module-level reference to the live socket — used by progress.forward. */
let liveSocket: WebSocket | null = null;

/**
 * Forward a Command to the active Maxance tab's content script and await
 * its FlowOutcome. Times out if the content script doesn't respond within
 * the command's timeoutMs (default 60s — flows themselves can be long, so
 * we add a generous outer budget).
 */
async function forwardToContent(command: Command): Promise<Response> {
  const tab = await findMaxanceTab();
  if (!tab || tab.id === undefined) {
    return ErrorResponseSchema.parse({
      id: command.id,
      kind: 'error',
      errorCode: 'maxance_extension_no_active_tab',
      detail: 'no maxance.com tab open in this Chrome — operator must navigate first',
    });
  }
  const tabId = tab.id;

  // M8.T8 phase 2e — quote.preview / quote.confirm go through the
  // navigation-aware orchestrator. Plain commands (login.ensure) still
  // use the single-shot path because they're intra-page or have their
  // own URL-wait logic baked in.
  if (command.kind === 'quote.preview' || command.kind === 'quote.confirm') {
    const resp = await orchestrateNavigatingFlow(tabId, command);
    // Autonomous self-healing (phase-2j, Ridaa 2026-06-03): a failed flow
    // leaves the Maxance wizard mid-state (partial vehicle/devis fill,
    // stuck popup, error alert) which poisons the NEXT run. Reset the tab
    // to a clean Proximéo home on error so a re-run starts fresh. The
    // error response (with its detail + screenshots) is built BEFORE we
    // navigate, so diagnostics aren't lost. No reset on success — confirm
    // needs preview's Garanties state to carry over.
    if (resp.kind === 'error') {
      await resetMaxanceTabToHome(tabId).catch(() => undefined);
    }
    return resp;
  }

  // `ping` is handled directly by the SW (never reaches forwardToContent),
  // but TypeScript narrows the union here — only the three flow commands
  // carry a `timeoutMs` field. Read it via a small helper.
  const cmdTimeout = 'timeoutMs' in command ? command.timeoutMs : undefined;
  const outerTimeoutMs = (cmdTimeout ?? 60_000) + 30_000; // small margin over the flow's own budget
  const envelope: ContentInbound = { kind: 'flow', command };
  try {
    const result = await sendWithReinjection(tabId, envelope, outerTimeoutMs);
    return result.response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'sw_forward_timeout') {
      return ErrorResponseSchema.parse({
        id: command.id,
        kind: 'error',
        errorCode: 'maxance_extension_flow_timeout',
        detail: `content script did not respond within ${outerTimeoutMs}ms`,
      });
    }
    return ErrorResponseSchema.parse({
      id: command.id,
      kind: 'error',
      errorCode: 'maxance_extension_forward_failed',
      detail: msg.slice(0, 240),
    });
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Navigation-aware flow orchestrator (M8.T8 phase 2e)                   */
/* ────────────────────────────────────────────────────────────────────── */

/** Max advance iterations before giving up — comfortably above the 4-screen
 *  quote-preview chain (vehicle_picker → vehicule_tab → conducteur_tab →
 *  garanties_tab) plus any intra-page bridge-modal dismissals. */
const ORCHESTRATE_MAX_ITERATIONS = 8;
/** How long the SW waits for chrome.webNavigation.onCompleted after a
 *  navigating response. If no nav fires within this window we assume the
 *  click didn't navigate (e.g. it popped a same-page modal) and just
 *  re-advance against the same content script. */
const NAV_COMPLETE_TIMEOUT_MS = 20_000;
/** Settle pause after a navigation completes — gives the new page's
 *  inline `MainMenu_0CreateOnglet(...)`-style scripts time to render the
 *  DOM before our next advance hits `detectCurrentScreen`. */
const POST_NAV_SETTLE_MS = 800;
/** Per-advance content-script timeout. Smaller than the legacy 60s
 *  because each advance is now short (one screen of work). */
const ADVANCE_TIMEOUT_MS = 60_000;

/**
 * Drive a navigation-prone flow (quote.preview / quote.confirm) across
 * top-frame navigations by calling the SAME command repeatedly against
 * the freshly-injected content script in each new page.
 *
 * Content-script contract (see flows/quote-preview.ts):
 *   - returns `*.navigating` when it just clicked a control that
 *     triggers a top-frame nav. SW awaits onCompleted, re-invokes.
 *   - returns `*.ok` when the flow is done. SW returns to caller.
 *   - returns `error` on any failure. SW returns to caller.
 *
 * Screenshots are accumulated across iterations and merged into the
 * final response so upstream callers see the full forensic chain.
 */
async function orchestrateNavigatingFlow(tabId: number, command: Command): Promise<Response> {
  const accumulatedScreenshots: { step: string; dataUrl: string }[] = [];
  const envelope: ContentInbound = { kind: 'flow', command };
  const start = Date.now();
  const hardDeadline = 'timeoutMs' in command ? (command.timeoutMs ?? 240_000) : 240_000;

  for (let iter = 0; iter < ORCHESTRATE_MAX_ITERATIONS; iter += 1) {
    if (Date.now() - start > hardDeadline) {
      return ErrorResponseSchema.parse({
        id: command.id,
        kind: 'error',
        errorCode: 'maxance_extension_orchestrate_hard_timeout',
        detail: `total elapsed exceeded ${hardDeadline}ms after iter=${iter}`,
        screenshots: accumulatedScreenshots,
      });
    }

    let outcome: FlowOutcome;
    try {
      outcome = await sendWithReinjection(tabId, envelope, ADVANCE_TIMEOUT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return ErrorResponseSchema.parse({
        id: command.id,
        kind: 'error',
        errorCode:
          msg === 'sw_forward_timeout'
            ? 'maxance_extension_flow_timeout'
            : 'maxance_extension_forward_failed',
        detail: msg.slice(0, 240),
        screenshots: accumulatedScreenshots,
      });
    }
    const resp = outcome.response;

    // Accumulate any screenshots this advance collected.
    if ('screenshots' in resp && Array.isArray(resp.screenshots)) {
      accumulatedScreenshots.push(...resp.screenshots);
    }

    if (resp.kind === 'error') {
      return { ...resp, screenshots: accumulatedScreenshots };
    }
    if (resp.kind === 'quote.preview.ok' || resp.kind === 'quote.confirm.ok') {
      // Replace the final response's screenshots with the full accumulated
      // set so callers see the entire navigation chain.
      return { ...resp, screenshots: accumulatedScreenshots };
    }
    if (resp.kind === 'quote.preview.navigating' || resp.kind === 'quote.confirm.navigating') {
      console.warn(
        `[f16-ext] orchestrator: iter ${iter} returned navigating from=${resp.fromScreen} expected=${resp.expectedScreen}`,
      );
      try {
        await waitForNavigationComplete(tabId, NAV_COMPLETE_TIMEOUT_MS);
      } catch {
        // No navigation fired in the window — the click was likely an
        // intra-page action (modal popup, AJAX fragment). Re-advance
        // immediately against the SAME page; detectCurrentScreen will
        // report the new state and the switch picks up the right branch.
        console.warn(
          `[f16-ext] orchestrator: no nav within ${NAV_COMPLETE_TIMEOUT_MS}ms — re-advancing in place`,
        );
      }
      await sleep(POST_NAV_SETTLE_MS);
      continue;
    }

    // Any other kind (pong, login.ensure.ok) shouldn't reach the
    // orchestrator. Surface as an error so we don't loop forever.
    return ErrorResponseSchema.parse({
      id: command.id,
      kind: 'error',
      errorCode: 'maxance_extension_orchestrate_unexpected_kind',
      detail: `unexpected response kind=${resp.kind} at iter=${iter}`,
      screenshots: accumulatedScreenshots,
    });
  }

  return ErrorResponseSchema.parse({
    id: command.id,
    kind: 'error',
    errorCode: 'maxance_extension_orchestrate_too_many_iterations',
    detail: `flow did not complete after ${ORCHESTRATE_MAX_ITERATIONS} advance iterations`,
    screenshots: accumulatedScreenshots,
  });
}

/**
 * Resolve when `chrome.webNavigation.onCompleted` fires for `tabId` on
 * the top frame (frameId 0). Rejects on `timeoutMs` elapsed. The
 * one-shot listener is always detached on resolve/reject so we don't
 * leak across the orchestrator's iterations.
 */
function waitForNavigationComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const detach = (): void => {
      chrome.webNavigation.onCompleted.removeListener(listener);
      clearTimeout(timer);
    };
    const listener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
      if (details.tabId !== tabId) return;
      if (details.frameId !== 0) return; // top frame only
      if (settled) return;
      settled = true;
      detach();
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      detach();
      reject(new Error('nav_complete_timeout'));
    }, timeoutMs);
    chrome.webNavigation.onCompleted.addListener(listener);
  });
}

/**
 * Autonomous self-healing reset (phase-2j): navigate the Maxance tab to a
 * clean Proximéo home so the NEXT flow run starts from a known-good state.
 * Called after a quote.preview / quote.confirm error — a failed run leaves
 * the wizard mid-state (partial fill, stuck Courrier popup, error alert)
 * that would otherwise poison subsequent runs. If the session expired,
 * accueil.do re-triggers SSO (silent if the Auth0 cookie is still valid).
 * Best-effort: swallows nav timeouts (the next run's screen detection +
 * its own SSO-transient handling will cope).
 */
async function resetMaxanceTabToHome(tabId: number): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { url: MAXANCE_HOME_URL });
  } catch {
    return; // tab gone — nothing to reset
  }
  await waitForNavigationComplete(tabId, 20_000).catch(() => undefined);
  await sleep(1_000); // settle so the home's bootstrap scripts render
}

/**
 * Send a flow command to the content script, with one auto-reinject retry.
 *
 * After the extension is reloaded (chrome://extensions → reload), any
 * pre-existing Maxance tab still has the OLD content script in memory but
 * its message bridge to the new SW is severed — sendMessage rejects with
 * "Could not establish connection. Receiving end does not exist." The
 * native fix is to re-inject content.js via chrome.scripting.executeScript
 * and retry. This avoids forcing the operator to F5 every Maxance tab
 * after every extension reload (which was the M8.T8 phase-2d friction
 * point that ate 15 min).
 *
 * Single retry — if the second attempt also fails, the tab is genuinely
 * unreachable and we propagate the error.
 */
async function sendWithReinjection(
  tabId: number,
  envelope: ContentInbound,
  outerTimeoutMs: number,
): Promise<FlowOutcome> {
  try {
    return await raceWithTimeout(
      chrome.tabs.sendMessage<ContentInbound, FlowOutcome>(tabId, envelope),
      outerTimeoutMs,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/receiving end does not exist/i.test(msg)) throw err;
    console.warn('[f16-ext] content script unreachable — re-injecting content.js', err);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    // Tiny settle pause so the freshly-injected script registers its
    // onMessage listener before our retry lands.
    await sleep(120);
    return raceWithTimeout(
      chrome.tabs.sendMessage<ContentInbound, FlowOutcome>(tabId, envelope),
      outerTimeoutMs,
    );
  }
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sw_forward_timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Route an inbound Command. ping is answered locally; everything else
 * forwards to the active Maxance tab's content script.
 */
async function handleCommand(sock: WebSocket, cmd: Command): Promise<void> {
  let response: Response;
  if (cmd.kind === 'ping') {
    response = PongResponseSchema.parse({
      id: cmd.id,
      kind: 'pong',
      ...(cmd.nonce !== undefined ? { nonce: cmd.nonce } : {}),
    });
  } else {
    response = await forwardToContent(cmd);
  }
  sendOnWs(sock, response);
}

/**
 * Capture the visible viewport of the active Maxance tab. Returns a PNG
 * data URL. Used by the content script's `captureScreenshot` helper —
 * content scripts can't call chrome.tabs.captureVisibleTab themselves.
 */
async function captureActiveTabScreenshot(): Promise<ScreenshotResponse> {
  const tab = await findMaxanceTab();
  if (!tab || tab.windowId === undefined) {
    return { kind: 'capture.err', error: 'no_maxance_tab' };
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { kind: 'capture.ok', dataUrl };
  } catch (err) {
    return { kind: 'capture.err', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Side-channel listener. The content script sends:
 *   - `capture_screenshot` — synchronous-from-callsite request; respond
 *     with the dataUrl.
 *   - `progress.forward` — fire-and-forget; emit a wire ProgressEvent to
 *     the backend WS.
 *
 * Returning `true` keeps the message channel open until sendResponse is
 * called (mandatory for async work — see MDN runtime.onMessage docs).
 */
chrome.runtime.onMessage.addListener(
  (
    message: SwInbound,
    sender,
    sendResponse: (
      resp:
        | ScreenshotResponse
        | { ok: true }
        | { kind: 'click.ok' }
        | { kind: 'click.err'; error: string }
        | { kind: 'devis.ok'; log: string[] }
        | { kind: 'devis.err'; log: string[]; error: string; errorMsg?: string }
        | { kind: 'mdi.ok' }
        | { kind: 'mdi.err'; error: string }
        | { kind: 'courrier.ok'; log: string[]; filledFrame: boolean; sent: boolean }
        | { kind: 'courrier.err'; error: string },
    ) => void,
  ) => {
    if (message.kind === 'capture_screenshot') {
      void captureActiveTabScreenshot().then((resp) => sendResponse(resp));
      return true;
    }
    if (message.kind === 'progress.forward') {
      const event = ProgressEventSchema.parse({
        kind: 'progress',
        commandId: message.commandId,
        step: message.step,
        ...(message.detail !== undefined ? { detail: message.detail } : {}),
      });
      sendOnWs(liveSocket, event);
      sendResponse({ ok: true });
      return false;
    }
    if (message.kind === 'devis.fill-and-submit-mw') {
      // Phase-2d-confirm-7 (2026-05-25 PM): Devis form fill via a
      // sequence of synchronous main-world executeScript calls with
      // SW-orchestrated sleeps between them. Earlier attempt to do it
      // all in ONE async main-world function had the function returning
      // immediately without awaiting its Promise (chrome.scripting's
      // auto-await of returned Promises behaves inconsistently for
      // async arrow functions across some Chrome versions). Multi-step
      // sync calls eliminate that — each step's effect is deterministic
      // before the next step starts.
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        sendResponse({ kind: 'devis.err', log: [], error: 'no_sender_tab' });
        return false;
      }
      void (async () => {
        const log: string[] = [];
        // Pack all string params into a single JSON-encoded string arg —
        // chrome.scripting.executeScript serializes args via structured
        // clone, which works reliably for primitive strings but had
        // intermittent failures returning null when nested objects were
        // passed for funcs typed with TS generics. Strings are safe.
        const payloadJson = JSON.stringify(message.payload);
        try {
          // Step 1: fill subscriber + phone draft fields.
          const r1 = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (payloadJson: string): { log: string[] } => {
              const p = JSON.parse(payloadJson);
              const out: string[] = [];
              const fire = (el: Element, t: string) =>
                el.dispatchEvent(new Event(t, { bubbles: true }));
              const setInp = (name: string, val: string): boolean => {
                const el = document.querySelector(
                  `input[name="${name}"]`,
                ) as HTMLInputElement | null;
                if (!el) return false;
                el.focus();
                const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                desc?.set?.call(el, val);
                fire(el, 'input');
                fire(el, 'change');
                fire(el, 'blur');
                return true;
              };
              const setSel = (name: string, val: string): boolean => {
                const el = document.querySelector(
                  `select[name="${name}"]`,
                ) as HTMLSelectElement | null;
                if (!el) return false;
                el.value = val;
                fire(el, 'input');
                fire(el, 'change');
                return el.value === val;
              };
              out.push('nom=' + setInp('souscripteur.nom', p.lastName));
              out.push('prenom=' + setInp('souscripteur.prenom', p.firstName));
              out.push(
                'ligne1=' + setInp('souscripteur.adresseCorrespondance.ligne1', p.addressLine),
              );
              if (p.addressComplement) {
                out.push(
                  'ligne2=' +
                    setInp('souscripteur.adresseCorrespondance.ligne2', p.addressComplement),
                );
              }
              out.push('phoneType=' + setSel('telephoneListBean.currentContact.type', p.phoneType));
              out.push(
                'phoneUsage=' + setSel('telephoneListBean.currentContact.usage', p.phoneUsage),
              );
              out.push(
                'phoneNum=' +
                  setInp('telephoneListBean.currentContact.telephoneNumero', p.phoneNumero),
              );
              return { log: out };
            },
            args: [payloadJson],
          });
          const fillStep = r1[0]?.result as { log: string[] } | undefined;
          log.push(...(fillStep?.log ?? ['fillStep=null']));
          await new Promise((r) => setTimeout(r, 500));

          // Step 2: phone Nouveau commit (no args).
          const r2 = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (): { log: string[] } => {
              const out: string[] = [];
              const phoneType = document.querySelector(
                'select[name="telephoneListBean.currentContact.type"]',
              );
              const fs = phoneType?.closest('fieldset');
              const nv = fs?.querySelector('img[alt="Nouveau"], img[src$="nouveau.gif"]');
              if (!nv) {
                out.push('phoneNouveau=no_img');
                return { log: out };
              }
              const oc = (nv.getAttribute('onclick') || '').replace(/^\s*javascript:\s*/i, '');
              try {
                new Function(oc)();
                out.push('phoneNouveau=ok');
              } catch (e) {
                out.push('phoneNouveau=err:' + (e instanceof Error ? e.message : String(e)));
              }
              return { log: out };
            },
          });
          const phoneStep = r2[0]?.result as { log: string[] } | undefined;
          log.push(...(phoneStep?.log ?? ['phoneStep=null']));
          await new Promise((r) => setTimeout(r, 2500));

          // Step 3: fill email draft.
          const r3 = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (payloadJson: string): { log: string[] } => {
              const p = JSON.parse(payloadJson);
              const out: string[] = [];
              const fire = (el: Element, t: string) =>
                el.dispatchEvent(new Event(t, { bubbles: true }));
              const emailUsage = document.querySelector(
                'select[name="emailListBean.currentContact.usage"]',
              ) as HTMLSelectElement | null;
              const emailAddr = document.querySelector(
                'input[name="emailListBean.currentContact.adresseMail"]',
              ) as HTMLInputElement | null;
              if (!emailUsage || !emailAddr) {
                out.push('emailFields=missing');
                return { log: out };
              }
              emailUsage.value = p.emailUsage;
              fire(emailUsage, 'input');
              fire(emailUsage, 'change');
              emailAddr.focus();
              const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
              desc?.set?.call(emailAddr, p.email);
              fire(emailAddr, 'input');
              fire(emailAddr, 'change');
              fire(emailAddr, 'blur');
              out.push('emailFilled');
              return { log: out };
            },
            args: [payloadJson],
          });
          const emailFillStep = r3[0]?.result as { log: string[] } | undefined;
          log.push(...(emailFillStep?.log ?? ['emailFillStep=null']));
          await new Promise((r) => setTimeout(r, 500));

          // Step 4: email Nouveau commit (no args).
          const r4 = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (): { log: string[] } => {
              const out: string[] = [];
              const emailUsage = document.querySelector(
                'select[name="emailListBean.currentContact.usage"]',
              );
              const fs = emailUsage?.closest('fieldset');
              const nv = fs?.querySelector('img[alt="Nouveau"], img[src$="nouveau.gif"]');
              if (!nv) {
                out.push('emailNouveau=no_img');
                return { log: out };
              }
              const oc = (nv.getAttribute('onclick') || '').replace(/^\s*javascript:\s*/i, '');
              try {
                new Function(oc)();
                out.push('emailNouveau=ok');
              } catch (e) {
                out.push('emailNouveau=err:' + (e instanceof Error ? e.message : String(e)));
              }
              return { log: out };
            },
          });
          const emailNouveauStep = r4[0]?.result as { log: string[] } | undefined;
          log.push(...(emailNouveauStep?.log ?? ['emailNouveauStep=null']));
          await new Promise((r) => setTimeout(r, 2500));

          // Step 5: RE-FILL Nom/Prénom/ligne1 (Maxance's Nouveau AJAX zone
          // refresh replaces them with fresh empty inputs — verified
          // 2026-05-25 PM: ErrorMessage returned "champ Nom obligatoire"
          // even though step 1 set them; the post-Nouveau form has new
          // empty inputs), then verify ErrorMessage + click OK.
          const r5 = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (
              payloadJson: string,
            ):
              | { ok: true; log: string[] }
              | { ok: false; log: string[]; error: string; errorMsg?: string } => {
              const p = JSON.parse(payloadJson);
              const out: string[] = [];
              const fire = (el: Element, t: string) =>
                el.dispatchEvent(new Event(t, { bubbles: true }));
              const setInp = (name: string, val: string): boolean => {
                const el = document.querySelector(
                  `input[name="${name}"]`,
                ) as HTMLInputElement | null;
                if (!el) return false;
                el.focus();
                const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                desc?.set?.call(el, val);
                fire(el, 'input');
                fire(el, 'change');
                fire(el, 'blur');
                return true;
              };
              out.push('refill_nom=' + setInp('souscripteur.nom', p.lastName));
              out.push('refill_prenom=' + setInp('souscripteur.prenom', p.firstName));
              out.push(
                'refill_ligne1=' +
                  setInp('souscripteur.adresseCorrespondance.ligne1', p.addressLine),
              );
              if (p.addressComplement) {
                out.push(
                  'refill_ligne2=' +
                    setInp('souscripteur.adresseCorrespondance.ligne2', p.addressComplement),
                );
              }
              // @ts-expect-error — page-global
              const em = typeof ErrorMessage === 'function' ? ErrorMessage() : '';
              const emClean = em
                ? em
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                : '';
              out.push('errorMessage=' + (emClean ? 'NONEMPTY' : 'empty'));
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
              out.push('OK_clicked');
              return { ok: true, log: out };
            },
            args: [payloadJson],
          });
          const okStep = r5[0]?.result as
            | { ok: true; log: string[] }
            | { ok: false; log: string[]; error: string; errorMsg?: string }
            | undefined;
          log.push(...(okStep?.log ?? ['okStep=null']));
          if (!okStep || !okStep.ok) {
            sendResponse({
              kind: 'devis.err',
              log,
              error: okStep?.error ?? 'okStep_null',
              ...(okStep && 'errorMsg' in okStep && okStep.errorMsg
                ? { errorMsg: okStep.errorMsg }
                : {}),
            });
            return;
          }
          sendResponse({ kind: 'devis.ok', log });
        } catch (e) {
          sendResponse({
            kind: 'devis.err',
            log,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      return true;
    }
    if (message.kind === 'click.contact-nouveau') {
      // Phase-2d-confirm (2026-05-25 PM): Devis tab contact widgets
      // (phone + email) require a Nouveau-img click to commit
      // currentContact.* → contactList[0] before OK submit. The inline
      // onclick calls doSubmitFormWithCheckCustomAJAX which validates
      // the form via ErrorMessage() — fails silently if any required
      // field is empty. The fillDevisTab caller ensures Nom/Prénom/voie
      // are filled BEFORE invoking this helper for phone/email widgets.
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        sendResponse({ kind: 'click.err', error: 'no_sender_tab' });
        return false;
      }
      void chrome.scripting
        .executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (inputName: string) => {
            const input = document.querySelector(
              `select[name="${inputName}"], input[name="${inputName}"]`,
            ) as HTMLElement | null;
            if (!input) return { ok: false, error: 'input_not_found' };
            const fs = input.closest('fieldset');
            if (!fs) return { ok: false, error: 'no_fieldset' };
            const nouveau = fs.querySelector(
              'img[alt="Nouveau"], img[src$="nouveau.gif"]',
            ) as HTMLElement | null;
            if (!nouveau) return { ok: false, error: 'no_nouveau' };
            // Capture ErrorMessage state for diagnostics — if non-empty,
            // the Maxance validator will bail and the AJAX add won't fire.
            // Strip HTML tags for log compactness.
            // @ts-expect-error — ErrorMessage is page-global
            const em = typeof ErrorMessage === 'function' ? ErrorMessage() : null;
            const errBefore = em
              ? em
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 200)
              : null;
            // Phase-2d-confirm-2 (2026-05-25 PM): directly evaluate the
            // inline onclick JS (doSubmitFormWithCheckCustomAJAX(...)) so
            // we don't depend on the synthetic-MouseEvent path triggering
            // inline onclick handlers. New Function() runs the code in
            // main world (already are in main world here). Fall back to
            // MouseEvent dispatch if onclick attr is empty.
            const oc = (nouveau.getAttribute('onclick') || '').replace(/^\s*javascript:\s*/i, '');
            if (oc) {
              try {
                new Function(oc)();
                return { ok: true, ranOnclickDirect: true, errBefore };
              } catch (e) {
                return {
                  ok: false,
                  error: 'eval_err:' + (e instanceof Error ? e.message : String(e)),
                  errBefore,
                };
              }
            }
            const r = nouveau.getBoundingClientRect();
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
              nouveau.dispatchEvent(new MouseEvent(k, init));
            }
            return { ok: true, errBefore };
          },
          args: [message.withinFieldsetOfInputName],
        })
        .then((results) => {
          const r = results[0]?.result as
            | { ok: boolean; error?: string; errBefore?: string | null; ranOnclickDirect?: boolean }
            | undefined;
          if (r?.ok) {
            // Diagnostic-only: errBefore tells us whether ErrorMessage was
            // bailing at click time. Logging via console so it's visible
            // in the extension's SW devtools without changing wire shape.
            if (r.errBefore) {
              console.warn(
                '[f16-ext] click.contact-nouveau dispatched but ErrorMessage was non-empty:',
                r.errBefore,
              );
            }
            sendResponse({ kind: 'click.ok' });
          } else sendResponse({ kind: 'click.err', error: r?.error ?? 'unknown' });
        })
        .catch((err: unknown) => {
          sendResponse({
            kind: 'click.err',
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    }
    if (message.kind === 'click.main-world') {
      // Phase-2f-4: dispatch mousedown+mouseup+click on .buttonMiddle in the
      // PAGE'S MAIN WORLD via chrome.scripting.executeScript. Bypasses both
      // (a) isolated-world view-of-window quirks that may make Maxance's
      // jQuery-bound onmouseup handler see a "wrong" event.view, AND
      // (b) the page's CSP which blocked the inline-<script> approach in
      // phase-2f-3. Verified-good pattern from the Chrome MCP javascript_tool
      // which uses this same mechanism under the hood.
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        sendResponse({ kind: 'click.err', error: 'no_sender_tab' });
        return false;
      }
      void chrome.scripting
        .executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (containerId: string) => {
            const c = document.getElementById(containerId);
            if (!c) return { ok: false, error: 'container_not_found' };
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
            return { ok: true };
          },
          args: [message.containerId],
        })
        .then((results) => {
          const r = results[0]?.result as { ok: boolean; error?: string } | undefined;
          if (r?.ok) sendResponse({ kind: 'click.ok' });
          else sendResponse({ kind: 'click.err', error: r?.error ?? 'unknown' });
        })
        .catch((err: unknown) => {
          sendResponse({
            kind: 'click.err',
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    }
    if (message.kind === 'open.mdi-window') {
      // Phase-2g (Courrier reliability): call Proximéo's `mdiWindNet.window`
      // in the page's MAIN world. The content script's isolated-world
      // `window` has no `mdiWindNet`, so the previous iframe.ts helper
      // always threw and fell back to the flaky Envoyer-par click. Routing
      // through chrome.scripting{world:'MAIN'} resolves the real global —
      // same pattern as click.main-world / devis.fill-and-submit-mw.
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        sendResponse({ kind: 'mdi.err', error: 'no_sender_tab' });
        return false;
      }
      void chrome.scripting
        .executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (url: string, popupOptions: string) => {
            const w = window as unknown as {
              mdiWindNet?: { window?: (u: string, cb: unknown, o: string) => void };
            };
            if (!w.mdiWindNet || typeof w.mdiWindNet.window !== 'function') {
              return { ok: false, error: 'mdiWindNet_unavailable' };
            }
            try {
              w.mdiWindNet.window(url, null, popupOptions);
              return { ok: true };
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          },
          args: [message.url, message.popupOptions],
        })
        .then((results) => {
          const r = results[0]?.result as { ok: boolean; error?: string } | undefined;
          if (r?.ok) sendResponse({ kind: 'mdi.ok' });
          else sendResponse({ kind: 'mdi.err', error: r?.error ?? 'unknown' });
        })
        .catch((err: unknown) => {
          sendResponse({
            kind: 'mdi.err',
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    }
    if (message.kind === 'courrier.fill-send-mw') {
      // Phase-2i: fill the Courrier popup's Mail toolbar (Adresse/CC/Objet)
      // and optionally click Envoyer — in MAIN world across ALL frames (the
      // fields live in a nested same-origin frame; func no-ops where absent).
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        sendResponse({ kind: 'courrier.err', error: 'no_sender_tab' });
        return false;
      }
      const payloadJson = JSON.stringify(message.payload);
      void (async () => {
        const log: string[] = [];
        try {
          // Phase 1: fill mailAdresse/mailObjet/[cc] + (if send) click Envoyer
          // = checkMail('mail','MAIL'). NOTE: checkMail only ADVANCES the popup
          // to a "Valider / Annuler" confirmation — it does NOT send yet.
          const r1 = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'MAIN',
            func: (pj: string): { matched: boolean; log: string[] } => {
              const p = JSON.parse(pj) as { to: string; objet: string; cc?: string; send: boolean };
              const out: string[] = [];
              const adr = document.querySelector(
                'input[name="mailAdresse"]',
              ) as HTMLInputElement | null;
              if (!adr) return { matched: false, log: [] };
              const fire = (el: Element, t: string) =>
                el.dispatchEvent(new Event(t, { bubbles: true }));
              const set = (name: string, val: string): boolean => {
                const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
                if (!el) return false;
                el.focus();
                const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                d?.set?.call(el, val);
                fire(el, 'input');
                fire(el, 'change');
                fire(el, 'blur');
                return true;
              };
              out.push('to=' + set('mailAdresse', p.to));
              out.push('objet=' + set('mailObjet', p.objet));
              if (p.cc) out.push('cc=' + set('mailAdresseCC', p.cc));
              if (p.send) {
                const w = window as unknown as { checkMail?: (a: string, b: string) => void };
                if (typeof w.checkMail === 'function') {
                  w.checkMail('mail', 'MAIL');
                  out.push('envoyer=checkMail_called');
                } else {
                  out.push('envoyer=checkMail_unavailable');
                }
              } else {
                out.push('stopped_before_envoyer');
              }
              return { matched: true, log: out };
            },
            args: [payloadJson],
          });
          const hit1 = r1
            .map((r) => r.result as { matched: boolean; log: string[] } | undefined)
            .find((r) => r?.matched);
          if (!hit1) {
            sendResponse({
              kind: 'courrier.ok',
              log: ['no_mailAdresse_frame'],
              filledFrame: false,
              sent: false,
            });
            return;
          }
          log.push(...hit1.log);
          if (!message.payload.send) {
            sendResponse({ kind: 'courrier.ok', log, filledFrame: true, sent: false });
            return;
          }

          // Phase 2 (send only): wait for the "Valider / Annuler" confirmation
          // to render, then click VALIDER — that's the step that actually
          // sends the email (per Ridaa's screenshot: checkMail → Valider).
          await new Promise((res) => setTimeout(res, 3000));
          const r2 = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'MAIN',
            func: (): { here: boolean; clicked: boolean; seen: string[] } => {
              const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
              const cands = Array.from(
                document.querySelectorAll<HTMLElement>(
                  'a, button, input[type=submit], input[type=button], .buttonMiddle, table, [onclick]',
                ),
              );
              const seen = cands
                .map((el) => norm(el.textContent))
                .filter((t) => t && t.length < 24)
                .slice(0, 16);
              // exact "Valider" (NOT "Valider devis"/"Annuler"); prefer a
              // .buttonMiddle, else the element itself.
              const valider = cands.find((el) => norm(el.textContent) === 'Valider');
              if (!valider) return { here: false, clicked: false, seen };
              const target =
                (valider.querySelector('.buttonMiddle') as HTMLElement | null) ?? valider;
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
              return { here: true, clicked: true, seen };
            },
          });
          const hit2 = r2
            .map((r) => r.result as { here: boolean; clicked: boolean; seen: string[] } | undefined)
            .find((r) => r?.here);
          if (hit2?.clicked) {
            log.push('valider=clicked', 'buttons=[' + hit2.seen.join('|') + ']');
            sendResponse({ kind: 'courrier.ok', log, filledFrame: true, sent: true });
          } else {
            const anySeen = r2
              .map((r) => r.result as { seen: string[] } | undefined)
              .find((r) => r?.seen?.length);
            log.push('valider=not_found', 'buttons=[' + (anySeen?.seen ?? []).join('|') + ']');
            sendResponse({ kind: 'courrier.ok', log, filledFrame: true, sent: false });
          }
        } catch (err) {
          sendResponse({
            kind: 'courrier.err',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }
    return false;
  },
);

/** Hold one socket open. Resolves when the socket closes for ANY reason. */
function holdSocket(): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    let sock: WebSocket;
    try {
      sock = new WebSocket(BACKEND_WS_URL);
    } catch (err) {
      resolve({ ok: false, reason: `ws_ctor_failed: ${(err as Error).message}` });
      return;
    }
    liveSocket = sock;

    let opened = false;
    sock.addEventListener('open', () => {
      opened = true;
      void findMaxanceTab().then((tab) => {
        const hello = HelloEventSchema.parse({
          kind: 'hello',
          extensionVersion: extensionVersion(),
          activeMaxanceUrl: tab?.url ?? null,
          capabilities: ['ping', 'forward_flow'],
        });
        sendOnWs(sock, hello);
      });
    });

    sock.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let parsed;
      try {
        parsed = parseFrame(ev.data);
      } catch (err) {
        console.warn('[f16-ext] invalid inbound frame', err);
        return;
      }
      if (parsed.side === 'command') {
        void handleCommand(sock, parsed.value);
      }
    });

    sock.addEventListener('close', () => {
      if (liveSocket === sock) liveSocket = null;
      resolve({ ok: opened, reason: 'ws_closed' });
    });
    sock.addEventListener('error', (ev) => {
      console.warn('[f16-ext] ws error', ev);
      if (liveSocket === sock) liveSocket = null;
      resolve({ ok: false, reason: 'ws_error' });
    });
  });
}

/** Reconnect-forever loop with a module-level lock to prevent re-entry. */
let loopRunning = false;
async function reconnectLoop(): Promise<void> {
  if (loopRunning) return;
  loopRunning = true;
  let attempt = 0;
  try {
    while (true) {
      const result = await holdSocket();
      if (result.ok) attempt = 0;
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000;
      attempt += 1;
      console.warn(`[f16-ext] reconnect in ${delay}ms (reason=${result.reason})`);
      await sleep(delay);
    }
  } finally {
    loopRunning = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

chrome.runtime.onInstalled.addListener(() => void reconnectLoop());
chrome.runtime.onStartup.addListener(() => void reconnectLoop());
void reconnectLoop();
