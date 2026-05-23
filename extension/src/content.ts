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
import { runLoginEnsure } from './flows/login.js';
import { runQuotePreview } from './flows/quote-preview.js';
import { runQuoteConfirm } from './flows/quote-confirm.js';

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
