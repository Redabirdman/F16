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
  // `ping` is handled directly by the SW (never reaches forwardToContent),
  // but TypeScript narrows the union here — only the three flow commands
  // carry a `timeoutMs` field. Read it via a small helper.
  const cmdTimeout = 'timeoutMs' in command ? command.timeoutMs : undefined;
  const outerTimeoutMs = (cmdTimeout ?? 60_000) + 30_000; // small margin over the flow's own budget
  const envelope: ContentInbound = { kind: 'flow', command };
  try {
    const result = await raceWithTimeout(
      chrome.tabs.sendMessage<ContentInbound, FlowOutcome>(tab.id, envelope),
      outerTimeoutMs,
    );
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
