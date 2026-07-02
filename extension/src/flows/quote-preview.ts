/**
 * quote.preview flow — V1 Chrome-extension Maxance driver.
 *
 * Replicates the M8.T3 Stagehand step planner using vanilla DOM ops in
 * the user's daily Chrome. The selectors + form values are imported
 * directly from `../maxance/selectors` — single source of truth, no
 * duplication.
 *
 * Pre-condition: caller has already run login.ensure successfully on
 * the same tab. We're on a page within /Proximeo/.
 *
 * Steps (each emits a progress event):
 *   1. Reach the vehicle picker (click "Tarif - Nouveau Client" → "2
 *      roues et quads" if not already there).
 *   2. Véhicule tab — fill Marque / Cylindrée / dates / Version / Type
 *      d'acquisition / Stationnement / CP. Click "Suivant >>".
 *   3. Dismiss the "bridled at 25 km/h" bridge modal if it appears
 *      (press Enter — Confirmer is the default).
 *   4. Conducteur tab — Date de naissance + Profession + 3 Antécédents
 *      radios all set to Non. Click "Suivant >>".
 *   5. Garanties tab — pick formule, set commission slider, choose
 *      fractionnement. Wait for the price preview to render.
 *   6. Extract monthly + annual prices via parseEurPrice.
 *
 * NEVER clicks "Valider devis" or "Valider souscription" here — those
 * are the quote.confirm flow's concern. dryRun is structurally enforced
 * by the wire schema (the QuotePreviewCommand requires dryRun: true).
 */
import {
  CYLINDREE_TROTTINETTE,
  MARQUE_TROTTINETTE,
  PROFESSION_EMPLOYE_SECTEUR_PRIVE,
  TYPE_ACQUISITION_REMPLACEMENT,
  clampCommissionPct,
  formatIsoDateFr,
  formuleLabel,
  stationnementOption,
  trottinetteVersionBand,
} from '../maxance/selectors.js';
import {
  captureScreenshot,
  clickByText,
  clickMaxanceButton,
  fillByLabel,
  findSelectByOptionValue,
  parseEurPrice,
  setRadioByQuestion,
  setSelectByLabel,
  setSelectValue,
  sleep,
  waitFor,
} from '../dom.js';
import {
  GarantiesNavigatedError,
  applyGarantiesConfig,
  extractComptantBreakdown,
  parseGarantiesAdditionnelles,
} from './garanties-controls.js';
import {
  type AddOnPricing,
  type ComptantBreakdown,
  type FormulePricing,
  type QuotePreviewCommandSchema,
  QuotePreviewResponseSchema,
  QuotePreviewNavigatingResponseSchema,
  ErrorResponseSchema,
  type Response,
  type Screenshot,
} from '../wire.js';
import { reportProgress } from './progress.js';
import type { z } from 'zod';

type QuotePreviewCommand = z.infer<typeof QuotePreviewCommandSchema>;

/** Best-effort settle pause between framework navigations. */
const SETTLE_MS = 600;

/**
 * Probe which Proximéo screen we're currently on, by looking for
 * marker elements rather than parsing the URL (the wizard reuses the
 * same .do endpoint for multiple tabs).
 */
