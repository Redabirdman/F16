/**
 * Popup UI logic. Shown when the user clicks the extension icon in the
 * Chrome toolbar. Read-only — surfaces current driver state from the SW.
 *
 * Phase 2 scaffold: just shows version + the active Maxance tab URL +
 * backend WS status. Phase 2b will add a "trigger test ping" button + an
 * inline log of the last few commands the SW handled.
 */

interface StatusEls {
  backend: HTMLElement;
  tab: HTMLElement;
  version: HTMLElement;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`popup: #${id} not in DOM`);
  return el;
}

function setDot(el: HTMLElement, on: boolean, text: string): void {
  el.innerHTML = `<span class="dot ${on ? 'dot-on' : 'dot-off'}"></span>${text}`;
}

async function findActiveMaxance(): Promise<string | null> {
  const tabs = await chrome.tabs.query({
    url: ['https://www.maxance.com/*', 'https://extranet.maxance.com/*'],
  });
  const active = tabs.find((t) => t.active);
  return active?.url ?? tabs[0]?.url ?? null;
}

async function render(els: StatusEls): Promise<void> {
  els.version.textContent = chrome.runtime.getManifest().version ?? '?';

  const url = await findActiveMaxance();
  setDot(els.tab, url !== null, url ? new URL(url).pathname.slice(0, 36) : 'no Maxance tab open');

  // Backend status: phase 2c will expose this via chrome.runtime.sendMessage
  // back to the SW; today we just probe by opening a one-shot WebSocket and
  // checking it opens within 1s.
  try {
    const ok = await probeBackend();
    setDot(els.backend, ok, ok ? 'connected (ws://127.0.0.1:9223)' : 'unreachable');
  } catch (err) {
    setDot(els.backend, false, `error: ${(err as Error).message.slice(0, 24)}`);
  }
}

function probeBackend(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let sock: WebSocket;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        sock?.close();
      } catch {
        /* noop */
      }
      resolve(ok);
    };
    try {
      sock = new WebSocket('ws://127.0.0.1:9223');
    } catch {
      finish(false);
      return;
    }
    sock.addEventListener('open', () => finish(true));
    sock.addEventListener('error', () => finish(false));
    sock.addEventListener('close', () => finish(false));
    setTimeout(() => finish(false), 1_000);
  });
}

void render({
  backend: $('backend-status'),
  tab: $('maxance-tab'),
  version: $('version'),
});
