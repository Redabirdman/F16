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
    return orchestrateNavigatingFlow(tabId, command);
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
    _sender,
    sendResponse: (resp: ScreenshotResponse | { ok: true }) => void,
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
