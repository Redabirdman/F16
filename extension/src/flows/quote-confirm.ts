/**
 * quote.confirm flow — V1 Chrome-extension Maxance driver.
 *
 * Replicates the M8.T6 Stagehand step planner using vanilla DOM ops +
 * same-origin iframe traversal. The M8.T8 live investigation proved
 * #window_nvCourrier is a same-origin iframe — no coordinate clicks
 * needed.
 *
 * Pre-condition: caller has just received a successful QuotePreviewOk
 * on the same tab. We're sitting on the Garanties tab with a price.
 *
 * Steps:
 *   1. Click "Valider devis".
 *   2. Devis tab fill (Civilité, Nom, Prénom, Profession, CP, Ville,
 *      voie, optional addressComplement, phone widget, email widget).
 *   3. Click "OK".
 *   4. Wait for Edition à imprimer (souscriptionDevisValiderFinaleMoto.do).
 *   5. Extract devisNumber from the page heading.
 *   6. Click "Envoyer par..." next to "Devis moto".
 *   7. Wait for #window_nvCourrier iframe to populate.
 *   8. Inside the iframe: open the mail composer (envelope icon /
 *      template selection), fill Adresse + Objet.
 *   9. If dryRun=false → click Envoyer. Otherwise STOP here.
 *
 * The mail-composer sub-dialog inside the iframe couldn't be fully
 * mapped via DOM during the M8.T8 live investigation (the previous
 * popup was in an error state). We use defensive heuristic selectors
 * with fallbacks, document the unknowns in comments, and rely on phase
 * 2d live verification to surface anything we got wrong.
 */
import {
  CIVILITE_VALUE,
  COURRIER_POPUP_IFRAME_ID,
  COURRIER_POPUP_URL_PATH,
  EMAIL_ROLE_GESTION,
  PHONE_COUNTRY_FR,
  PHONE_TYPE_MOBILE,
  PHONE_USAGE_PERSO,
  PROFESSION_VALUE,
  PROXIMEO_URL_SIGNATURES,
} from '@f16/stagehand/maxance/selectors';
import {
  captureScreenshot,
  clickByText,
  clickContactWidgetNouveau,
  clickMaxanceButton,
  fillByLabel,
  setSelectByLabel,
  sleep,
  waitFor,
} from '../dom.js';
import {
  iframeQuerySelector,
  openMdiWindow,
  waitForIframeElement,
  waitForIframeReady,
} from '../iframe.js';
import {
  type QuoteConfirmCommandSchema,
  QuoteConfirmResponseSchema,
  QuoteConfirmNavigatingResponseSchema,
  ErrorResponseSchema,
  type Response,
  type Screenshot,
} from '../wire.js';
import { reportProgress } from './progress.js';
import type { z } from 'zod';

type QuoteConfirmCommand = z.infer<typeof QuoteConfirmCommandSchema>;

const SETTLE_MS = 800;

/** devisNumber pattern from M8.T6 live: DRxxxxxxxxxx (10-digit). */
const DEVIS_NUMBER_REGEX = /\b(DR\d{8,12})\b/;

/**
 * Extract devisNumber from the Edition à imprimer page. The number sits
 * inside the line "Votre devis est enregistré sous le numéro : DRxxxxxxxx".
 */
function extractDevisNumber(): string | null {
  const text = document.body.innerText ?? '';
  const m = DEVIS_NUMBER_REGEX.exec(text);
  return m?.[1] ?? null;
}

/**
 * Open the Courrier popup programmatically via mdiWindNet — skips the
 * "Envoyer par..." button click entirely. Falls back to clicking the
 * button if mdiWindNet isn't available (defensive).
 */
async function openCourrierPopup(cmd: QuoteConfirmCommand): Promise<void> {
  await reportProgress(cmd.id, 'courrier_popup_open');
  try {
    openMdiWindow(
      `${COURRIER_POPUP_URL_PATH}?PAGE=0000501000&FORWARD=/preparerLettre.do?ligneSelected=DR`,
      'id:nvCourrier;title:Gestion des courriers;width:600;height:600;',
    );
  } catch {
    // Fallback: click [Envoyer par...] for Devis moto. There are two
    // such buttons (Devis moto + Fiche IPID Moto); we want the first one.
    await clickByText('Envoyer par...', { label: 'envoyer_par', timeoutMs: 10_000 });
  }
  await waitForIframeReady(COURRIER_POPUP_IFRAME_ID, {
    timeoutMs: 20_000,
    minBodyTextLength: 50,
    label: 'courrier_popup_ready',
  });
}