function detectCurrentScreen():
  | 'sso_transient'
  | 'vehicle_picker'
  | 'vehicule_tab'
  | 'conducteur_tab'
  | 'garanties_tab'
  | 'bridge_modal'
  | 'price_preview'
  | 'unknown' {
  // Phase-2f-8 (2026-05-25 PM live-diag fix): the "vitesse du NVEI doit
  // être limitée à 25 km/h" notice is NOT a popin/modal — it's inline
  // text on the Garanties tab body (an informational warning about NVEI
  // speed-limit compliance). The previous detector returned 'bridge_modal'
  // whenever the text was present anywhere on the page, which caused the
  // orchestrator to loop on the bridge_modal case (whose dismiss code did
  // nothing because there's nothing to dismiss). Removed the text-based
  // detection. If a real popin/dialog appears in some future flow, add
  // detection against a positioned container (z-index > 100 OR position
  // fixed/absolute with role=dialog), not raw text matching.

  // Phase-2f-5 root-cause fix (2026-05-25): the previous detector chained
  // text-search fallbacks ending with "any element whose text contains
  // 'Tarif - Nouveau Client' → vehicle_picker". But that string lives in
  // the top menu strip of EVERY Proximéo page (TRF tab label), so the
  // Conducteur tab matched it and the orchestrator looped re-clicking
  // MOTO. Diagnostic on 2026-05-25 PM confirmed: Suivant on Véhicule had
  // been navigating cleanly to /souscriptionNaviguerOngletVehicule.do all
  // along — the bouncing was the screen DETECTION misreading Conducteur as
  // vehicle_picker. Switch to URL as the authoritative dispatcher (the
  // wizard's .do endpoints are stable + 1:1 with tabs), with DOM markers
  // only used to disambiguate the one URL that hosts two tabs (Conducteur
  // and Garanties share /souscriptionNaviguerOngletVehicule.do; content
  // swaps in-place after Conducteur's Suivant fires).
  const path = location.pathname;

  // /ConnexionCourtierSSOCallback.do = the OAuth2 authorization-code
  // callback Maxance redirects THROUGH during SSO (carries ?code=&state=).
  // Normally it immediately redirects to /accueil.do, but it can wedge
  // (observed live 2026-05-31: the tab sat on
  // ConnexionCourtierSSOCallback.do?code=… and the flow died with
  // "advance loop exhausted on screen=unknown"). Treat it as a transient
  // — the loop self-navigates to /accueil.do to re-enter cleanly. Must be
  // checked BEFORE the picker regex (whose `$` anchor wouldn't match the
  // "Callback" suffix anyway, but order makes the intent explicit).
  if (/\/ConnexionCourtierSSOCallback\.do$/i.test(path)) {
    return 'sso_transient';
  }

  // /accueil.do (or /ConnexionCourtierSSO.do landing) = vehicle picker home.
  if (/\/(accueil|ConnexionCourtierSSO)\.do$/i.test(path)) {
    return 'vehicle_picker';
  }

  // /initialiserSession.do(?branche=MOTO|AUTO|…) = Véhicule wizard tab.
  if (/\/initialiserSession\.do$/i.test(path)) {
    return 'vehicule_tab';
  }

  // /souscriptionNaviguerOngletVehicule.do hosts Conducteur first, then
  // Garanties (content swap after Conducteur Suivant). Disambiguate by:
  //   - presence of `currentConducteur.flagAucunPermis` checkbox → Conducteur
  //     (stable-named per the verified DOM map in project_m8_t8_progress.md)
  //   - "tiers illimité" text → Garanties (+ a parsed price → price_preview)
  if (/\/souscriptionNaviguerOngletVehicule\.do$/i.test(path)) {
    if (document.querySelector('input[name="currentConducteur.flagAucunPermis"]')) {
      return 'conducteur_tab';
    }
    const garantiesMarker = Array.from(document.querySelectorAll('*')).find((el) =>
      /tiers illimité/i.test(el.textContent ?? ''),
    );
    if (garantiesMarker) {
      const priceText = document.body.innerText;
      if (parseEurPrice(priceText) !== null) return 'price_preview';
      return 'garanties_tab';
    }
    // URL says wizard tab but markers absent — page may still be loading.
    return 'unknown';
  }

  // Fallback markers (in case Maxance changes URLs or we land somewhere
  // unexpected). Order matters: more-specific markers first.
  const garantiesMarker = Array.from(document.querySelectorAll('*')).find((el) =>
    /tiers illimité/i.test(el.textContent ?? ''),
  );
  if (garantiesMarker) {
    const priceText = document.body.innerText;
    if (parseEurPrice(priceText) !== null) return 'price_preview';
    return 'garanties_tab';
  }
  if (document.querySelector('input[name="currentConducteur.flagAucunPermis"]')) {
    return 'conducteur_tab';
  }
  if (document.querySelector('select[name="vehiculeMarque"]')) {
    return 'vehicule_tab';
  }
  // No reliable picker-only marker exists in the DOM (the top menu strip's
  // #TRF/#MOTO and "Tarif - Nouveau Client" text are present on EVERY
  // Proximéo wizard page). Returning 'unknown' lets the outer loop retry
  // after a settle pause — preferable to misclassifying.
  return 'unknown';
}

