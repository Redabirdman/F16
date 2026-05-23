/**
 * Maxance "Valider devis" + email send step planner (M8.T6).
 *
 * Continues from where `startQuote` (M8.T3) stops — the Garanties tab with
 * a visible price. Drives:
 *
 *     Garanties → [Valider devis] → Devis tab fill → [OK]
 *                 → Edition à imprimer → [Devis moto envoyer par]
 *                 → email dialog → fill email → [Envoyer]
 *                 → devisNumber capture
 *
 * Out of scope for M8.T6:
 *   - "Reprendre devis" / souscription path (M8.T7, needs Achraf sign-off)
 *   - Coordonnées bancaires (IBAN/BIC) — that's also the souscription flow
 *   - Paiement (carte bancaire) — same
 *
 * Live-verification note (2026-05-23): the field labels and button texts in
 * this file are sourced from Achraf's walkthrough PDF (steps 5 + 6) plus
 * the deterministic-Playwright patterns we live-verified for M8.T3. The
 * exact `getByLabel(...)` strings + the email-dialog selectors should be
 * confirmed against the live Maxance UI via the Claude Chrome extension
 * before the first non-dryRun run.
 */
import type { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import type {
  MaxanceConfirmQuoteOptions,
  MaxanceConfirmQuoteParams,
  MaxanceConfirmQuoteResult,
  MaxanceQuoteScreenshot,
  MaxanceSubscriberInfo,
} from './types.js';
import {
  captureStep,
  clickByTextOrThrow,
  fillByLabel,
  setSelectByLabel,
  settleMs,
  sleep,
  withTimeout,
} from './quote-form.js';

const DEFAULT_CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Civilité dropdown values. Verbatim per Maxance (option `value` attributes
 * still to be confirmed live — these are the spelled-out labels Achraf used
 * in his PDF). If the live <option value> differs, `setSelectByLabel`'s
 * label-based selection falls back to label match.
 */
const CIVILITE_LABEL: Record<MaxanceSubscriberInfo['civilite'], string> = {
  monsieur: 'Monsieur',
  madame: 'Madame',
};

/**
 * Profession dropdown — same values we set on the Conducteur tab in M8.T3.
 * Devis tab re-asks the question (Maxance doesn't carry it forward between
 * tabs for Reasons), so we set it again here.
 */
const PROFESSION_VALUE: Record<NonNullable<MaxanceSubscriberInfo['profession']>, string> = {
  employe_prive: '125',
  employe_public: '126',
  etudiant: '108',
  retraite: '109',
  sans_profession: '130',
};

/**
 * Zod schema for the devisNumber extract on the Edition à imprimer page.
 * Numbers Maxance prints are short alphanumeric strings like "AB12345678".
 */
const DevisNumberSchema = z.object({
  devisNumber: z.string().min(3).max(40),
});

const DevisNumberInstruction =
  'Find the devis (quote) reference number printed on the current Edition à imprimer page.' +
  ' It is typically a short alphanumeric code like "AB12345678" displayed near the top of the' +
  ' page, often labelled "N° de devis" or "Référence devis". Return just the code, no labels.';

/**
 * Drive the Valider devis + Devis tab + email send flow.
 *
 * Pre-condition: `stagehand` is on the Maxance Garanties tab with a price
 * visible (i.e. `startQuote` just returned successfully on the same session).
 *
 * dryRun behaviour: by default we STOP just before the final Envoyer click
 * — the email dialog is filled out but not dispatched. The screenshot trail
 * + the prepared dialog gives the operator everything they need to verify
 * the flow without sending a real customer email.
 */
export async function confirmQuote(
  stagehand: Stagehand,
  sessionId: string,
  params: MaxanceConfirmQuoteParams,
  opts: MaxanceConfirmQuoteOptions,
): Promise<MaxanceConfirmQuoteResult> {
  const t0 = Date.now();
  const totalTimeoutMs = opts.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const dataRoot = opts.dataRoot ?? process.env.STAGEHAND_DATA_DIR ?? './data';
  const screenshots: MaxanceQuoteScreenshot[] = [];

  const pushShot = async (step: string): Promise<void> => {
    const s = await captureStep(stagehand, sessionId, step, dataRoot, opts.screenshotCallback);
    if (s) screenshots.push(s);
  };

  const page = stagehand.context.activePage();
  if (!page) throw new Error('maxance_confirm_no_active_page');

  // Step 1 — click Valider devis on the Garanties tab. This soft-saves the
  // quote in Maxance's system (no contract yet) and advances to the Devis
  // tab. Per Achraf this is the broker's everyday action — clicking it in
  // dev is safe (the quote is just a soft record; brokers do dozens daily).
  await clickByTextOrThrow(page, 'Valider devis', 'valider_devis', totalTimeoutMs);
  await sleep(settleMs(2500));
  await pushShot('valider_devis_clicked');

  // Step 2 — Devis tab fill. Per Achraf's walkthrough (step 5), the fields
  // are Civilité / Nom / Prénom / Profession / CP / Ville / Voie / Bât /
  // Domiciliation / Téléphone Mobile / Téléphone Personnel / Email Gestion.
  // We fill the must-haves; Bât + Domiciliation + Téléphone Personnel stay
  // empty (Maxance doesn't refuse the form without them).
  const sub = params.subscriber;
  await setSelectByLabel(
    page,
    'Civilité',
    CIVILITE_LABEL[sub.civilite],
    'civilite',
    totalTimeoutMs,
  );
  await fillByLabel(page, 'Nom', sub.lastName, 'nom', totalTimeoutMs);
  await fillByLabel(page, 'Prénom', sub.firstName, 'prenom', totalTimeoutMs);
  await setSelectByLabel(
    page,
    'Profession',
    PROFESSION_VALUE[sub.profession ?? 'employe_prive'],
    'profession',
    totalTimeoutMs,
  );
  // Address fields. Maxance accepts the CP first; Ville auto-fills, but we
  // overwrite explicitly when the caller passed a city (defends against
  // CP-multi-city ambiguity).
  await fillByLabel(page, 'Code postal', sub.postalCode, 'cp', totalTimeoutMs);
  await sleep(settleMs(500));
  if (sub.city) {
    // Ville is a select, not a free text — same pattern as the M8.T3 CP→Ville
    // resolution. Pass the label as the option text.
    await setSelectByLabel(page, 'Ville', sub.city, 'ville', totalTimeoutMs);
  }
  await fillByLabel(page, 'Voie', sub.addressLine, 'voie', totalTimeoutMs);
  if (sub.addressComplement) {
    // Bât / appt / floor — Maxance labels the field "Bât" or "Bâtiment"
    // depending on skin. The getByLabel matcher does a fuzzy substring
    // match so either spelling resolves.
    await fillByLabel(page, 'Bât', sub.addressComplement, 'batiment', totalTimeoutMs);
  }
  await fillByLabel(page, 'Téléphone Mobile', sub.phoneMobile, 'phone_mobile', totalTimeoutMs);
  await fillByLabel(page, 'Email Gestion', sub.email, 'email', totalTimeoutMs);
  await pushShot('devis_tab_filled');

  // Step 3 — submit the Devis tab. Per Achraf this is just the "OK" button.
  await clickByTextOrThrow(page, 'OK', 'devis_tab_ok', totalTimeoutMs);
  await sleep(settleMs(3000));
  await pushShot('post_devis_tab_ok');

  // Step 4 — we're now on the "Edition à imprimer" page. Extract the devis
  // number before clicking anything else (in case the email flow takes us
  // away from this view).
  const devisNumberResp = await withTimeout(
    stagehand.extract(DevisNumberInstruction, DevisNumberSchema),
    totalTimeoutMs,
    'maxance_confirm_timeout_devis_number_extract',
  );
  const devisNumber = devisNumberResp.devisNumber;

  // Step 5 — click "Devis moto envoyer par" to open the email dialog.
  // Achraf's PDF spells it like that; some skins say "Envoyer par email"
  // or "Envoyer par mail". Stagehand's act handles the variation via the
  // LLM, but the deterministic clickByText with a longer matched string
  // works in the most-common case.
  await clickByTextOrThrow(page, 'Devis moto envoyer par', 'envoyer_par_open', totalTimeoutMs);
  await sleep(settleMs(1500));
  await pushShot('envoyer_par_dialog');

  // Step 6 — fill the recipient email in the email dialog. The dialog field
  // label varies between skins ("Email", "Adresse mail", "Destinataire"),
  // so we try a few via getByLabel — first match wins.
  try {
    await fillByLabel(page, 'Email', sub.email, 'email_dialog', totalTimeoutMs);
  } catch {
    try {
      await fillByLabel(page, 'Adresse mail', sub.email, 'email_dialog', totalTimeoutMs);
    } catch {
      await fillByLabel(page, 'Destinataire', sub.email, 'email_dialog', totalTimeoutMs);
    }
  }
  await pushShot('email_dialog_filled');

  // Step 7 — final Envoyer click. This is the boundary: in dryRun mode we
  // STOP here so no real email leaves Maxance. The full path is gated on
  // Achraf's explicit sign-off (the email goes to the customer's real
  // address; we don't want to bombard test customers).
  if (!opts.dryRun) {
    await clickByTextOrThrow(page, 'Envoyer', 'envoyer_send', totalTimeoutMs);
    await sleep(settleMs(2500));
    await pushShot('post_envoyer');
  } else {
    // Dry-run terminus. Capture one more screenshot of the prepared dialog
    // so the operator can verify the email looks right before going live.
    await pushShot('dryrun_stopped_pre_envoyer');
  }

  return {
    sessionId,
    durationMs: Date.now() - t0,
    screenshots,
    devisNumber,
    pdfSentTo: sub.email,
    finalUrl: page.url(),
  };
}