/**
 * Fill the mail composer inside the Courrier iframe. The composer
 * appears AFTER the operator picks a template from the popup's template
 * list. We auto-pick the "Devis" template using heuristic match.
 *
 * Returns once both Adresse + Objet are filled. The final Envoyer click
 * is left to the caller (gated on dryRun).
 */
async function fillMailComposer(cmd: QuoteConfirmCommand, devisNumber: string): Promise<void> {
  const { subscriber } = cmd;
  await reportProgress(cmd.id, 'mail_template_select');

  // Step 1: pick the "Devis" template from the popup's template list.
  // The template list is rendered as a table of rows in the iframe;
  // each row's link/button has the template name as text.
  const templateLink = await waitForIframeElement<HTMLElement>(
    COURRIER_POPUP_IFRAME_ID,
    (doc) => {
      const links = Array.from(doc.querySelectorAll<HTMLElement>('a, td, tr, button'));
      return links.find((l) => /devis\s+moto|devis$/i.test((l.textContent ?? '').trim())) ?? null;
    },
    { timeoutMs: 15_000, label: 'devis_template_link' },
  );
  templateLink.click();
  await sleep(SETTLE_MS);

  // Step 2: wait for the mail-composer form inside the iframe. The
  // composer has fields named "adresse" / "destinataire" / "email" /
  // similar — try in order. Same for "objet" / "sujet".
  await reportProgress(cmd.id, 'mail_composer_fill');

  // Adresse / recipient field.
  const adresseInput = await waitForIframeElement<HTMLInputElement>(
    COURRIER_POPUP_IFRAME_ID,
    (doc) =>
      doc.querySelector<HTMLInputElement>(
        'input[name*="adresse" i], input[name*="destinataire" i], input[name*="email" i]',
      ),
    { timeoutMs: 15_000, label: 'mail_composer_adresse' },
  );
  setInputValue(adresseInput, subscriber.email);

  // Objet / subject field.
  const objetInput = iframeQuerySelector<HTMLInputElement>(
    COURRIER_POPUP_IFRAME_ID,
    'input[name*="objet" i], input[name*="sujet" i], input[name*="subject" i]',
  );
  if (objetInput) {
    setInputValue(objetInput, `Votre devis trottinette Assuryal - ${devisNumber}`);
  }
}

/**
 * Set an input's value via the native setter so framework (jQuery)
 * trackers stay consistent. Fires input + change + blur.
 */
function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.focus();
  const desc = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    'value',
  );
  desc?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

/**
 * Click the Envoyer button inside the mail composer. Used only when
 * dryRun=false. Defensive: tries an input[type=submit] with "Envoyer"
 * value first, then a button with that text.
 */
async function clickEnvoyerInComposer(cmd: QuoteConfirmCommand): Promise<void> {
  await reportProgress(cmd.id, 'mail_envoyer_click');
  const btn = await waitForIframeElement<HTMLElement>(
    COURRIER_POPUP_IFRAME_ID,
    (doc) => {
      // Prefer <input type=submit> labelled "Envoyer" (not "Envoyer + Imprimer").
      const submits = Array.from(
        doc.querySelectorAll<HTMLInputElement>('input[type=submit], button'),
      );
      // Exact "Envoyer" or "Envoyer" as first word, NOT "Envoyer + Imprimer".
      return (
        submits.find((s) => {
          const t = (s.value ?? s.textContent ?? '').trim();
          return /^envoyer\b/i.test(t) && !/imprimer/i.test(t);
        }) ?? null
      );
    },
    { timeoutMs: 10_000, label: 'mail_envoyer_button' },
  );
  btn.click();
}

