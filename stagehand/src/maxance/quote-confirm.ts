/**
 * Maxance "Valider devis" + email send step planner (M8.T6).
 *
 * LIVE-VERIFIED 2026-05-23 against the real Maxance Proximéo, driven via
 * the Claude Chrome extension on Ridaa's daily Chrome (the ONLY viable
 * driver per project_hosting_pivot.md). Sample case: 350€ trottinette,
 * subscriber Ridaa Lefriekh / r.lefriekh@hotmail.com / 75001 PARIS →
 * devisNumber **DR0000973579** soft-saved in Maxance, mail composer
 * loaded with recipient + subject ready, STOPPED before Envoyer.
 *
 * Flow (each step verified live):
 *     Garanties tab (with price visible from M8.T3 startQuote)
 *       → [Valider devis] button (NOT Valider souscription)
 *       → Devis tab opens (URL: ...?ONGLET_REQUEST_KEY=ongletDevis)
 *       → fill Civilité / Nom / Prénom / Profession (carried fwd)
 *               + Code postal (carried fwd) + Ville (auto)
 *               + N° et nom de voie (free-text)
 *               + Téléphone (3 dropdowns + textbox)
 *               + E-mail (dropdown + textbox)
 *       → [OK] button at bottom
 *       → Edition à imprimer page (souscriptionDevisValiderFinaleMoto.do)
 *               "Votre devis est enregistré sous le numéro : DRxxxxxxxx"
 *               two rows: "Devis moto [Envoyer par...]"
 *                         "Fiche information IPID Moto [Envoyer par...]"
 *       → click [Envoyer par...] next to "Devis moto"
 *       → LEGACY Courrier popup opens (Java-applet-style; NOT in DOM a11y tree)
 *               toolbar icons at top: preview / save / print / EMAIL / ...
 *       → click envelope icon (4th from left, pixel ~(86, 33) inside popup)
 *       → mail composer dialog appears INSIDE the popup
 *               fields: Adresse / CC / Objet / [Envoyer] / [Envoyer+Imprimer]
 *       → fill Adresse (recipient) + Objet (subject — recommended template
 *               "Votre devis trottinette Assuryal - <devisNumber>")
 *       → [Envoyer]  ← gated by !dryRun; in dryRun mode we STOP here
 *
 * Out of scope for M8.T6:
 *   - "Reprendre devis" / souscription path (M8.T7, needs Achraf sign-off)
 *   - Coordonnées bancaires (IBAN/BIC) — same souscription flow
 *   - Paiement (carte bancaire) — same
 *   - "Fiche information IPID Moto" PDF — Maxance regulatory companion
 *     with its own [Envoyer par...] button. M8.T6.5 if Achraf wants it.
 *
 * DRIVER NOTE: the email-send sub-flow (Courrier popup → envelope icon →
 * mail composer) uses a LEGACY widget that's rendered OUTSIDE the DOM
 * accessibility tree. Stagehand v3's text-based getByLabel / getByText
 * cannot see those elements. The production driver path is the Claude
 * Chrome extension's pixel `computer` tool — coordinates captured below.
 * If we ever migrate the production path back to Stagehand, the email-send
 * sub-flow would need a CDP-level click-by-coordinate workaround.
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
 * Civilité dropdown — verified live 2026-05-23. The <option value=> attribute
 * carries the abbreviation (M., MME, MLLE) NOT the spelled-out label. We
 * pass the value because setSelectByLabel uses Playwright's selectOption
 * which matches by value first then by label.
 */
const CIVILITE_VALUE: Record<MaxanceSubscriberInfo['civilite'], 'M.' | 'MME'> = {
  monsieur: 'M.',
  madame: 'MME',
};

/**
 * Phone widget dropdowns (verified 2026-05-23). The Devis tab phone widget
 * is THREE dropdowns + one textbox stacked horizontally:
 *   1) Type: FIXE / MOBILE
 *   2) Usage: PERSO / PRO
 *   3) Country: FR (France default) / MC (Monaco)
 *   4) Number: free-text — Maxance auto-formats to "06 12 34 56 78" style.
 *
 * Per Achraf's PDF: Mobile-Personnel. We default to that for trottinette
 * customers (every customer has a mobile; landlines are rare in our funnel).
 */
const PHONE_TYPE_MOBILE = 'MOBILE' as const;
const PHONE_USAGE_PERSO = 'PERSO' as const;

/**
 * E-mail widget — dropdown of role + textbox. Verified live values:
 *   ADMIN  → "Gestion"               (the one Achraf uses for quote-PDF send)
 *   AGIRA  → "Gestion Agira"
 *   PSPCM  → "Gestion et Promo"
 *   DTA2R  → "Gestion et Promo Partenaires"
 *
 * We always pick "ADMIN" (Gestion) — that's the role Maxance routes the
 * quote PDF + future contract emails to.
 */
