/**
 * Internal message protocol — service worker ↔ content script.
 *
 * Distinct from the WS wire (src/wire.ts) which is the backend ↔ extension
 * boundary. This file is only seen inside the extension process.
 *
 * Flow:
 *   1. SW receives a `Command` from the backend over WS.
 *   2. SW finds the active Maxance tab and `chrome.tabs.sendMessage` with
 *      a `FlowInvocation` envelope.
 *   3. Content script's onMessage listener picks it up, dispatches to the
 *      matching flow handler, and sends back a `FlowOutcome` containing a
 *      wire-shape `Response`.
 *   4. SW forwards the `Response` straight to the backend WS.
 *
 * Two side-channels:
 *   - `capture_screenshot` — content asks SW to call
 *     chrome.tabs.captureVisibleTab + return the dataUrl.
 *   - `progress` — content asks SW to forward a `ProgressEvent` to the
 *     backend WS (so the operator UI can stream "tab N of 3" updates).
 */
import type { Command, Response } from './wire.js';

/** SW → content: "drive this flow". */
export interface FlowInvocation {
  kind: 'flow';
  command: Command;
}

/** Content → SW: "flow done, here's the wire Response". */
export interface FlowOutcome {
  kind: 'flow.result';
  response: Response;
}

/** Content → SW: "capture a screenshot of the visible viewport". */
export interface ScreenshotRequest {
  kind: 'capture_screenshot';
}

/** SW → content (response to above): the dataUrl, or an error. */
export type ScreenshotResponse =
  | { kind: 'capture.ok'; dataUrl: string }
  | { kind: 'capture.err'; error: string };

/** Content → SW: "forward this progress event to the backend WS". */
export interface ProgressForward {
  kind: 'progress.forward';
  commandId: string;
  step: string;
  detail?: string;
}

/**
 * Content → SW: "dispatch a real mouse click on the .buttonMiddle inside
 * #<containerId> in the page's main world". Lets the extension reach
 * framework handlers that reject events originating from the content
 * script's isolated world OR whose dispatch is blocked by the page's CSP.
 */
export interface MainWorldClickRequest {
  kind: 'click.main-world';
  containerId: string;
}

/**
 * Content → SW: "click the Nouveau (add) image inside the same <fieldset>
 * as the given form element name". Used for Maxance's contact-list widgets
 * (phone + email on the Devis tab) where `currentContact.*` is a DRAFT that
 * must be explicitly committed to `contactList[]` via the green "+"-style
 * "Nouveau" img before any form submit. Inline onclick:
 *   doSubmitFormWithCheckCustomAJAX('SouscriptionContratVehiculeForm',
 *     'ajouterContactBean.do?formName=…&beanName=<bean>', '<zone>');
 * The function reads currentContact, validates form via ErrorMessage(),
 * and if clean issues an AJAX add that promotes currentContact to
 * contactList[0] + clears the draft inputs. Routed through main world
 * (same path as click.main-world) so the inline JS executes with the
 * page's window references.
 */
export interface ContactWidgetNouveauRequest {
  kind: 'click.contact-nouveau';
  /** Stable input name within the target fieldset (e.g.
   *  "telephoneListBean.currentContact.type" or
   *  "emailListBean.currentContact.usage"). The SW walks
   *  input.closest('fieldset').querySelector('img[alt="Nouveau"]'). */
  withinFieldsetOfInputName: string;
}

/** SW → content: outcome of the main-world click attempt. */
export type MainWorldClickResponse = { kind: 'click.ok' } | { kind: 'click.err'; error: string };

/** All possible inbound messages on the SW side. */
export type SwInbound =
  | FlowOutcome
  | ScreenshotRequest
  | ProgressForward
  | MainWorldClickRequest
  | ContactWidgetNouveauRequest;

/** All possible inbound messages on the content-script side. */
export type ContentInbound = FlowInvocation;
