/**
 * Content script entry — registered in manifest.json for *.maxance.com.
 *
 * Receives FlowInvocation messages from the background SW, dispatches to
 * the matching flow handler, returns a wire `Response` envelope back via
 * chrome.runtime.sendMessage.
 *
 * The actual flow logic (login.ensure / quote.preview / quote.confirm)
 * lives in `./flows/*.ts` — landing in M8.T8 phase 2b commit C. This file
 * is the routing skeleton.
 */
import { ErrorResponseSchema, type Command, type Response } from './wire.js';
import type { ContentInbound, FlowOutcome } from './content-protocol.js';
import { MAINTENANCE_ERROR_CODE, isMaintenancePage } from './flows/maintenance.js';
import { runLoginEnsure } from './flows/login.js';
import { runQuotePreview } from './flows/quote-preview.js';
import { runQuoteConfirm } from './flows/quote-confirm.js';
import { runDevisResume } from './flows/devis-resume.js';
import { runSubscriptionComplete } from './flows/subscription.js';

console.info('[f16-ext] content script loaded on', location.href);

// Lightweight marker for end-to-end checks. NOT a public API — production
// commands route via chrome.runtime.onMessage from the SW, not via this.
(window as unknown as { __f16_marker?: { version: string; ts: number } }).__f16_marker = {
  version: chrome.runtime.getManifest().version ?? '0.0.0',
  ts: Date.now(),
};

/**
 * Dispatch a Command to the matching flow handler and produce a wire
 * Response. Wraps every flow in a uniform error handler so the SW always
 * receives a well-formed Response (no thrown promises crossing the
 * runtime.sendMessage boundary).
 */
async function handleFlow(command: Command): Promise<Response> {
  try {
    // 2026-07-06 self-heal: Maxance serves a maintenance page while the
    // portal is closed (nights + weekends) or during real downtime. Every
    // flow would only fail with a misleading DOM-wait timeout — detect it
    // up front and return the tagged `maxance_maintenance` error instead.
    // The SW reloads the tab once and retries (stale overnight tab); if it
    // persists, the backend PARKS the quote rather than failing it.
    if (command.kind !== 'ping' && isMaintenancePage()) {
      console.warn('[f16-ext] maintenance page detected on', location.href);
      return ErrorResponseSchema.parse({
        id: command.id,
        kind: 'error',
        errorCode: MAINTENANCE_ERROR_CODE,
        detail: `Maxance maintenance page at ${location.href}`.slice(0, 240),
      });
    }
    switch (command.kind) {
      case 'ping':
        // SW handles ping itself — content script shouldn't see this.
        return ErrorResponseSchema.parse({
          id: command.id,
          kind: 'error',
          errorCode: 'maxance_extension_ping_routed_to_content',
          detail: 'ping commands must be handled by the SW',
        });
      case 'login.ensure':
        return await runLoginEnsure(command);
      case 'quote.preview':
        return await runQuotePreview(command);
      case 'quote.confirm':
        return await runQuoteConfirm(command);
      case 'devis.resume':
        return await runDevisResume(command);
      case 'subscription.complete':
        return await runSubscriptionComplete(command);
    }
  } catch (err) {
    return ErrorResponseSchema.parse({
      id: command.id,
      kind: 'error',
      errorCode: 'maxance_extension_unexpected_error',
      detail: err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240),
    });
  }
}

chrome.runtime.onMessage.addListener(
  (message: ContentInbound, _sender, sendResponse: (resp: FlowOutcome) => void) => {
    if (message.kind !== 'flow') return false;
    // Run async work, send response when done. Returning true keeps the
    // message channel open until sendResponse fires.
    void handleFlow(message.command).then((response) => {
      sendResponse({ kind: 'flow.result', response });
    });
    return true;
  },
);
