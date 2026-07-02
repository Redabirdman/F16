/**
 * quote.confirm flow — V1 Chrome-extension Maxance driver. **M8 COMPLETE,
 * live-verified 2026-06-03** (real devis emailed to the customer with PDF).
 *
 * Pre-condition: caller has just received a successful QuotePreviewOk on the
 * same tab — we're on the Garanties tab with a price.
 *
 * Flow (SW orchestrates across the top-frame navigations):
 *   1. devis_tab_pre  → click "Valider devis" (clickMaxanceButton, main-world
 *      mouse-event dispatch) → navigates to the Devis form.
 *   2. devis_form_open → fill the whole Devis subscriber form + commit the
 *      phone/email contact widgets + click OK, all in ONE main-world bundle
 *      (devisFillAndSubmitMainWorld) → navigates to Edition à imprimer.
 *   3. edition_imprimer → extract devisNumber. Then deliver the devis email:
 *        a. openDevisMotoCourrier(): replay the edition page's OWN
 *           "Envoyer par… (Devis moto)" onclick (id:impressionDR) via
 *           main-world mdiWindNet → opens the Courrier popup (devis PDF
 *           AUTO-ATTACHED) + a Mail toolbar (Adresse=To / CC / Objet).
 *        b. courrierFillAndSend(): fill mailAdresse=customer email + mailObjet;
 *           dryRun → STOP; real-mode → checkMail('mail','MAIL') (Envoyer)
 *           THEN click "Valider" (the 2-phase send — Envoyer only opens a
 *           confirmation; Valider actually sends).
 *
 * Self-healing (phase-2j): on any flow error, AND after every quote.confirm,
 * the SW resets the Maxance tab to a clean Proximéo home so the next run
 * starts fresh with no manual refresh (see background.ts resetMaxanceTabToHome).
 *
 * Key gotchas (all live-confirmed): Maxance framework buttons/fields need
 * MAIN-world dispatch (chrome.scripting{world:'MAIN'}); esbuild keepNames
 * MUST be false; reusing identical subscriber data trips "Ce contact existe
 * déjà" (use unique data for tests; handle gracefully for repeat customers).
 */
import {
  CIVILITE_VALUE,
  COURRIER_POPUP_URL_PATH,
  EMAIL_ROLE_GESTION,
  PHONE_TYPE_MOBILE,
  PHONE_USAGE_PERSO,
  PROFESSION_VALUE,
  PROXIMEO_URL_SIGNATURES,
} from '../maxance/selectors.js';
import {
  captureScreenshot,
  clickMaxanceButton,
  courrierFillAndSend,
  devisFillAndSubmitMainWorld,
  fillByLabel,
  setSelectByLabel,
  sleep,
  waitFor,
} from '../dom.js';
import { openMdiWindowMainWorld } from '../iframe.js';
import {
  type QuoteConfirmCommandSchema,
  QuoteConfirmResponseSchema,
  QuoteConfirmNavigatingResponseSchema,
  ErrorResponseSchema,
  type Response,
  type Screenshot,
} from '../wire.js';
import { reportProgress } from './progress.js';
import { CONTACT_DUPLICATE_ERROR } from './contact-duplicate.js';
import { GarantiesNavigatedError, applyGarantiesConfig } from './garanties-controls.js';
import { clampCommissionPct } from '../maxance/selectors.js';
import type {
  CourrierStagedSendRequest,
  CourrierStagedSendResponse,
  RepriseSearchRequest,
  RepriseSearchResponse,
} from '../content-protocol.js';
import type { z } from 'zod';

type QuoteConfirmCommand = z.infer<typeof QuoteConfirmCommandSchema>;

const SETTLE_MS = 800;

/**
 * Extract the devisNumber from the Edition à imprimer page — ANCHORED to the
 * registration line "Votre devis est enregistré sous le numero : DRxxxxxxxx"
 * ("numero" renders without the accent; tolerate both).
 *
 * 2026-07-02: this was a bare \bDR\d+\b scan of the whole body, which false-
 * positived on the "Visité récemment : <NAME> (DR…)" box Maxance renders on
 * EVERY Proximeo page once a devis dossier has been visited — the confirm
 * flow then misdetected the Garanties tab as the edition page, skipped the
 * devis creation entirely, and re-sent the previously visited devis.
 */