/**
 * From the Proximéo home (vehicle picker), navigate to the Véhicule tab.
 *
 * IMPORTANT: clicking "2 roues et quads" triggers a TOP-FRAME NAVIGATION
 * to `/Proximeo/initialiserSession.do?branche=MOTO`. The content script
 * that runs this code dies the instant the navigation commits. We
 * therefore do NOT wait for the destination here — we just click and
 * return. The SW orchestrator (phase 2e) awaits
 * `chrome.webNavigation.onCompleted` for the same tab, then re-invokes
 * `runQuotePreview` against the freshly-injected content script in the
 * new page (where `detectCurrentScreen()` will now return 'vehicule_tab'
 * and the switch will fall through to `fillVehiculeTab`).
 */
async function triggerNavigationToVehicule(cmd: QuotePreviewCommand): Promise<void> {
  const screen = detectCurrentScreen();
  await reportProgress(cmd.id, 'navigate_to_picker', `current=${screen}`);

  // Maxance's Proximéo menu items have stable IDs (TRF, MOTO, AUTO, …) set
  // by the `MainMenu_0CreateOnglet(...)` JSP-emitted bootstrap script. The
  // sub-menu items (MOTO under TRF) are `display:none` until the parent
  // menu is hovered/expanded — `clickByText('2 roues et quads')` finds the
  // outer #TRF wrapper instead (TRF's textContent contains all submenu
  // labels) and clicking #TRF just expands the menu without navigating.
  // We loop forever in that case (proved in the live phase-2e run on
  // 2026-05-25). Click MOTO directly by ID — `el.click()` fires the
  // attached handler regardless of CSS visibility, which is exactly the
  // behavior we need to bypass the hover-gated reveal.
  const moto = document.getElementById('MOTO');
  if (!moto) {
    throw new Error('maxance_menu_moto_not_found:#MOTO missing in Proximéo home DOM');
  }
  moto.click();
  // Do NOT await navigation here — the SW orchestrator owns that.
}