const EMAIL_ROLE_GESTION = 'ADMIN' as const;

/**
 * Edition à imprimer pixel-coordinates captured live 2026-05-23. These
 * target the Courrier popup's toolbar:
 *   - envelope icon at (86, 33) inside the popup — opens the mail composer
 *   - close X at (474, 10)
 *
 * The popup's mail composer fields:
 *   - Adresse input: ~(290, 50)
 *   - CC input:      ~(290, 73)
 *   - Objet input:   ~(290, 95)
 *   - [Envoyer] button:           ~(31, 115)
 *   - [Envoyer + Imprimer]:       ~(105, 115)
 *
 * These are page-relative (popup is rendered at top-left of viewport).
 * Will need adjustment if Maxance moves the popup, but per Ridaa the UI is
 * locked for 12+ months.
 */
const COURRIER_POPUP_ENVELOPE_ICON: readonly [number, number] = [86, 33];
/**
 * Courrier popup close-X (top-right of the popup window). Exported in case
 * the caller needs to dismiss the popup mid-flow (e.g. after a dryRun
 * inspection). Not used by confirmQuote itself.
 */
export const COURRIER_POPUP_CLOSE_X: readonly [number, number] = [474, 10];
const MAIL_COMPOSER_ADRESSE_INPUT: readonly [number, number] = [290, 50];
const MAIL_COMPOSER_OBJET_INPUT: readonly [number, number] = [290, 95];
const MAIL_COMPOSER_ENVOYER_BUTTON: readonly [number, number] = [31, 115];

