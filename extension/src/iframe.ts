/**
 * Same-origin iframe helpers. The M8.T6 Courrier popup (#window_nvCourrier)
 * is a nested iframe — the live investigation (M8.T8) proved
 * `iframe.contentDocument.querySelector(...)` works from the parent. This
 * module wraps that pattern with the same wait/find idioms as `dom.ts`.
 *
 * No coordinate clicks. No chrome.debugger. Just standard DOM traversal
 * through `contentDocument`.
 */
import { DEFAULT_TIMEOUT_MS, isVisible, sleep } from './dom.js';

const POLL_INTERVAL_MS = 200;

/**
 * Wait until the iframe at `iframeId` has a contentDocument with non-empty
 * body content. mdiWindNet popups render asynchronously — the iframe
 * element appears in the DOM before the actual page loads inside it.
 */
export async function waitForIframeReady(
  iframeId: string,
  opts: { timeoutMs?: number; minBodyTextLength?: number; label?: string } = {},
): Promise<HTMLIFrameElement> {
  const label = opts.label ?? iframeId;
  const minLen = opts.minBodyTextLength ?? 1;
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const f = document.getElementById(iframeId);
    if (f instanceof HTMLIFrameElement && isVisible(f)) {
      try {
        const doc = f.contentDocument;
        const text = doc?.body?.innerText ?? '';
        if (text.trim().length >= minLen) return f;
      } catch {
        /* cross-origin or not ready — keep polling */
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`maxance_iframe_not_ready:${label}`);
}

/**
 * Query a selector inside an iframe's contentDocument. Returns null if the
 * iframe isn't accessible or the selector doesn't match. Caller wraps in a
 * waitFor for retry semantics.
 */
export function iframeQuerySelector<T extends Element = HTMLElement>(
  iframeId: string,
  selector: string,
): T | null {
  const f = document.getElementById(iframeId);
  if (!(f instanceof HTMLIFrameElement)) return null;
  try {
    return f.contentDocument?.querySelector<T>(selector) ?? null;
  } catch {
    return null;
  }
}

/** Same as `iframeQuerySelector`, but returns all matches. */
export function iframeQuerySelectorAll<T extends Element = HTMLElement>(
  iframeId: string,
  selector: string,
): T[] {
  const f = document.getElementById(iframeId);
  if (!(f instanceof HTMLIFrameElement)) return [];
  try {
    return Array.from(f.contentDocument?.querySelectorAll<T>(selector) ?? []);
  } catch {
    return [];
  }
}

/**
 * Wait for an element inside the iframe matching the predicate.
 * `predicate` runs against the iframe's contentDocument once it's ready.
 */
export async function waitForIframeElement<T extends Element = HTMLElement>(
  iframeId: string,
  predicate: (doc: Document) => T | null,
  opts: { timeoutMs?: number; label: string },
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const f = document.getElementById(iframeId);
    if (f instanceof HTMLIFrameElement) {
      try {
        const doc = f.contentDocument;
        if (doc) {
          const found = predicate(doc);
          if (found) return found;
        }
      } catch {
        /* keep polling */
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`maxance_iframe_element_missing:${opts.label}`);
}

/**
 * mdiWindNet.window() — programmatically open a Maxance MDI popup. Used by
 * the M8.T6 confirm flow to open the Courrier popup without clicking the
 * [Envoyer par...] button (deterministic + skip-able UI noise).
 *
 * The function is exposed on `window.mdiWindNet` by Proximéo's host JS.
 * Returns void; the popup opens asynchronously and the caller awaits
 * waitForIframeReady on the corresponding `#window_<id>` iframe.
 */
export function openMdiWindow(url: string, popupOptions: string): void {
  const w = window as unknown as {
    mdiWindNet?: {
      window?: (url: string, callback: unknown, opts: string) => void;
    };
  };
  if (!w.mdiWindNet || typeof w.mdiWindNet.window !== 'function') {
    throw new Error('maxance_iframe_mdiWindNet_unavailable');
  }
  w.mdiWindNet.window(url, null, popupOptions);
}