function extractDevisNumber(): string | null {
  const text = document.body.innerText ?? '';
  const m = /enregistr\S*\s+sous\s+le\s+num[ée]ro\s*:?\s*(DR\d{8,12})\b/i.exec(text);
  return m?.[1] ?? null;
}

/**
 * Extract the devisNumber from the "Visualisation du devis" dossier page —
 * anchored to the "Devis DRxxxxxxxx" line of the Informations générales
 * block (never the parenthesized "Visité récemment (DR…)" box).
 */
function extractVisualisedDevisNumber(): string | null {
  const text = document.body.innerText ?? '';
  const m = /\bDevis\s*:?\s*(DR\d{8,12})\b/.exec(text);
  return m?.[1] ?? null;
}

/**
 * Ask the SW to fill + submit the ACCES PORTEFEUILLE search for the devis
 * (MAIN world) — navigates to "Visualisation du devis", which makes the devis
 * the session's CURRENT INSTANCE (the courrier system binds letters to it).
 * Same message the devis-resume flow uses.
 */
async function visitDevisDossier(devisNumber: string): Promise<void> {
  const msg: RepriseSearchRequest = { kind: 'reprise.search-mw', devisNumber };
  const resp = (await chrome.runtime.sendMessage(msg)) as RepriseSearchResponse | undefined;
  if (!resp) throw new Error('maxance_confirm_visit_devis_failed:no_response');
  if (resp.kind !== 'reprise.search.ok') {
    throw new Error(`maxance_confirm_visit_devis_failed:${resp.error} [${resp.log.join(',')}]`);
  }
}

/**
 * Ask the SW to run the VERIFIED staged send in the Courrier composer
 * (fill → checkMail → "Mail :" confirm stage → Valider → mail.do check).
 * The composer popup must already be open (openDevisMotoCourrierUrl).
 */
async function courrierStagedSend(to: string, objet: string): Promise<CourrierStagedSendResponse> {
  const msg: CourrierStagedSendRequest = {
    kind: 'courrier.staged-send-mw',
    payload: { to, objet },
  };
  const resp = (await chrome.runtime.sendMessage(msg)) as CourrierStagedSendResponse | undefined;
  if (!resp) {
    return { kind: 'courrier.staged.err', log: [], error: 'no_response' };
  }
  return resp;
}

/**
 * Phase-2i (2026-06-03, corrected path per Ridaa's screenshots): open the
 * Devis-moto "Envoyer par…" Courrier popup (`id:impressionDR`). This popup
 * has the devis PDF auto-attached + a Mail toolbar (Adresse=To / CC / Objet)
 * with EMPTY fields + an Envoyer button. We replay the edition page button's
 * OWN mdiWindNet onclick (faithful params) via main world, then wait for the
 * Mail toolbar (`input[name=mailAdresse]`) to appear in any nested frame.
 */