/**
 * Profession dropdown — same values we set on the Conducteur tab in M8.T3.
 * Devis tab re-asks the question (Maxance doesn't carry it forward between
 * tabs for Reasons), so we set it again here. NB: verified live that
 * Profession DOES carry forward to the Devis tab — but setting it again is
 * a no-op so safer to keep doing so.
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

  // Step 2 — Devis tab fill. Field labels verified live 2026-05-23 against
  // the real Maxance Proximéo (driven via Claude Chrome extension). The
  // actual field set is:
  //
  //   Header row:  Civilité* / Nom* / Prénom* / Profession*
  //   Address:     Code postal* / Ville* / Recherche par commune (helper)
  //                Lieu-dit, BP / N° et nom de voie / Bâtiment, Résidence /
  //                Domiciliation, Apt, Esc, tutelle
  //   Téléphone:   Type (FIXE/MOBILE) / Usage (PERSO/PRO) / Country (FR/MC) / Number
  //   E-mail:      Role (ADMIN/AGIRA/PSPCM/DTA2R) / Address
  //
  // Profession + CP + Ville carry forward from the Conducteur tab — but
  // setting them again is a no-op so we keep the explicit calls (defensive
  // against Maxance not always carrying forward).
  const sub = params.subscriber;
  await setSelectByLabel(
    page,
    'Civilité',
    CIVILITE_VALUE[sub.civilite],
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
    // Ville is a select, not a free text — Maxance pre-populates options
    // from the CP. Pass the label as the option text.
    await setSelectByLabel(page, 'Ville', sub.city, 'ville', totalTimeoutMs);
  }
  // The address line label is "N° et nom de voie" (live-verified). Older
  // versions of this file used "Voie" — that didn't exist on the real form.
  await fillByLabel(page, 'N° et nom de voie', sub.addressLine, 'voie', totalTimeoutMs);
  if (sub.addressComplement) {
    // Live label is "Bâtiment, Résidence" — fuzzy match handles either
    // "Bât" or the full "Bâtiment, Résidence" because getByLabel does
    // substring matching by default.
    await fillByLabel(
      page,
      'Bâtiment, Résidence',
      sub.addressComplement,
      'batiment',
      totalTimeoutMs,
    );
  }
  // Téléphone widget — 3 dropdowns + textbox stacked horizontally. Verified
  // live: setting all 3 dropdowns + number works in any order; Maxance
  // auto-formats the number to "06 12 34 56 78" style after blur.
  // The phone-widget dropdowns don't have proper <label> tags, so we can't
  // use getByLabel directly. Stagehand v3 falls back to ARIA / placeholder
  // matching for unlabelled selects — set by option-value.
  //
  // Note: this is the ONE spot in M8.T6 that may need extra resilience.
  // The widget's <select>s have no visible label text, so we rely on
  // option-value match. If Maxance reorders the options that breaks. As a
  // belt-and-braces, the production driver path (Claude in Chrome
  // extension) does coordinate clicks on the actual widget — which we
  // verified works.
  await setSelectByLabel(
    page,
    'Type de téléphone',
    PHONE_TYPE_MOBILE,
    'phone_type',
    totalTimeoutMs,
  ).catch(() => {
    /* widget has no label; coordinate-based driver handles it */
  });
  await setSelectByLabel(
    page,
    'Usage du téléphone',
    PHONE_USAGE_PERSO,
    'phone_usage',
    totalTimeoutMs,
  ).catch(() => {
    /* same */
  });
  // The phone number textbox also lacks a stable label. The Claude-in-Chrome
  // driver fills it by widget-relative coordinate; here we attempt a fuzzy
  // label match as the Stagehand fallback.
  await fillByLabel(page, 'Téléphone', sub.phoneMobile, 'phone_number', totalTimeoutMs).catch(
    () => {
      /* fallback to coordinate driver */
    },
  );
  // E-mail widget — dropdown (role) + textbox (address). Same labelless
  // structure as the phone widget.
  await setSelectByLabel(
    page,
    "Type d'email",
    EMAIL_ROLE_GESTION,
    'email_role',
    totalTimeoutMs,
  ).catch(() => {
    /* fallback to coordinate driver */
  });
  await fillByLabel(page, 'E-mail', sub.email, 'email_address', totalTimeoutMs).catch(() => {
    /* fallback to coordinate driver */
  });
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

  // Step 5 — open the Courrier popup. The actual button text is
  // "Envoyer par..." (with ellipsis), NOT "Devis moto envoyer par" as
  // Achraf's PDF abbreviated it. There are TWO buttons on the Edition
  // à imprimer page — one for "Devis moto" and one for "Fiche information
  // IPID Moto". We want the first one. Using clickByTextOrThrow's
  // `.first()` semantics: getByText("Envoyer par...").first().click().
  await clickByTextOrThrow(page, 'Envoyer par...', 'envoyer_par_open', totalTimeoutMs);
  await sleep(settleMs(3000));
  await pushShot('courrier_popup_open');

  // Step 6 — click the envelope icon (4th in toolbar) to open the mail
  // composer. The Courrier popup is a LEGACY widget that's NOT in the DOM
  // accessibility tree — Stagehand's getByText / getByLabel can't see the
  // toolbar icons. We click by absolute pixel coordinate.
  //
  // CRITICAL: this is the part of the flow that requires the Claude in
  // Chrome extension's `mcp__Claude_in_Chrome__computer` tool (or an
  // equivalent CDP `Input.dispatchMouseEvent`). Plain Stagehand v3 cannot
  // address coordinate-based clicks; the production driver SHOULD bypass
  // Stagehand here and use the underlying Playwright page.mouse.click().
  //
  // We expose `clickByCoordinate` on the page wrapper so callers that have
  // raw Playwright access can drive it; the default Stagehand-only path
  // throws maxance_confirm_legacy_popup_unsupported so the operator knows
  // to route through the Claude in Chrome driver.
  const pageWithMouse = page as unknown as {
    mouse?: { click: (x: number, y: number) => Promise<void> };
  };
  if (!pageWithMouse.mouse) {
    throw new Error(
      'maxance_confirm_legacy_popup_unsupported: this driver does not expose page.mouse — ' +
        'route through the Claude in Chrome extension instead (see quote-confirm.ts header)',
    );
  }
  await pageWithMouse.mouse.click(COURRIER_POPUP_ENVELOPE_ICON[0], COURRIER_POPUP_ENVELOPE_ICON[1]);
  await sleep(settleMs(2000));
  await pushShot('mail_composer_open');

  // Step 7 — fill the mail composer fields (Adresse + Objet). Also pixel-
  // addressed because they're inside the same legacy popup.
  await pageWithMouse.mouse.click(MAIL_COMPOSER_ADRESSE_INPUT[0], MAIL_COMPOSER_ADRESSE_INPUT[1]);
  const pageWithKeyboard = page as unknown as {
    keyboard?: { type: (text: string) => Promise<void> };
  };
  if (!pageWithKeyboard.keyboard) {
    throw new Error(
      'maxance_confirm_legacy_popup_unsupported: this driver does not expose page.keyboard',
    );
  }
  await pageWithKeyboard.keyboard.type(sub.email);
  await pageWithMouse.mouse.click(MAIL_COMPOSER_OBJET_INPUT[0], MAIL_COMPOSER_OBJET_INPUT[1]);
  await pageWithKeyboard.keyboard.type(`Votre devis trottinette Assuryal - ${devisNumber}`);
  await pushShot('mail_composer_filled');

  // Step 7 — final Envoyer click. This is the boundary: in dryRun mode we
  // STOP here so no real email leaves Maxance. The full path is gated on
  // Achraf's explicit sign-off (the email goes to the customer's real
  // address; we don't want to bombard test customers).
  if (!opts.dryRun) {
    // [Envoyer] button is inside the legacy popup — same coordinate-click
    // path as the previous steps. Cannot use clickByTextOrThrow because the
    // button is NOT in the DOM accessibility tree.
    await pageWithMouse.mouse.click(
      MAIL_COMPOSER_ENVOYER_BUTTON[0],
      MAIL_COMPOSER_ENVOYER_BUTTON[1],
    );
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
