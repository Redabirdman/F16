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
  fillByLabel,
  setSelectByLabel,
  sleep,
  waitFor,
  waitForUrl,
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

  // Email widget — same pattern.
  setSelectByNameLike('email-type', EMAIL_ROLE_GESTION);
  fillInputByNameLike('email-adresse', subscriber.email);
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

  try {
    // 1. Valider devis (soft save).
    await reportProgress(cmd.id, 'valider_devis');
    await clickByText('Valider devis', { label: 'valider_devis', timeoutMs: 10_000 });
    await sleep(2_500);
    await shoot('valider_devis_clicked');

    // 2. Fill the Devis tab.
    await fillDevisTab(cmd);
    await shoot('devis_tab_filled');

    // 3. Submit.
    await reportProgress(cmd.id, 'devis_tab_submit');
    await clickByText('OK', { label: 'devis_tab_ok', timeoutMs: 10_000 });

    // 4. Wait for the Edition à imprimer page.
    await waitForUrl((u) => u.pathname.endsWith(PROXIMEO_URL_SIGNATURES.editionImprimer), {
      timeoutMs: 30_000,
      label: 'await_edition_imprimer',
    });
    await sleep(SETTLE_MS);
    await shoot('edition_imprimer');

    // 5. Extract devisNumber.
    const devisNumber = await waitFor(() => extractDevisNumber(), {
      label: 'extract_devis_number',
      timeoutMs: 10_000,
    });
    await reportProgress(cmd.id, 'devis_number_extracted', devisNumber);

    // 6+7. Open Courrier popup + wait for iframe ready.
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
