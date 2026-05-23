/**
 * MV3 service worker — F16 Maxance driver (phase 2 scaffold).
 *
 * Responsibilities (V1 scope):
 *   1. Maintain a persistent outbound WebSocket to ws://127.0.0.1:9223
 *      (backend's extension-client.ts, landing in phase 2c). Reconnect with
 *      exponential backoff if it drops; MV3 service workers can be torn down
 *      and respawned by Chrome at any time, so the reconnect MUST be idempotent.
 *   2. On connect, send a `hello` event with extension version + the active
 *      Maxance tab URL (if any).
 *   3. Route inbound `Command` frames to the appropriate flow handler.
 *      Phase 2b lands the actual handlers (`login.ensure`, `quote.preview`,
 *      `quote.confirm`); this scaffold answers `ping` and replies with a
 *      stub error for everything else so backend integration is testable
 *      end-to-end without the flows being implemented yet.
 *
 * What is NOT in this scaffold:
 *   - Real flow implementations (login / quote-preview / quote-confirm)
 *     — those need the content script's DOM-driver layer first.
 *   - Tab targeting heuristics (which Maxance tab to drive when there are
 *     multiple) — phase 2b.
 *   - Auth on the WebSocket — phase 2c adds an HMAC handshake matching the
 *     STAGEHAND_HMAC_SECRET pattern.
 */
import {
  parseFrame,
  type Command,
  type Event,
  type Response,
  PongResponseSchema,
  ErrorResponseSchema,
  HelloEventSchema,
} from './wire.js';

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
 * Find the currently-active Maxance tab, if any. Used to populate the `hello`
 * event so the backend knows which tab the extension will drive when there
 * are multiple Maxance tabs open.
 */
async function activeMaxanceUrl(): Promise<string | null> {
  const tabs = await chrome.tabs.query({
    url: ['https://www.maxance.com/*', 'https://extranet.maxance.com/*'],
  });
  const active = tabs.find((t) => t.active);
  return active?.url ?? tabs[0]?.url ?? null;
}

/**
 * Send a parsed wire frame. No-ops silently if the socket is not OPEN —
 * the backend MUST tolerate dropped status frames.
 */
function send(sock: WebSocket, frame: Response | Event): void {
  if (sock.readyState !== WebSocket.OPEN) return;
  try {
    sock.send(JSON.stringify(frame));
  } catch (err) {
    console.warn('[f16-ext] send failed', err);
  }
}

/**
 * Route an inbound command and send the response back. Scaffold version:
 *   - `ping` → reply with pong (proves the round-trip + Zod validation works)
 *   - everything else → reply with a tagged
 *     maxance_extension_handler_not_implemented error so the backend's
 *     QUOTE.FAILED routing can be wired today and start swapping in real
 *     handlers later.
 */
function handleCommand(sock: WebSocket, cmd: Command): void {
  if (cmd.kind === 'ping') {
    const pong = PongResponseSchema.parse({
      id: cmd.id,
      kind: 'pong',
      ...(cmd.nonce !== undefined ? { nonce: cmd.nonce } : {}),
    });
    send(sock, pong);
    return;
  }
  const err = ErrorResponseSchema.parse({
    id: cmd.id,
    kind: 'error',
    errorCode: 'maxance_extension_handler_not_implemented',
    detail: `phase 2b will implement: ${cmd.kind}`,
  });
  send(sock, err);
}

/**
 * Hold one socket open. Resolves when the socket closes for ANY reason — the
 * caller treats that as "time to back off and reconnect". Resolves
 * immediately on a synchronous constructor error too.
 *
 * Concurrency: relies on no more than one outstanding socket at a time.
 * The reconnect loop awaits this before opening another.
 */
function holdSocket(): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    let sock: WebSocket;
    try {
      sock = new WebSocket(BACKEND_WS_URL);
    } catch (err) {
      resolve({ ok: false, reason: `ws_ctor_failed: ${(err as Error).message}` });
      return;
    }

    let opened = false;
    sock.addEventListener('open', () => {
      opened = true;
      void activeMaxanceUrl().then((url) => {
        const hello = HelloEventSchema.parse({
          kind: 'hello',
          extensionVersion: extensionVersion(),
          activeMaxanceUrl: url,
          capabilities: ['ping'],
        });
        send(sock, hello);
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
        handleCommand(sock, parsed.value);
      }
      // Responses + events from the backend are not part of V1 — backend
      // never sends those to the extension. Ignore.
    });

    sock.addEventListener('close', () => {
      resolve({ ok: opened, reason: 'ws_closed' });
    });

    sock.addEventListener('error', (ev) => {
      console.warn('[f16-ext] ws error', ev);
      resolve({ ok: false, reason: 'ws_error' });
    });
  });
}

/**
 * Reconnect-forever loop. The SW may be torn down by Chrome between events —
 * re-running this loop on every `chrome.runtime.onStartup` /
 * `chrome.runtime.onInstalled` is the standard MV3 idiom. A module-level
 * lock prevents two loops from running if both listeners fire.
 */
let loopRunning = false;

async function reconnectLoop(): Promise<void> {
  if (loopRunning) return;
  loopRunning = true;
  let attempt = 0;
  try {
    while (true) {
      const result = await holdSocket();
      if (result.ok) {
        // We had a successful open + clean close — reset backoff.
        attempt = 0;
      }
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

// Boot. MV3 fires onInstalled once on install/update; onStartup fires every
// browser launch. The bare void call below catches SW resurrection.
chrome.runtime.onInstalled.addListener(() => {
  void reconnectLoop();
});
chrome.runtime.onStartup.addListener(() => {
  void reconnectLoop();
});
void reconnectLoop();