async function fillVehiculeTab(cmd: QuotePreviewCommand): Promise<void> {
  const { params } = cmd;
  const purchaseDateFr = formatIsoDateFr(params.purchaseDate);

  await reportProgress(cmd.id, 'vehicule_tab_filling');
  await setSelectByLabel('Marque', MARQUE_TROTTINETTE, { label: 'marque' });
  await setSelectByLabel('Cylindrée', CYLINDREE_TROTTINETTE, { label: 'cylindree' });
  await fillByLabel('Première mise en circulation', purchaseDateFr, {
    label: 'mise_en_circulation',
  });
  await setSelectByLabel('Version', trottinetteVersionBand(params.purchasePriceEur), {
    label: 'version_band',
  });
  await setSelectByLabel(
    "Type d'acquisition du véhicule à assurer",
    TYPE_ACQUISITION_REMPLACEMENT,
    {
      label: 'type_acquisition',
    },
  );
  await fillByLabel("Date d'acquisition", purchaseDateFr, { label: 'date_acquisition' });
  const st = stationnementOption(params.stationnement);
  await setSelectByLabel('Stationnement', st.value, { label: 'stationnement' });
  await fillByLabel('Code postal', params.postalCode, { label: 'cp' });

  // Profession — the M8.T3 era believed the Véhicule tab carried a
  // Profession dropdown; the 2026-05-25 live phase-2e MCP investigation
  // proved it does NOT. The 12 selects on the wizard are: critereSelected,
  // vehiculeMarque, vehiculeCylindree, vehiculeVersion, typeAssurance,
  // mouvement.codeModeStationnement, protectionVol, mouvement.leasing,
  // vehiculeUsage, circulationZonier.key, + 2 jwt-blocked. No Profession.
  // It's set on the Devis tab in the confirm flow instead.

  // CP triggers an AJAX cascade that populates <select name="circulationZonier.key">
  // (the commune lookup). Maxance auto-selects the single matching option
  // (e.g. "75011|75111|PARIS 11") only AFTER the AJAX response. If we click
  // Suivant before that auto-selection lands, the form posts an empty
  // circulationZonier.key and Maxance's server silently redirects back to
  // the Proximéo home (no banner — the field is form-internal). This was
  // the validerVehicule-loops-back bug observed in the phase-2e live run
  // on 2026-05-25; root-caused by phase-2f MCP diagnostic on 2026-05-25:
  // a 2s pause after CP fill let the zonier auto-select and Suivant landed
  // cleanly on Conducteur. We poll for a non-empty value rather than fixed
  // sleep so we cover slow-network cases without padding the happy path.
  let zonierStatus = 'ok';
  const zonier = await waitFor<HTMLSelectElement>(
    () => {
      const z = document.querySelector<HTMLSelectElement>('select[name="circulationZonier.key"]');
      return z && (z.value.length > 0 || z.options.length > 1) ? z : null;
    },
    { label: 'await_zonier_populated', timeoutMs: 8_000 },
  ).catch(() => {
    // Best-effort: if zonier doesn't populate in 8s the click below will
    // likely fail and the server bounce will surface, but we don't want to
    // throw a tagged error here when the real failure mode is a server
    // round-trip — let validerVehicule's outcome drive the diagnosis.
    zonierStatus = 'timeout';
    return null;
  });

  // Multi-commune postal codes (e.g. 87100 Limoges — Achraf's live test
  // 2026-07-02): Maxance populates the commune options but does NOT
  // auto-select, and Suivant raises the modal ALERTE "La valeur du champ
  // 'Ville' est obligatoire" — the wizard loops on vehicule_tab until the
  // orchestrator's 240s hard timeout. Pick the commune ourselves: match
  // the lead's city when provided, else take the first real option.
  if (zonier && !zonier.value) {
    const communes = Array.from(zonier.options).filter((o) => o.value && o.value.length > 0);
    const cityNeedle = (params.city ?? '').trim().toLowerCase();
    const match =
      (cityNeedle
        ? communes.find((o) => (o.textContent ?? '').trim().toLowerCase().includes(cityNeedle))
        : undefined) ?? communes[0];
    if (match) {
      setSelectValue(zonier, match.value);
      zonierStatus = `selected:${match.value}`;
    } else {
      zonierStatus = 'no_options';
    }
  }

  // Phase-2f-diag: dump every form value right before Suivant so the backend
  // log shows exactly what Maxance sees on the post. If the loop-back
  // continues, this tells us which field is empty / wrong.
  const formDump: Record<string, unknown> = { zonierStatus };
  for (const n of [
    'vehiculeMarque',
    'vehiculeCylindree',
    'vehiculeVersion',
    'typeAssurance',
    'mouvement.codeModeStationnement',
    'protectionVol',
    'mouvement.leasing',
    'vehiculeUsage',
    'circulationZonier.key',
  ]) {
    const el = document.querySelector<HTMLSelectElement>(`select[name="${n}"]`);
    formDump[n] = el ? { value: el.value, opt: el.options.length } : 'MISSING';
  }
  for (const n of [
    'mouvement.dateMiseEnCirculation',
    'mouvement.dateAchatVehicule',
    'circulationZonier.codePostal',
    'mouvement.dateEffet',
  ]) {
    const el = document.querySelector<HTMLInputElement>(`input[name="${n}"]`);
    formDump[n] = el ? el.value : 'MISSING';
  }
  await reportProgress(cmd.id, 'vehicule_form_dump', JSON.stringify(formDump));

  await sleep(SETTLE_MS);
  // Maxance's Suivant button is a `<div id="validerVehicule"><div class="buttonMiddle">Suivant >></div>`
  // whose onclick fires on `mouseup` of .buttonMiddle. `clickByText` finds
  // the wrong wrapper + `.click()` doesn't trigger the handler — use the
  // dedicated helper that dispatches mousedown+mouseup+click on the right
  // child. Verified live 2026-05-25 phase 2e.
  await clickMaxanceButton('validerVehicule', { label: 'suivant_vehicule' });
}