/** Fill the Devis tab once the Valider devis click has settled. */
async function fillDevisTab(cmd: QuoteConfirmCommand): Promise<void> {
  const { subscriber } = cmd;
  await reportProgress(cmd.id, 'devis_tab_filling');
  await setSelectByLabel('Civilité', CIVILITE_VALUE[subscriber.civilite], { label: 'civilite' });
  await fillByLabel('Nom', subscriber.lastName, { label: 'nom' });
  await fillByLabel('Prénom', subscriber.firstName, { label: 'prenom' });
  await setSelectByLabel('Profession', PROFESSION_VALUE[subscriber.profession ?? 'employe_prive'], {
    label: 'profession',
  });
  await fillByLabel('Code postal', subscriber.postalCode, { label: 'cp' });
  await sleep(400);
  await setSelectByLabel('Ville', subscriber.city, { label: 'ville', timeoutMs: 5_000 }).catch(
    () => undefined,
  );
  await fillByLabel('N° et nom de voie', subscriber.addressLine, { label: 'voie' });
  if (subscriber.addressComplement) {
    await fillByLabel('Bâtiment, Résidence', subscriber.addressComplement, {
      label: 'batiment',
      timeoutMs: 3_000,
    }).catch(() => undefined);
  }
  // Phone widget — three labelless dropdowns + a textbox. Maxance
  // doesn't expose stable <label> tags for these, so we set them by
  // <select name=> heuristic.
  setSelectByNameLike('telephone-type', PHONE_TYPE_MOBILE);
  setSelectByNameLike('telephone-usage', PHONE_USAGE_PERSO);
  setSelectByNameLike('telephone-pays', PHONE_COUNTRY_FR);
  fillInputByNameLike('telephone-numero', subscriber.phoneMobile);
  // Phase-2d-confirm (2026-05-25 PM live diag): Maxance keeps phone
  // input row as `currentContact.*` — a draft. The OK submit validator
  // (ErrorMessage()) checks for at least one entry in
  // `telephoneListBean.contactList[]`, NOT in the draft. So the draft
  // MUST be committed first via the green "Nouveau" img which fires
  // ajouterContactBean.do (AJAX) → promotes currentContact to
  // contactList[0] + clears the draft inputs. Without this commit, OK
  // shows "La valeur du champ 'Téléphone' est obligatoire" alerte and
  // submit is blocked. Verified live via Chrome MCP: with Nouveau
  // click added, OK created devis DR0000973630 cleanly.
  await sleep(400);
  try {
    await clickContactWidgetNouveau('telephoneListBean.currentContact.type', {
      label: 'commit_phone_entry',
    });
    await reportProgress(cmd.id, 'commit_phone_ok');
  } catch (e) {
    await reportProgress(cmd.id, 'commit_phone_err', e instanceof Error ? e.message : String(e));
  }
  await sleep(1200); // wait for AJAX response + DOM repopulation

  // Email widget — same pattern. Phase-2d-confirm live (2026-05-25): the
  // Maxance field is `emailListBean.currentContact.usage` (NOT `.type`
  // like the phone widget), so the substring needle must be 'email-usage'.
  setSelectByNameLike('email-usage', EMAIL_ROLE_GESTION);
  fillInputByNameLike('email-adresse', subscriber.email);
  await sleep(500);
  try {
    await clickContactWidgetNouveau('emailListBean.currentContact.usage', {
      label: 'commit_email_entry',
    });
    await reportProgress(cmd.id, 'commit_email_ok');
  } catch (e) {
    await reportProgress(cmd.id, 'commit_email_err', e instanceof Error ? e.message : String(e));
  }
  await sleep(1200);

  // Phase-2d-confirm-3 (2026-05-25 PM): Maxance's "Chargement..." red
  // indicator (top right) can still be active immediately after the
  // email Nouveau commits — the form is mid-AJAX-refresh. Clicking OK
  // during that window has produced "Un problème technique" backend
  // error on multiple test runs even though all form fields are
  // populated correctly + contactList[0] entries exist. A manual user
  // pauses naturally for several seconds before clicking OK; the
  // extension was clicking OK ~1.2s after the email commit. Bumping
  // the post-commits settle gives Maxance time to run any onblur
  // address formatters (the live-test showed red "address unverified"
  // dots next to N° et nom de voie) and clear session-level loading.
  await sleep(3000);

  // Phase-2d-confirm-diag: dump devis form state RIGHT BEFORE the OK
  // click so the backend log shows exactly what Maxance sees. Mirrors the
  // vehicule_form_dump + conducteur_form_dump pattern from phase 2f.
  // Caller (runQuoteConfirm) emits this — keeping the dump close to the
  // submit so it captures the final state after any cascade settlements.
}

/** Snapshot the visible Devis form values and emit them as a progress
 *  event. Used pre-OK click to diagnose required-field rejections. */
