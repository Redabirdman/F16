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

/**
 * Content → SW: "run the VERIFIED staged devis-email send in the Courrier
 * composer — MAIN world, SW-orchestrated" (2026-07-02 root-cause fix).
 *
 * Live-mapped sequence (manual browser walkthrough, devis DR0000983186):
 *   A. Await the composer frame (window.name==='impressionDR') to render the
 *      Mail toolbar (`mailAdresse`) AND the generated letter. If a Maxance
 *      ALERTE popin is up instead (e.g. "ne peut être généré pour un devis
 *      d'une branche différente" = the session's current instance is NOT this
 *      devis), fail with a tagged error — never blind-send.
 *   B. Fill `mailAdresse` / `mailObjet` in that frame.
 *   C. Call the frame's own `checkMail('mail','MAIL')` (= the Envoyer button).
 *   D. Await the "Mail : [Valider][Annuler]" CONFIRMATION stage in the SAME
 *      frame, then click its exact-'Valider' button. (The old flow clicked
 *      any 'Valider' without awaiting this stage — that hit the letter-editor
 *      form submit and reported a fake `sent=true`.)
 *   E. Verify the frame navigated to `mail.do` — the server-side send action.
 *      Only then is `sent:true` returned.
 */
export interface CourrierStagedSendRequest {
  kind: 'courrier.staged-send-mw';
  payload: {
    to: string;
    objet: string;
  };
}

/** SW → content: outcome of the staged Courrier send. */
export type CourrierStagedSendResponse =
  | { kind: 'courrier.staged.ok'; log: string[]; sent: boolean }
  | { kind: 'courrier.staged.err'; log: string[]; error: string };

/**
 * Content → SW: "apply the Garanties closing controls — formule radio,
 * commission %, fractionnement — in the page's MAIN world" (M8.T7 B1).
 *
 * All three controls are Maxance framework widgets whose inline handlers
 * (`submitFormule()`, the generated commission onblur, the fractionnement
 * `doSubmitFormCustomWithCacheAJAX` onchange) each fire an AJAX re-render
 * (~5-6s, "Chargement" indicator in the body text while in-flight). The SW
 * orchestrates the steps sequentially — set control → wait for the
 * re-render to clear — using the same multi-step main-world pattern as
 * devis.fill-and-submit-mw (one self-contained sync func per step, sleeps
 * owned by the SW). Codes are pre-mapped by the content script from the
 * canonical selectors module (FORMULE_CODE / FRACTIONNEMENT_CODE).
 */
export interface GarantiesConfigureRequest {
  kind: 'garanties.configure-mw';
  payload: {
    /** Maxance radio value (NV10/NV20/NV30). Absent = leave as rendered. */
    formuleCode?: 'NV10' | 'NV20' | 'NV30';
    /** Target commission % — already clamped by the caller (9..22). */
    commissionPct: number;
    /** Fractionnement option value (M/A). Absent = leave as rendered. */
    fractionnementCode?: 'M' | 'A';
    /**
     * Garanties-additionnelles checkboxes to ENSURE TICKED (2026-07-02,
     * Achraf's pack — quote.confirm only). Absent/false = never touched.
     * The checkbox inputs carry framework-generated names, so the handler
     * anchors on the row text (Assistance Mobilité / Garantie Personnelle
     * du Conducteur) instead of a selector.
     */
    assistance?: boolean;
    garantiePersonnelle?: boolean;
  };
}

/** SW → content: outcome of the main-world Garanties configuration. */
export type GarantiesConfigureResponse =
  | { kind: 'garanties.ok'; log: string[]; finalCommission: string }
  | { kind: 'garanties.err'; log: string[]; error: string };

/**
 * Content → SW: "search a devis by number in the ACCES PORTEFEUILLE bar and
 * submit — in the page's MAIN world" (M8.T7 B2).
 *
 * The criterion select (`critereSelected`=NO), the value input
 * (`#valeurCritere`), and the search anchor (`#mainSearchLink`, whose href is
 * `javascript:doSubmit(...)`) are all Maxance framework widgets — set the
 * select + input, then dispatch a real click on the anchor in MAIN world so
 * the inline `doSubmit` navigates the top frame to the "Visualisation du
 * devis" dossier page. Same proven path as click.main-world.
 */
export interface RepriseSearchRequest {
  kind: 'reprise.search-mw';
  /** Devis number to look up (e.g. "DR0000976146"). */
  devisNumber: string;
}

/** SW → content: outcome of the main-world devis search submit. */
export type RepriseSearchResponse =
  | { kind: 'reprise.search.ok'; log: string[] }
  | { kind: 'reprise.search.err'; log: string[]; error: string };