async function fillConducteurTab(cmd: QuotePreviewCommand): Promise<void> {
  const { params } = cmd;
  // Caller has already established we're on conducteur_tab via the
  // SW-orchestrated advance — no need to wait again.
  //
  // Live phase-2e MCP investigation (2026-05-25) mapped the Conducteur tab
  // field set verbatim. The field NAMES are JWT-encoded (Maxance encrypts
  // form field names to deter scraping), so we match by question text in
  // the surrounding layout cells. Required fields are marked with * in the
  // Maxance UI.
  await reportProgress(cmd.id, 'conducteur_tab_filling');

  // 1. Date de naissance (required *) — text input "dd/mm/yyyy"
  await fillByLabel('Date de naissance', formatIsoDateFr(params.clientDateOfBirth), {
    label: 'dob',
  });

  // 2. Trottinette has no driver's permit. Check the "Aucun permis"
  //    checkbox — this is the one stable-named field on the page:
  //    `<input type="checkbox" name="currentConducteur.flagAucunPermis">`.
  const aucunPermis = document.querySelector<HTMLInputElement>(
    'input[name="currentConducteur.flagAucunPermis"]',
  );
  if (aucunPermis && !aucunPermis.checked) {
    aucunPermis.checked = true;
    aucunPermis.dispatchEvent(new Event('click', { bubbles: true }));
    aucunPermis.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 3. Profession (required *) — the select's name is JWT-encoded but
  //    it's the ONLY select on the page with value "125" (Employé secteur
  //    privé) in its options. Find by option-value match.
  const profSel = findSelectByOptionValue(PROFESSION_EMPLOYE_SECTEUR_PRIVE);
  if (profSel) {
    setSelectValue(profSel, PROFESSION_EMPLOYE_SECTEUR_PRIVE);
  }

  // 4. Risk-aggravés radios — ALL three set to "N" (Non). Match the
  //    target group by the French question's distinctive substring.
  await reportProgress(cmd.id, 'conducteur_tab_risk_radios');
  setRadioByQuestion('résiliation par votre assureur', 'N');
  setRadioByQuestion('condamnation pour délit de fuite', 'N');
  setRadioByQuestion("annulation, d'une suspension", 'N');

  // 5. "Le conducteur principal est-il" radios — both set to "O" (Oui)
  //    so the conducteur IS the souscripteur AND IS the titulaire carte
  //    grise. This is the default for a self-quote.
  setRadioByQuestion('Souscripteur', 'O');
  setRadioByQuestion('Titulaire carte grise', 'O');

  // Phase-2f-6 diag: dump conducteur form state right before Suivant so
  // we can see which required field is missing if the swap-to-garanties
  // doesn't happen. Strategy: enumerate all visible inputs/selects, key
  // by name (or id), record value/checked/options-count.
  const cDump: Record<string, unknown> = {};
  document.querySelectorAll<HTMLInputElement>('input').forEach((el) => {
    if (!el.name && !el.id) return;
    const key = el.name || el.id;
    if (el.type === 'radio') {
      if (el.checked) cDump[`radio:${key}=${el.value}`] = 'checked';
    } else if (el.type === 'checkbox') {
      cDump[`cb:${key}`] = el.checked;
    } else if (el.type === 'hidden') {
      // skip hiddens — too noisy
    } else {
      cDump[`inp:${key}`] = el.value;
    }
  });
  document.querySelectorAll<HTMLSelectElement>('select').forEach((el) => {
    const key = el.name || el.id || '?';
    cDump[`sel:${key}`] = { v: el.value, opt: el.options.length };
  });
  await reportProgress(cmd.id, 'conducteur_form_dump', JSON.stringify(cDump));

  await sleep(SETTLE_MS);
  await clickMaxanceButton('validerConducteur', { label: 'suivant_conducteur' });

  // Bridge modal CAN pop here (the 25 km/h NVEI warning) but in the live
  // phase-2e test it did NOT — Garanties rendered immediately. Either way
  // the SW-orchestrated advance handles whatever screen we land on next:
  // if a bridge modal appears, the next iteration detects + dismisses it.
}

async function configureGarantiesAndExtract(cmd: QuotePreviewCommand): Promise<{
  monthly?: number;
  annual?: number;
  comptantBreakdown: ComptantBreakdown;
  formulePricing: FormulePricing[];
  addOns: AddOnPricing;
}> {
  const { params } = cmd;
  // Caller has established we're on garanties_tab via the SW-orchestrated
  // advance.
  //
  // Live phase-2e MCP investigation (2026-05-25) finding: the Garanties
  // tab automatically renders prices for ALL THREE formules upfront. The
  // body text reads (table layout):
  //
  //   Formules de garanties              Montant
  //     Tiers illimité                    78.85
  //     Tiers illimité + Vol Incendie    160.11
  //     Dommages tous accidents          239.10
  //
  //   Fractionnement   Comptant  Terme suivant  Coût annuel brut**
  //                     25.99      7.57          90.85
  //
  // ⚠️ PRICE SEMANTICS (Achraf, 2026-07-02): the formules-table Montant is
  // the ANNUAL premium — NOT the monthly price (old builds sent 66,20 € as
  // "Mensuel"; the real monthly was 6,51 €). The customer-facing monthly is
  // the fractionnement row's "Terme suivant" (fractionnement mensuel), which
  // re-renders per SELECTED formule. So we click each formule radio in turn
  // (requested formule LAST, leaving the tab configured for quote.confirm)
  // and read its row — exact numbers, ~5-6s AJAX per switch.
  //
  // M8.T7 B1 (2026-06-11): the default prices render at the DEFAULT
  // commission (9%) — wrong per Achraf (commission must ALWAYS be 22%). The
  // first applyGarantiesConfig call forces clamp(params.commissionPct ?? 22);
  // subsequent calls read 'already' (no extra AJAX).
  await reportProgress(cmd.id, 'garanties_apply_config');

  const requested = params.formule ?? 'tiers_illimite';
  const allFormules = ['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents'] as const;
  const ordered = [...allFormules.filter((f) => f !== requested), requested];

  const commissionPct = clampCommissionPct(params.commissionPct ?? 22);
  const formulePricing: FormulePricing[] = [];
  let prevRowKey = '';
  for (const f of ordered) {
    const cfgResult = await applyGarantiesConfig({
      commissionPct,
      formule: f,
      ...(params.fractionnement !== undefined ? { fractionnement: params.fractionnement } : {}),
    });
    await reportProgress(cmd.id, 'garanties_config_applied', `${f}:${JSON.stringify(cfgResult)}`);

    // Wait for the formule's label + its sibling number to appear in body.
    // Maxance's table cells are tab-separated when extracted via innerText.
    const annualPremium = await waitFor<number>(() => extractFormulePrice(formuleLabel(f)), {
      label: `await_formule_price:${f}`,
      timeoutMs: 20_000,
    });
    // The fractionnement row re-renders ASYNCHRONOUSLY after the formule
    // switch — reading too early returns an EMPTY row (live 2026-07-02:
    // vol_incendie's terme suivant was missing from Achraf's first menu) or
    // the PREVIOUS formule's numbers. Poll until the row is present AND
    // differs from the previous formule's row; accept whatever is there
    // after the timeout (best-effort — an omitted line beats a wrong one).
    const row = await waitFor<ReturnType<typeof extractComptantBreakdown>>(
      () => {
        const r = extractComptantBreakdown();
        if (r.termeSuivantEur === undefined) return null;
        return JSON.stringify(r) !== prevRowKey ? r : null;
      },
      { label: `await_fractionnement_row:${f}`, timeoutMs: 8_000 },
    ).catch(() => extractComptantBreakdown());
    prevRowKey = JSON.stringify(row);
    formulePricing.push({
      formule: f,
      ...(Number.isFinite(annualPremium) ? { annualPremiumEur: annualPremium } : {}),
      ...(row.comptantEur !== undefined ? { comptantEur: row.comptantEur } : {}),
      ...(row.termeSuivantEur !== undefined ? { termeSuivantEur: row.termeSuivantEur } : {}),
      ...(row.coutAnnuelBrutEur !== undefined ? { coutAnnuelBrutEur: row.coutAnnuelBrutEur } : {}),
    });
  }

  await reportProgress(cmd.id, 'garanties_tab_extract');

  // M8.T7 B1: comptant breakdown off the FINAL (requested-formule) render —
  // fractionnement row numbers + Frais comptant from the hidden
  // commptant_<code> popup. Best-effort pure DOM read.
  const comptantBreakdown = extractComptantBreakdown();
  // Garanties-additionnelles annual prices — pure text read, no clicks
  // (preview NEVER ticks the checkboxes; quote.confirm does, on request).
  const addOns = parseGarantiesAdditionnelles(document.body.innerText);
  await reportProgress(
    cmd.id,
    'garanties_pricing_extracted',
    JSON.stringify({ formulePricing, addOns }),
  );

  const requestedRow = formulePricing[formulePricing.length - 1];
  const out: {
    monthly?: number;
    annual?: number;
    comptantBreakdown: ComptantBreakdown;
    formulePricing: FormulePricing[];
    addOns: AddOnPricing;
  } = { comptantBreakdown, formulePricing, addOns };
  // monthly = the requested formule's "Terme suivant" — only meaningful on a
  // monthly fractionnement (the select defaults to Mensuel on this product).
  const fractionnement = comptantBreakdown.fractionnement ?? 'mensuel';
  if (fractionnement === 'mensuel' && requestedRow?.termeSuivantEur !== undefined) {
    out.monthly = requestedRow.termeSuivantEur;
  }
  const annual = comptantBreakdown.coutAnnuelBrutEur ?? requestedRow?.annualPremiumEur;
  if (annual !== undefined) out.annual = annual;
  return out;
}

/**
 * Extract the EUR price for a given formule label from the Garanties tab.
 * Maxance renders the formules table as plain text rows (innerText with
 * tab separators between label and montant cell):
 *
 *   "Tiers illimité\t78.85\t"
 *
 * Returns null if the label is present but no number follows on the same
 * line yet (page still loading) — waitFor polls.
 */
function extractFormulePrice(label: string): number | null {
  const body = document.body.innerText;
  // Match the label, optional whitespace, then a number like "78.85" or "1 234,56".
  // The number may be on the same line OR the immediately-next line in
  // multi-line table renders.
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Try: same-line match first.
  const sameLineRe = new RegExp(`${escapedLabel}\\s*[\\t ]+(\\d[\\d\\s]*[,.]\\d{2})`, 'i');
  const sameLine = sameLineRe.exec(body);
  if (sameLine?.[1]) {
    return Number.parseFloat(sameLine[1].replace(/\s/g, '').replace(',', '.'));
  }
  // Try: label then newline then number.
  const multiLineRe = new RegExp(`${escapedLabel}\\s*\\n\\s*(\\d[\\d\\s]*[,.]\\d{2})`, 'i');
  const multi = multiLineRe.exec(body);
  if (multi?.[1]) {
    return Number.parseFloat(multi[1].replace(/\s/g, '').replace(',', '.'));
  }
  return null;
}

/**
 * Single-screen advance of the quote.preview flow (M8.T8 phase 2e).
 *
 * The previous "do everything in one async function" approach broke
 * because Maxance triggers a top-frame navigation between EVERY wizard
 * step — the content script's JS context dies mid-await every time. This
 * function does as much work as possible WITHIN the current page, then:
 *
 *   - returns `quote.preview.navigating` when it just clicked a control
 *     that triggers a top-frame navigation (the SW orchestrator waits for
 *     the new page to load + calls `runQuotePreview` again against the
 *     fresh content script — same `cmd.id`, accumulating screenshots),
 *   - returns `quote.preview.ok` when it reaches the price preview, OR
 *   - returns `error` on any timeout / DOM mismatch.
 *
 * Idempotent + restartable: each invocation calls `detectCurrentScreen()`
 * first and dispatches based on where we currently are. The same function
 * runs in EVERY content-script instance Chrome creates across the
 * navigation chain.
 *
 * Screens handled, in nav order:
 *   - bridge_modal  → dismiss in-place, retry detect (no navigation)
 *   - vehicle_picker → click TRF + MOTO → navigates → returns navigating
 *   - vehicule_tab  → fill all fields + click Suivant → navigates → returns navigating
 *   - conducteur_tab → fill all fields + click Suivant → may navigate OR
 *     pop bridge modal; we click Suivant and return navigating, the SW
 *     handles whether a real nav happened
 *   - garanties_tab / price_preview → configure formule + extract price → DONE
 */
export async function runQuotePreview(cmd: QuotePreviewCommand): Promise<Response> {
  const t0 = Date.now();
  const screenshots: Screenshot[] = [];
  const shoot = async (step: string): Promise<void> => {
    try {
      screenshots.push(await captureScreenshot(step));
    } catch {
      /* screenshot is best-effort; don't fail the flow */
    }
  };

  const navigating = (fromScreen: string, expectedScreen: string): Response =>
    QuotePreviewNavigatingResponseSchema.parse({
      id: cmd.id,
      kind: 'quote.preview.navigating',
      fromScreen,
      expectedScreen,
      screenshots,
    });

  try {
    // Settle pause so freshly-loaded pages have a moment to run their
    // post-load script (Maxance's `MainMenu` etc.) before we sniff state.
    await sleep(SETTLE_MS);

    // Outer safety loop: handles intra-page transitions (e.g. bridge_modal
    // dismissal that doesn't navigate). Capped to avoid an infinite churn
    // if detectCurrentScreen flaps.
    for (let iter = 0; iter < 4; iter += 1) {
      const screen = detectCurrentScreen();
      await reportProgress(cmd.id, 'advance_iter', `screen=${screen}`);

      if (screen === 'sso_transient') {
        // Wedged on the SSO authorization-code callback. The page won't
        // advance on its own (the one-shot code is already spent on reload).
        // Re-enter the Proximéo home, which silently re-auths if the Auth0
        // cookie is still valid (~30d) or surfaces a login screen otherwise
        // (handled downstream as an unknown-screen timeout → login.ensure
        // human escalation). Navigating ends this content script; the SW
        // orchestrator awaits webNavigation.onCompleted and re-invokes on
        // the freshly-loaded page.
        await shoot('sso_transient_pre');
        await reportProgress(cmd.id, 'sso_recover_navigate_home', location.href);
        location.href = '/Proximeo/accueil.do';
        return navigating('sso_transient', 'vehicle_picker');
      }

      if (screen === 'bridge_modal') {
        await shoot('bridge_modal_pre');
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await clickByText('Confirmer', { label: 'bridge_confirm', timeoutMs: 5_000 }).catch(
          () => undefined,
        );
        await sleep(SETTLE_MS);
        continue; // re-detect — bridge dismissal may flip us to garanties_tab
      }

      if (screen === 'vehicle_picker') {
        await shoot('vehicle_picker_pre');
        await triggerNavigationToVehicule(cmd);
        await shoot('after_moto_click');
        return navigating('vehicle_picker', 'vehicule_tab');
      }

      if (screen === 'vehicule_tab') {
        await shoot('vehicule_tab_pre');
        await fillVehiculeTab(cmd);
        await shoot('vehicule_tab_after_suivant');
        return navigating('vehicule_tab', 'conducteur_tab');
      }

      if (screen === 'conducteur_tab') {
        await shoot('conducteur_tab_pre');
        await fillConducteurTab(cmd);
        await shoot('conducteur_tab_after_suivant');
        // Suivant may pop a bridge modal (no nav) OR navigate to garanties.
        // Return navigating either way — if no nav happened, the SW's
        // webNavigation wait will time out cheaply and we'll re-invoke on
        // the SAME page where detectCurrentScreen now reports bridge_modal
        // or garanties_tab. The SW handles the no-nav fallback.
        return navigating('conducteur_tab', 'garanties_tab');
      }

      if (screen === 'garanties_tab' || screen === 'price_preview') {
        await shoot('garanties_tab_pre');
        try {
          const { comptantBreakdown, formulePricing, addOns, ...price } =
            await configureGarantiesAndExtract(cmd);
          await shoot('price_preview');
          return QuotePreviewResponseSchema.parse({
            id: cmd.id,
            kind: 'quote.preview.ok',
            pricePreviewEur: price,
            comptantBreakdown,
            formulePricing,
            addOns,
            screenshots,
            finalUrl: location.href,
            durationMs: Date.now() - t0,
          });
        } catch (gErr) {
          // A Garanties control triggered a full top-frame navigation (the
          // commission onblur — live-observed 2026-07-02). The content script
          // was torn down; hand back to the SW orchestrator, which awaits the
          // reload and re-invokes. On the fresh page the applied control reads
          // 'already' (value persisted by the nav), so the step converges.
          if (gErr instanceof GarantiesNavigatedError) {
            await shoot('garanties_navigated');
            await reportProgress(cmd.id, 'garanties_navigated', `url=${location.href}`);
            return navigating('garanties_tab', 'garanties_tab');
          }
          throw gErr;
        }
      }

      // unknown — give the page another short moment then retry once
      await sleep(SETTLE_MS);
    }

    return ErrorResponseSchema.parse({
      id: cmd.id,
      kind: 'error',
      errorCode: 'maxance_quote_unknown_screen',
      detail: `advance loop exhausted on screen=${detectCurrentScreen()} url=${location.href}`,
      screenshots,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return ErrorResponseSchema.parse({
      id: cmd.id,
      kind: 'error',
      errorCode: msg.startsWith('maxance_') ? msg.split(':')[0] : 'maxance_quote_unknown',
      detail: msg.slice(0, 240),
      screenshots,
    });
  }
}
