/**
 * Content script — runs in every Maxance tab (matches in manifest.json).
 *
 * Phase 2 scaffold: this file exists so the manifest's content_scripts
 * declaration has a target, and so the SW can later `chrome.scripting.executeScript`
 * its DOM-driver functions into the page when commands arrive. The actual DOM
 * flows (login, quote-preview, quote-confirm) land in phase 2b.
 *
 * For now: a no-op that just logs presence + exposes a `window.__f16_marker`
 * sentinel so end-to-end tests can verify the script reached the page.
 */
(() => {
  console.info('[f16-ext] content script loaded on', location.href);
  // Lightweight marker for end-to-end checks. NOT a public API — production
  // commands route via chrome.runtime.sendMessage from the SW, not via this.
  (window as unknown as { __f16_marker?: { version: string; ts: number } }).__f16_marker = {
    version: chrome.runtime.getManifest().version ?? '0.0.0',
    ts: Date.now(),
  };
})();