async function dumpDevisForm(cmd: QuoteConfirmCommand): Promise<void> {
  const dump: Record<string, unknown> = {};
  document.querySelectorAll<HTMLInputElement>('input').forEach((el) => {
    if (!el.name || el.type === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) return;
    if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked) dump[`${el.type}:${el.name}=${el.value}`] = 'checked';
    } else {
      dump[`inp:${el.name}`] = el.value.slice(0, 60);
    }
  });
  document.querySelectorAll<HTMLSelectElement>('select').forEach((el) => {
    if (!el.name) return;
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) return;
    dump[`sel:${el.name}`] = { v: el.value, opt: el.options.length };
  });
  await reportProgress(cmd.id, 'devis_form_dump', JSON.stringify(dump));
}

/**
 * Set the value of the first <select> whose name attribute contains
 * the given substring (case-insensitive). No-op if not found. Used
 * for the labelless phone + email widgets where heuristic name match
 * is the only signal we have.
 */
function setSelectByNameLike(nameSubstring: string, value: string): void {
  const sels = Array.from(
    document.querySelectorAll<HTMLSelectElement>(
      `select[name*="${nameSubstring.split('-')[0]}" i]`,
    ),
  );
  const picked = sels.find((s) =>
    nameSubstring
      .split('-')
      .every((part) => (s.name ?? '').toLowerCase().includes(part.toLowerCase())),
  );
  if (!picked) return;
  picked.value = value;
  picked.dispatchEvent(new Event('input', { bubbles: true }));
  picked.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillInputByNameLike(nameSubstring: string, value: string): void {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[name*="${nameSubstring.split('-')[0]}" i]`),
  );
  const picked = inputs.find((i) =>
    nameSubstring
      .split('-')
      .every((part) => (i.name ?? '').toLowerCase().includes(part.toLowerCase())),
  );
  if (!picked) return;
  setInputValue(picked, value);
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
  | 'unknown' {
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
        // 2. Fill the Devis subscriber form.
        await fillDevisTab(cmd);
        await dumpDevisForm(cmd);
        await shoot('devis_tab_filled');

        // 3. Click OK — Maxance reuses the `#validerSouscription` container
        //    on the Devis tab (its inner .buttonMiddle text is "OK", not
        //    "Valider souscription" — the SAME wrapper ID hosts the OK
        //    button on this onglet). Clicking it triggers the top-frame
        //    nav to /souscriptionDevisValiderFinaleMoto.do (editionImprimer).
        await reportProgress(cmd.id, 'devis_tab_submit');
        await clickMaxanceButton('validerSouscription', { label: 'devis_tab_ok' });
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

        // Phase-2d-confirm (2026-05-25 PM): Maxance's /souscriptionDevisValiderFinaleMoto.do
        // sometimes returns a generic "Un problème technique nous empêche
        // d'afficher la page" body instead of the devis edition page —
        // observed when the OK submit triggers a backend exception (e.g.,
        // session/duplicate constraints). Surface this distinctly so the
        // caller doesn't burn the 10s extractDevisNumber timeout chasing
        // a number that isn't there.
        if (/probl[èe]me technique/i.test(bodyText)) {
          return ErrorResponseSchema.parse({
            id: cmd.id,
            kind: 'error',
            errorCode: 'maxance_confirm_backend_error',
            detail:
              'Maxance returned "Un problème technique" page after OK submit. Session may have stale state, or backend rejected the submission. Try logging out/in or wait then retry.',
            screenshots,
          });
        }

        // 5. Extract devisNumber.
        const devisNumber = await waitFor(() => extractDevisNumber(), {
          label: 'extract_devis_number',
          timeoutMs: 10_000,
        });
        await reportProgress(cmd.id, 'devis_number_extracted', devisNumber);

        // 6+7. Open Courrier popup (same-origin iframe — stays in this content script).
        await openCourrierPopup(cmd);
        await shoot('courrier_popup_open');

        // 8. Fill mail composer.
        await fillMailComposer(cmd, devisNumber);
        await shoot('mail_composer_filled');

        // 9. Send (or stop, per dryRun).
        if (!cmd.dryRun) {
          await clickEnvoyerInComposer(cmd);
          await sleep(2_500);
          await shoot('post_envoyer');
        } else {
          await reportProgress(cmd.id, 'dryrun_stopped_pre_envoyer');
        }

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
