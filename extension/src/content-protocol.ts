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

/**
 * Content → SW: "fill the Devis subscriber form + commit phone/email
 * widgets via Nouveau + click OK — ALL in the page's main JS world".
 *
 * Phase-2d-confirm-6 (2026-05-25 PM): the isolated-world content-script
 * field-setting path consistently produced "Un problème technique" on
 * OK submit even when form_dump showed every field correctly populated
 * AND contactList[0] entries existed. A direct main-world MCP-driven
 * run with the EXACT SAME operations succeeded (DR0000973635). The
 * remaining suspect: Maxance's framework caches form state in main-
 * world JS variables on each onchange, and isolated-world dispatch
 * doesn't always update those caches reliably. Routing the entire
 * Devis form sequence through chrome.scripting{world:'MAIN'} eliminates
 * the boundary.
 */
export interface DevisFillAndSubmitRequest {
  kind: 'devis.fill-and-submit-mw';
  payload: {
    lastName: string;
    firstName: string;
    addressLine: string;
    addressComplement?: string;
    phoneType: string;
    phoneUsage: string;
    phoneNumero: string;
    emailUsage: string;
    email: string;
  };
}

/** SW → content: outcome of the main-world Devis fill+OK. */
export type DevisFillAndSubmitResponse =
  | { kind: 'devis.ok'; log: string[] }
  | { kind: 'devis.err'; log: string[]; error: string; errorMsg?: string };

/**
 * Content → SW: "open a Maxance MDI popup via mdiWindNet.window() in the
 * page's MAIN world".
 *
 * Phase-2g (Courrier reliability): `mdiWindNet` is a PAGE main-world global
 * (set by Proximéo's host JS). The content script runs in the ISOLATED
 * world (manifest content_scripts has no `world:'MAIN'`), so the earlier
 * `openMdiWindow()` helper in iframe.ts — which read `window.mdiWindNet`
 * from the isolated world — found it `undefined` on EVERY call, threw
 * `maxance_iframe_mdiWindNet_unavailable`, and silently fell back to the
 * flaky `clickByText('Envoyer par...')`. That fallback is the documented
 * source of the `maxance_iframe_not_ready:courrier_popup_ready` timeouts.
 * Routing the `mdiWindNet.window(url, null, opts)` call through
 * chrome.scripting.executeScript({world:'MAIN'}) — the same proven path as
 * click.main-world / devis.fill-and-submit-mw — lets it resolve against the
 * page's real `mdiWindNet`. Same-origin iframe `contentDocument` reads
 * (waitForIframeReady) stay in the content script: they work cross-world
 * for same-origin frames.
 */
export interface OpenMdiWindowRequest {
  kind: 'open.mdi-window';
  url: string;
  popupOptions: string;
}

/** SW → content: outcome of the main-world mdiWindNet.window() open. */
export type OpenMdiWindowResponse = { kind: 'mdi.ok' } | { kind: 'mdi.err'; error: string };

/**
 * Content → SW: "fill the Courrier email toolbar (Adresse/CC/Objet) and
 * optionally click Envoyer — in the page's MAIN world, across ALL frames".
 *
 * Phase-2i (2026-06-03, corrected path per Ridaa's screenshots): the devis
 * email is sent from the "Envoyer par…" (Devis moto) Courrier popup
 * (`id:impressionDR`), which has the devis PDF auto-attached + a Mail
 * toolbar with inputs `mailAdresse` (To, empty), `mailAdresseCC` (CC),
 * `mailObjet`, and an Envoyer button = `checkMail('mail','MAIL')`. Those
 * fields live in a NESTED same-origin frame; the Maxance framework tracks
 * them in MAIN-world JS, so we fill + send via
 * chrome.scripting.executeScript({allFrames:true, world:'MAIN'}) and the
 * func no-ops in frames that lack `mailAdresse`. `send` is gated: false in
 * dryRun (fill + STOP before Envoyer), true only for a real send.
 */
export interface CourrierFillSendRequest {
  kind: 'courrier.fill-send-mw';
  payload: {
    to: string;
    objet: string;
    cc?: string;
    send: boolean;
  };
}

/** SW → content: outcome of the main-world Courrier fill (+ optional send). */
export type CourrierFillSendResponse =
  | { kind: 'courrier.ok'; log: string[]; filledFrame: boolean; sent: boolean }
  | { kind: 'courrier.err'; error: string };

/** All possible inbound messages on the SW side. */
export type SwInbound =
  | FlowOutcome
  | ScreenshotRequest
  | ProgressForward
  | MainWorldClickRequest
  | ContactWidgetNouveauRequest
  | DevisFillAndSubmitRequest
  | OpenMdiWindowRequest
  | CourrierFillSendRequest;

/** All possible inbound messages on the content-script side. */
export type ContentInbound = FlowInvocation;