async function openDevisMotoCourrier(cmd: QuoteConfirmCommand): Promise<void> {
  await reportProgress(cmd.id, 'courrier_open');
  // Find the Devis-moto "Envoyer par..." control on the edition page; its
  // onclick is mdiWindNet.window('listerModeleLettreAutorise.do?PAGE=0000501000
  // &FORWARD=/preparerLettre.do?ligneSelected=DR', null, 'id:impressionDR;…').
  let url = `${COURRIER_POPUP_URL_PATH}?PAGE=0000501000&FORWARD=/preparerLettre.do?ligneSelected=DR`;
  let opts = 'id:impressionDR; title: Courrier; width: 700; height: 750;';
  const ctrl = Array.from(document.querySelectorAll<HTMLElement>('[onclick]')).find((el) => {
    const oc = el.getAttribute('onclick') ?? '';
    return /impressionDR/.test(oc) && /ligneSelected=DR\b/.test(oc);
  });
  if (ctrl) {
    const oc = ctrl.getAttribute('onclick') ?? '';
    const m = /mdiWindNet\.window\(\s*'([^']+)'\s*,\s*[^,]+,\s*'([^']*)'/.exec(oc);
    if (m?.[1]) {
      url = m[1];
      opts = m[2] ?? opts;
    }
  }
  await openMdiWindowMainWorld(url, opts);
  await waitForMailToolbar(20_000);
  await reportProgress(cmd.id, 'courrier_mail_toolbar_ready');
}

/** True if any same-origin frame (from `doc` down) has the Mail toolbar. */
function hasMailToolbar(doc: Document | null | undefined, depth: number): boolean {
  if (!doc || depth > 5) return false;
  if (doc.querySelector('input[name="mailAdresse"]')) return true;
  for (const f of Array.from(doc.querySelectorAll('iframe, frame'))) {
    try {
      if (hasMailToolbar((f as HTMLIFrameElement).contentDocument, depth + 1)) return true;
    } catch {
      /* cross-origin — skip */
    }
  }
  return false;
}

/** Poll for the Courrier Mail toolbar (`input[name=mailAdresse]`) to render. */
async function waitForMailToolbar(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasMailToolbar(document, 0)) return;
    await sleep(400);
  }
  throw new Error('maxance_courrier_mail_toolbar_timeout');
}

/**
 * Probe which confirm screen we're currently on.
 *
 *   - 'edition_imprimer' — final page after the Devis OK click navigated;
 *     URL ends in /souscriptionDevisValiderFinaleMoto.do. Has the devis
 *     number rendered in the page body.
 *   - 'devis_tab_pre' — we just landed after the preview flow; "Valider
 *     devis" button is visible in the document. The devis form fields
 *     (Civilité, Nom, ...) may not be visible YET because Maxance opens
 *     them after the Valider click.
 *   - 'unknown' — neither marker seen; advance loop waits a settle + retries.
 */
function detectConfirmScreen():
  | 'devis_tab_pre'
  | 'devis_form_open'
  | 'edition_imprimer'
  | 'devis_visualisation'
  | 'unknown' {
  // 2026-07-02: the real-mode send flow navigates edition → "Visualisation du
  // devis" (via the ACCES PORTEFEUILLE search) to make the fresh devis the
  // session's CURRENT INSTANCE before opening the Courrier composer — the
  // composer binds letters to the last-visited dossier, and a stale instance
  // (e.g. an auto devis Achraf browsed) makes the moto letter fail with
  // "branche différente" / an empty composer / a silent non-send.
  // The visualisation page also renders the DR number in its body, so this
  // check MUST run before the extractDevisNumber()-based edition heuristic.
  if (document.forms.namedItem('VisualisationContratForm')) {
    return 'devis_visualisation';
  }
  // Phase-2d-confirm (2026-05-25 PM): three distinct states the flow
  // crosses, identified live via Chrome MCP.
  //   1. devis_tab_pre — Garanties tab (price preview rendered).
  //      `#validerDevis` button visible. URL: ...souscriptionNaviguerOngletVehicule.do
  //      (no `?ONGLET_REQUEST_KEY=...` query OR with a different key).
  //   2. devis_form_open — Devis subscriber-info form rendered after
  //      Valider devis click. Same path but `?ONGLET_REQUEST_KEY=ongletDevis`.
  //      `#validerSouscription` button is now the "OK" submit (the same
  //      container ID is repurposed on this tab).
  //   3. edition_imprimer — final page after the Devis OK click navigated;
  //      URL ends in /souscriptionDevisValiderFinaleMoto.do, body contains
  //      DRxxxxxxxx devis number.
  if (location.pathname.endsWith(PROXIMEO_URL_SIGNATURES.editionImprimer)) {
    return 'edition_imprimer';
  }
  // Heuristic: presence of devisNumber in body also signals edition page.
  if (extractDevisNumber() !== null) return 'edition_imprimer';
  // Devis form open: identified by the URL's onglet query param (set by
  // Maxance after the Valider devis click) OR by the souscripteur fields
  // being present (the form rendered).
  if (/[?&]ONGLET_REQUEST_KEY=ongletDevis(\b|&)/.test(location.search)) {
    return 'devis_form_open';
  }
  if (document.querySelector('input[name="souscripteur.nom"]')) {
    return 'devis_form_open';
  }
  // Garanties with the Valider devis button visible = pre-state. Use the
  // container ID (stable) instead of body text to avoid the same false
  // positive that bit phase 2f (text from menu strip leaking into matches).
  if (document.getElementById('validerDevis')) {
    return 'devis_tab_pre';
  }
  return 'unknown';
}