/**
 * Content → SW: "call `doSubmit('repriseDevisMoto.do')` in the page's MAIN
 * world" (M8.T7 B2). No params — the devis is already in the Maxance session
 * after the search lands on the Visualisation page. Navigates the top frame
 * to the resumed VÉHICULE tab. Routed through MAIN world because `doSubmit`
 * is a page-global Proximéo function.
 */
export interface RepriseSubmitRequest {
  kind: 'reprise.submit-mw';
  /** Reprise action path (e.g. "repriseDevisMoto.do"). */
  repriseDo: string;
}

/** SW → content: outcome of the main-world reprise submit. */
export type RepriseSubmitResponse =
  | { kind: 'reprise.submit.ok'; log: string[] }
  | { kind: 'reprise.submit.err'; log: string[]; error: string };

/* ────────────────────────────────────────────────────────────────────────── */
/*  Subscription (M8.T7 B3) — souscription closing steps (MAIN world)          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Content → SW: "fill the N° de série on the Infos complémentaires page in
 * MAIN world" (M8.T7 B3). The serial is a non-PII placeholder ("1234567");
 * immatriculation is intentionally left empty. The Suivant button afterwards
 * reuses the existing `click.main-world` path (`#validerSouscription`
 * container, `.buttonMiddle` "Suivant >>").
 */
export interface SubscriptionInfosComplRequest {
  kind: 'subscription.infos-compl-mw';
  serialNumber: string;
}

/** SW → content: outcome of the Infos complémentaires serial fill. */
export type SubscriptionInfosComplResponse =
  | { kind: 'subscription.infos.ok'; log: string[] }
  | { kind: 'subscription.infos.err'; log: string[]; error: string };

/**
 * Content → SW: "fill the Coordonnées + bancaires page in MAIN world"
 * (M8.T7 B3). Drives, in order owned by the SW (so it can wait for the
 * commune-lookup AJAX between steps):
 *   1. type the commune into `souscripteurNaissanceZonier.rechercheCommune`
 *      and CLICK its row search link (img search.gif) → INSEE lookup AJAX,
 *   2. (SW waits) select `souscripteurNaissanceZonier.key` whose value starts
 *      with the matching INSEE,
 *   3. split the IBAN across `#ibanPart0..6`, set BIC + Titulaire, verify the
 *      jour de prélèvement default, check "Je dispose du comptant", and read
 *      the "Comptant à régler" block + `ErrorMessage()`.
 *
 * IBAN/BIC are PII — they appear ONLY inside the MAIN-world func args, never
 * in the returned `log` (which carries set/missing booleans only).
 */
export interface SubscriptionBancairesRequest {
  kind: 'subscription.bancaires-mw';
  payload: {
    birthPlaceCity: string;
    /** Full IBAN, already normalised (no spaces) by the caller. */
    iban: string;
    bic: string;
    accountHolder: string;
  };
}

/** SW → content: outcome of the bancaires fill (+ parsed comptant + validation). */
export type SubscriptionBancairesResponse =
  | {
      kind: 'subscription.bancaires.ok';
      log: string[];
      /** Raw "Comptant à régler" body text for the flow to parse. */
      comptantText: string;
      /** Non-empty ErrorMessage() output = required-field failure. */
      errorMessage: string;
    }
  | { kind: 'subscription.bancaires.err'; log: string[]; error: string };

/**
 * Content → SW: "submit the final Valider on the bancaires page in MAIN world"
 * (M8.T7 B3, the destructive submit). Sets `window.confirm = () => true`
 * (native fallback), calls
 * `doSubmitConfirm('SouscriptionContratVehiculeForm', validerFinaleDo,
 * window.labelAN)`, then — if a ConstructConfirmInfo CONFIRMATION popin
 * appears — clicks its 'Valider'. NEVER calls `doSubmitForm` directly
 * (→ "Erreur applicative").
 */
export interface SubscriptionValiderFinaleRequest {
  kind: 'subscription.valider-finale-mw';
  validerFinaleDo: string;
}

/** SW → content: outcome of the final Valider submit. */
export type SubscriptionValiderFinaleResponse =
  | { kind: 'subscription.valider.ok'; log: string[]; popinClicked: boolean }
  | { kind: 'subscription.valider.err'; log: string[]; error: string };

/** All possible inbound messages on the SW side. */
export type SwInbound =
  | FlowOutcome
  | ScreenshotRequest
  | ProgressForward
  | MainWorldClickRequest
  | ContactWidgetNouveauRequest
  | DevisFillAndSubmitRequest
  | OpenMdiWindowRequest
  | CourrierFillSendRequest
  | CourrierStagedSendRequest
  | GarantiesConfigureRequest
  | RepriseSearchRequest
  | RepriseSubmitRequest
  | SubscriptionInfosComplRequest
  | SubscriptionBancairesRequest
  | SubscriptionValiderFinaleRequest;

/** All possible inbound messages on the content-script side. */
export type ContentInbound = FlowInvocation;