/**
 * Single-screen advance of the quote.confirm flow (M8.T8 phase 2e).
 *
 * Mirrors `runQuotePreview` — the SW orchestrator may call this multiple
 * times across top-frame navigations. Returns `quote.confirm.navigating`
 * after triggering the Devis OK click (which navigates to the Edition à
 * imprimer page), or `quote.confirm.ok` when the mail composer is fully
 * handled.
 *
 * Note: the Courrier popup opens in a same-origin IFRAME, not a new
 * top-frame page, so the popup + composer work stays inside ONE
 * content-script run. The only top-frame navigation is the Devis OK
 * click.
 */
export async function runQuoteConfirm(cmd: QuoteConfirmCommand): Promise<Response> {
  const t0 = Date.now();
  const screenshots: Screenshot[] = [];
  const shoot = async (step: string): Promise<void> => {
    try {
      screenshots.push(await captureScreenshot(step));
    } catch {
      /* best-effort */
    }
  };

  const navigating = (fromScreen: string, expectedScreen: string): Response =>
    QuoteConfirmNavigatingResponseSchema.parse({
      id: cmd.id,
      kind: 'quote.confirm.navigating',
      fromScreen,
      expectedScreen,
      screenshots,
    });

  try {
    await sleep(SETTLE_MS);

    for (let iter = 0; iter < 6; iter += 1) {
      const screen = detectConfirmScreen();
      await reportProgress(cmd.id, 'confirm_advance_iter', `screen=${screen}`);

      if (screen === 'devis_tab_pre') {
        // 0. Garanties additionnelles (2026-07-02, Achraf's pack): tick the
        //    requested add-on checkboxes BEFORE Valider devis so the devis
        //    carries them. Idempotent across re-invokes (checked reads
        //    'already', commission reads 'already' → no extra AJAX). A
        //    control-triggered top-frame nav hands back to the SW like the
        //    preview's garanties step does.
        const addOns = cmd.garantiesAdditionnelles;
        if (addOns?.assistance || addOns?.garantiePersonnelle) {
          try {
            const cfgResult = await applyGarantiesConfig({
              commissionPct: clampCommissionPct(22),
              ...(addOns.assistance ? { assistance: true } : {}),
              ...(addOns.garantiePersonnelle ? { garantiePersonnelle: true } : {}),
            });
            await reportProgress(cmd.id, 'confirm_addons_applied', JSON.stringify(cfgResult));
          } catch (gErr) {
            if (gErr instanceof GarantiesNavigatedError) {
              await reportProgress(cmd.id, 'garanties_navigated', `url=${location.href}`);
              return navigating('devis_tab_pre', 'devis_tab_pre');
            }
            throw gErr;
          }
        }
        // 1. Click Valider devis via main-world mouse-event dispatch on
        //    `#validerDevis .buttonMiddle` — same proven pattern as phase
        //    2f's validerVehicule/validerConducteur. The previous
        //    clickByText('Valider devis') used plain .click() which
        //    doesn't fire Maxance's onmouseup-bound framework handler.
        await reportProgress(cmd.id, 'valider_devis');
        await clickMaxanceButton('validerDevis', { label: 'valider_devis' });
        await shoot('valider_devis_clicked');
        // Maxance reloads the page with ?ONGLET_REQUEST_KEY=ongletDevis —
        // treat as a navigation. SW orchestrator re-invokes; next iter
        // detects 'devis_form_open'.
        return navigating('devis_tab_pre', 'devis_form_open');
      }

      if (screen === 'devis_form_open') {
        // Phase-2d-confirm-6 (2026-05-25 PM): route the ENTIRE Devis form
        // fill + Nouveau commits + OK click through ONE main-world script
        // via SW chrome.scripting. The isolated-world content-script
        // fillDevisTab path consistently produced "Un problème technique"
        // on OK submit even with form_dump showing every field correct
        // AND contactList[0] populated. The same operations driven
        // directly from main world (Chrome MCP javascript_tool) created
        // DR0000973635 successfully. We pre-fill pre-populated fields
        // (Civilité, Profession, Ville, CP) via existing setSelectByLabel
        // calls — these were already pre-set from Conducteur and just
        // need a final confirmation. Then call the main-world bundle.
        const { subscriber } = cmd;
        await setSelectByLabel('Civilité', CIVILITE_VALUE[subscriber.civilite], {
          label: 'civilite',
        });
        await setSelectByLabel(
          'Profession',
          PROFESSION_VALUE[subscriber.profession ?? 'employe_prive'],
          { label: 'profession' },
        );
        await fillByLabel('Code postal', subscriber.postalCode, { label: 'cp' });
        await sleep(400);

        await reportProgress(cmd.id, 'devis_tab_filling');
        const devisResult = await devisFillAndSubmitMainWorld({
          lastName: subscriber.lastName,
          firstName: subscriber.firstName,
          addressLine: subscriber.addressLine,
          ...(subscriber.addressComplement
            ? { addressComplement: subscriber.addressComplement }
            : {}),
          phoneType: PHONE_TYPE_MOBILE,
          phoneUsage: PHONE_USAGE_PERSO,
          phoneNumero: subscriber.phoneMobile,
          emailUsage: EMAIL_ROLE_GESTION,
          email: subscriber.email,
        });
        await reportProgress(
          cmd.id,
          'devis_mw_result',
          JSON.stringify({
            ok: devisResult.ok,
            log: devisResult.log,
            ...(devisResult.ok ? {} : { error: devisResult.error, errorMsg: devisResult.errorMsg }),
          }),
        );
        if (!devisResult.ok) {
          // P3b: repeat-customer "Ce contact existe déjà" surfaces as a
          // DISTINCT error code (set by the main-world handler) so the
          // backend can reason about it separately from generic fill
          // failures (route to human / reuse-existing-contact). Pass it
          // through verbatim; otherwise use the generic fill-failed code.
          const errorCode =
            devisResult.error === CONTACT_DUPLICATE_ERROR
              ? CONTACT_DUPLICATE_ERROR
              : 'maxance_confirm_devis_fill_failed';
          return ErrorResponseSchema.parse({
            id: cmd.id,
            kind: 'error',
            errorCode,
            detail: `${devisResult.error}${devisResult.errorMsg ? ': ' + devisResult.errorMsg : ''}`,
            screenshots,
          });
        }
        await shoot('devis_tab_filled');
        await reportProgress(cmd.id, 'devis_tab_submit');
        return navigating('devis_form_open', 'edition_imprimer');
      }

      if (screen === 'edition_imprimer') {
        await shoot('edition_imprimer');

        // Phase-2d-confirm-diag: dump the edition page state on arrival
        // so when extractDevisNumber fails we know whether (a) the DR
        // number is rendered with a different format/separator, (b) it's
        // on a different page that we'd misread as edition_imprimer, or
        // (c) Maxance returned an error in the body text.
        const bodyText = (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 800);
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, .titre, .titrePage'))
          .map((h) => (h.textContent ?? '').trim())
          .filter(Boolean)
          .slice(0, 8);
        await reportProgress(
          cmd.id,
          'edition_page_dump',
          JSON.stringify({ bodyText, headings, search: location.search }),
        );

        // Phase-2d-confirm-4 (2026-05-25 PM): the editionImprimer URL
        // /souscriptionDevisValiderFinaleMoto.do can render TRANSIENTLY
        // as a "Un problème technique" page while Maxance's backend is
        // still creating the devis. A direct main-world MCP-driven run
        // showed exactly this: ~4s after OK click the body said "problème
        // technique"; ~8s after, the body had transitioned to the real
        // edition page with the DR number rendered. So we DO NOT
        // short-circuit on the "problème technique" body — instead we
        // poll extractDevisNumber for 20s, which covers both the
        // transient case (success) and the true-error case (clean timeout
        // → tagged error below). Removes the eager error gate that was
        // catching the transient page in phase 2d-confirm-3.
        const devisNumber = await waitFor(() => extractDevisNumber(), {
          label: 'extract_devis_number',
          timeoutMs: 20_000,
        }).catch(() => null);
        if (!devisNumber) {
          const finalBody = (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 240);
          return ErrorResponseSchema.parse({
            id: cmd.id,
            kind: 'error',
            errorCode: 'maxance_confirm_no_devis_number',
            detail: `editionImprimer rendered but DR number never appeared after 20s. Body: "${finalBody}"`,
            screenshots,
          });
        }
        await reportProgress(cmd.id, 'devis_number_extracted', devisNumber);

        // Phase-2g (Courrier reliability): restore the M8.T6 dryRun
        // contract — open the Courrier popup + fill the mail composer, then
        // STOP one click before Envoyer. Phase-2d-confirm-9 had skipped the
        // popup in dryRun because it was flaky; the root cause (mdiWindNet
        // read from the isolated world) is now fixed (commit e203edd), so we
        // exercise it again to verify the open without ever sending an email.
        // BEST-EFFORT: the devis is already created, so a popup failure must
        // NOT fail the dryRun — we record the outcome in courrierDryRunStatus
        // and still return ok. This both verifies the fix AND preserves the
        // robust "devis created" success path.
        if (cmd.dryRun) {
          // Default fast path: devis created, return immediately. Only
          // exercise the Courrier popup when explicitly opted-in via
          // exerciseCourrier (the composer is a multi-stage Struts frameset
          // still being reverse-engineered — keep normal dryRun fast).
          let courrierDryRunStatus = 'skipped';
          if (cmd.exerciseCourrier) {
            // Phase-2i: exercise the CORRECT send path — open the Devis-moto
            // "Envoyer par…" Courrier popup, fill the Mail toolbar (To/Objet),
            // and STOP before Envoyer (send:false). Verifies the fill works
            // without sending an email. Best-effort: devis already created.
            courrierDryRunStatus = 'not_attempted';
            try {
              await openDevisMotoCourrier(cmd);
              await shoot('courrier_opened');
              const res = await courrierFillAndSend({
                to: cmd.subscriber.email,
                objet: `Votre devis assurance trottinette Assuryal - ${devisNumber}`,
                send: false, // dryRun: fill + STOP before Envoyer
              });
              await reportProgress(cmd.id, 'courrier_fill_result', JSON.stringify(res));
              await shoot('courrier_filled');
              courrierDryRunStatus = res.filledFrame
                ? `filled_no_send (${res.log.join(',')})`
                : `fill_no_frame (${res.log.join(',')})`;
            } catch (e) {
              courrierDryRunStatus = `courrier_failed:${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`;
            }
            await reportProgress(cmd.id, 'dryrun_courrier_status', courrierDryRunStatus);
          }
          await reportProgress(cmd.id, 'dryrun_stopped_after_devis_created', devisNumber);
          return QuoteConfirmResponseSchema.parse({
            id: cmd.id,
            kind: 'quote.confirm.ok',
            devisNumber,
            pdfSentTo: cmd.subscriber.email,
            screenshots,
            finalUrl: location.href,
            durationMs: Date.now() - t0,
            courrierDryRunStatus,
          });
        }

        // Real-mode send — 2026-07-02 root-cause fix. Do NOT open the
        // composer from this edition page: the courrier system binds letters
        // to the session's CURRENT INSTANCE (last-visited dossier), which is
        // NOT the freshly created devis (e.g. an auto devis Achraf browsed →
        // "branche différente" ALERTE → empty composer → silent non-send).
        // Instead, VISIT the devis dossier first (search by DR number → the
        // "Visualisation du devis" page), which sets the instance; the
        // devis_visualisation branch below then opens the composer and runs
        // the verified staged send.
        await reportProgress(cmd.id, 'courrier_visit_devis', devisNumber);
        await visitDevisDossier(devisNumber);
        await shoot('visit_devis_submitted');
        return navigating('edition_imprimer', 'devis_visualisation');
      }

      if (screen === 'devis_visualisation') {
        // The devis dossier page — reached via the ACCES PORTEFEUILLE search.
        // Being here means the devis IS the session's current instance, so
        // the Devis-moto letter generates correctly (live-verified: the
        // "branche différente" failure only occurs with a stale instance).
        await shoot('devis_visualisation');
        // The DR number is rendered in the dossier body — re-extract it (the
        // content script died on the navigation, so no state survived).
        const devisNumber = extractVisualisedDevisNumber();
        if (!devisNumber) {
          return ErrorResponseSchema.parse({
            id: cmd.id,
            kind: 'error',
            errorCode: 'maxance_confirm_visualisation_no_devis_number',
            detail: `Visualisation page reached but no DR number in body. url=${location.href}`,
            screenshots,
          });
        }
        // Courrier recipient: the redirected inbox (Assuryal Workspace) when
        // the backend set courrierTo, else the customer directly (legacy).
        const courrierTo = cmd.courrierTo ?? cmd.subscriber.email;
        await reportProgress(cmd.id, 'courrier_open_composer', devisNumber);
        // Open the Courrier composer for the Devis-moto letter (PDF
        // auto-generated + Mail toolbar) via the page's own mdiWindNet.
        const url = `${COURRIER_POPUP_URL_PATH}?PAGE=0000501000&FORWARD=/preparerLettre.do?ligneSelected=DR`;
        const opts = 'id:impressionDR; title: Courrier; width: 700; height: 750;';
        await openMdiWindowMainWorld(url, opts);
        // Staged send: composer-ready gate → fill → checkMail → "Mail :"
        // confirm stage → Valider → mail.do verification (SW-orchestrated).
        const sendRes = await courrierStagedSend(
          courrierTo,
          `Votre devis assurance trottinette Assuryal - ${devisNumber}`,
        );
        await reportProgress(cmd.id, 'courrier_staged_result', JSON.stringify(sendRes));
        if (sendRes.kind !== 'courrier.staged.ok' || !sendRes.sent) {
          const err = sendRes.kind === 'courrier.staged.err' ? sendRes.error : 'not_sent';
          return ErrorResponseSchema.parse({
            id: cmd.id,
            kind: 'error',
            errorCode: err.startsWith('maxance_') ? err : 'maxance_courrier_send_failed',
            detail: `staged send failed: ${err} [${sendRes.log.join(',')}]`.slice(0, 240),
            screenshots,
          });
        }
        await shoot('post_envoyer');

        return QuoteConfirmResponseSchema.parse({
          id: cmd.id,
          kind: 'quote.confirm.ok',
          devisNumber,
          pdfSentTo: cmd.subscriber.email,
          screenshots,
          finalUrl: location.href,
          durationMs: Date.now() - t0,
        });
      }

      // unknown — settle and retry detection once
      await sleep(SETTLE_MS);
    }

    return ErrorResponseSchema.parse({
      id: cmd.id,
      kind: 'error',
      errorCode: 'maxance_confirm_unknown_screen',
      detail: `advance loop exhausted on screen=${detectConfirmScreen()} url=${location.href}`,
      screenshots,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return ErrorResponseSchema.parse({
      id: cmd.id,
      kind: 'error',
      errorCode: msg.startsWith('maxance_') ? msg.split(':')[0] : 'maxance_confirm_unknown',
      detail: msg.slice(0, 240),
      screenshots,
    });
  }
}
