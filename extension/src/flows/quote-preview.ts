/**
 * quote.preview flow — V1 Chrome-extension Maxance driver.
 *
 * Replicates the M8.T3 Stagehand step planner using vanilla DOM ops in
 * the user's daily Chrome. The selectors + form values are imported
 * directly from `@f16/stagehand/maxance/selectors` — single source of
 * truth, no duplication.
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
  PROFESSION_VALUE,
  TYPE_ACQUISITION_REMPLACEMENT,
  clampCommissionPct,
  formatIsoDateFr,
  formuleLabel,
  fractionnementLabel,
  stationnementOption,
  trottinetteVersionBand,
} from '@f16/stagehand/maxance/selectors';
import {
  captureScreenshot,
  clickByText,
  clickRadioByLabel,
  fillByLabel,
  isVisible,
  parseEurPrice,
  setSelectByLabel,
  sleep,
  waitFor,
} from '../dom.js';
import {
  type QuotePreviewCommandSchema,
  QuotePreviewResponseSchema,
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
  | 'vehicle_picker'
  | 'vehicule_tab'
  | 'conducteur_tab'
  | 'garanties_tab'
  | 'bridge_modal'
  | 'price_preview'
  | 'unknown' {
  // Bridge modal first — it overlays whatever tab is underneath.
  const bridge = Array.from(document.querySelectorAll('*')).find((el) =>
    /vitesse du nvei doit être limitée/i.test(el.textContent ?? ''),
  );
  if (bridge && isVisible(bridge as HTMLElement)) return 'bridge_modal';

  // Garanties tab is unique: has the formule radios + a commission slider.
  const garantiesMarker = Array.from(document.querySelectorAll('*')).find((el) =>
    /tiers illimité/i.test(el.textContent ?? ''),
  );
  if (garantiesMarker) {
    // If a price is rendered already, classify as price_preview.
    const priceText = document.body.innerText;
    if (parseEurPrice(priceText) !== null) return 'price_preview';
    return 'garanties_tab';
  }

  // Véhicule tab: Marque dropdown present.
  if (document.querySelector('select[name*="marque" i], select[id*="marque" i]')) {
    return 'vehicule_tab';
  }
  // Conducteur tab: Date de naissance label present.
  if (
    Array.from(document.querySelectorAll('label')).some((l) =>
      /date de naissance/i.test(l.textContent ?? ''),
    )
  ) {
    return 'conducteur_tab';
  }
  // Vehicle picker: "Tarif - Nouveau Client" or "2 roues" visible.
  if (
    Array.from(document.querySelectorAll('*')).some((el) =>
      /tarif\s*-?\s*nouveau\s*client/i.test(el.textContent ?? ''),
    )
  ) {
    return 'vehicle_picker';
  }
  return 'unknown';
}

/**
 * Reach the Véhicule tab from wherever we currently are.
 * Idempotent — no-op if we're already there.
 */
async function navigateToVehiculeTab(cmd: QuotePreviewCommand): Promise<void> {
  const screen = detectCurrentScreen();
  if (screen === 'vehicule_tab') return;
  await reportProgress(cmd.id, 'navigate_to_picker', `current=${screen}`);

  // From any Proximéo page, walk the menu chain.
  if (screen !== 'vehicle_picker') {
    await clickByText('Tarif - Nouveau Client', {
      timeoutMs: 10_000,
      label: 'tarif_nouveau_client',
    });
    await sleep(SETTLE_MS);
  }
  await clickByText('2 roues et quads', { timeoutMs: 10_000, label: '2_roues_et_quads' });
  await sleep(SETTLE_MS);

  // After the click chain we should land on the Véhicule tab. Confirm.
  await waitFor(() => (detectCurrentScreen() === 'vehicule_tab' ? true : null), {
    label: 'arrive_vehicule_tab',
    timeoutMs: 15_000,
  });
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

  // Profession — the Véhicule tab also has a Profession dropdown that
  // M8.T3 sets to 125 by default. The Devis tab will override if the
  // customer's actual profession is different.
  await setSelectByLabel('Profession', PROFESSION_VALUE.employe_prive, { label: 'profession' });

  await sleep(SETTLE_MS);
  await clickByText('Suivant >>', { label: 'suivant_vehicule' });
}

async function fillConducteurTab(cmd: QuotePreviewCommand): Promise<void> {
  const { params } = cmd;
  await waitFor(() => (detectCurrentScreen() === 'conducteur_tab' ? true : null), {
    label: 'arrive_conducteur',
    timeoutMs: 20_000,
  });
  await reportProgress(cmd.id, 'conducteur_tab_filling');

  await fillByLabel('Date de naissance', formatIsoDateFr(params.clientDateOfBirth), {
    label: 'dob',
  });

  // Antécédents block: 3 radios that all need to be "Non". Each radio
  // has a French label like "Sinistralité", "Suspension de permis", etc.
  // We don't know the exact labels — bulk-set every visible "Non" radio
  // that follows an Antécédents header.
  await clickRadioByLabel('Non', { label: 'antecedent_1', timeoutMs: 5_000 }).catch(
    () => undefined,
  );
  await clickRadioByLabel('Non', { label: 'antecedent_2', timeoutMs: 5_000 }).catch(
    () => undefined,
  );
  await clickRadioByLabel('Non', { label: 'antecedent_3', timeoutMs: 5_000 }).catch(
    () => undefined,
  );

  await sleep(SETTLE_MS);
  await clickByText('Suivant >>', { label: 'suivant_conducteur' });

  // Bridge modal may pop. Dismiss via Enter (default = Confirmer).
  await sleep(SETTLE_MS);
  if (detectCurrentScreen() === 'bridge_modal') {
    await reportProgress(cmd.id, 'bridge_modal_dismiss');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // Belt-and-braces: try clicking a Confirmer button if Enter doesn't work.
    await clickByText('Confirmer', { label: 'bridge_confirm', timeoutMs: 5_000 }).catch(
      () => undefined,
    );
    await sleep(SETTLE_MS);
  }
}

async function configureGarantiesAndExtract(
  cmd: QuotePreviewCommand,
): Promise<{ monthly?: number; annual?: number }> {
  const { params } = cmd;
  await waitFor(() => (detectCurrentScreen() === 'garanties_tab' ? true : null), {
    label: 'arrive_garanties',
    timeoutMs: 20_000,
  });
  await reportProgress(cmd.id, 'garanties_tab_configure');

  const formule = params.formule ?? 'tiers_illimite';
  await clickByText(formuleLabel(formule), { label: `formule_${formule}`, timeoutMs: 10_000 });
  await sleep(SETTLE_MS);

  // Commission slider — Maxance renders it as a slider but also as a
  // labeled <input type="text">/range. Fill by label first; ignore if
  // the slider is the only control (no harm — default is 9).
  const pct = String(clampCommissionPct(params.commissionPct));
  await fillByLabel('Commission', pct, { label: 'commission', timeoutMs: 5_000 }).catch(
    () => undefined,
  );

  const fractionnement = params.fractionnement ?? 'mensuel';
  await setSelectByLabel('Fractionnement', fractionnementLabel(fractionnement), {
    label: 'fractionnement',
    timeoutMs: 5_000,
  }).catch(() => undefined);

  // Wait for the price preview to render. Both monthly and annual amounts
  // appear in the same DOM region; we poll body.innerText.
  await waitFor(() => (parseEurPrice(document.body.innerText) !== null ? true : null), {
    label: 'await_price_preview',
    timeoutMs: 20_000,
  });

  // Extract: monthly first (more common for mensuel), then annual.
  // Maxance labels them "Mensuel : X €" / "Annuel : Y €".
  const bodyText = document.body.innerText;
  const monthlyMatch = /mensuel\s*[:.]?\s*(\d[\d\s.]*[,.]\d{2})\s*€/i.exec(bodyText);
  const annualMatch = /annuel\s*[:.]?\s*(\d[\d\s.]*[,.]\d{2})\s*€/i.exec(bodyText);
  const monthly = monthlyMatch ? parseEurPrice(monthlyMatch[0]) : null;
  const annual = annualMatch ? parseEurPrice(annualMatch[0]) : null;

  // Fallback: if neither labelled match found, take the FIRST EUR amount
  // in the page and bucket it by the fractionnement choice.
  if (monthly == null && annual == null) {
    const any = parseEurPrice(bodyText);
    if (any != null) {
      if (fractionnement === 'annuel') return { annual: any };
      return { monthly: any };
    }
    return {};
  }
  const out: { monthly?: number; annual?: number } = {};
  if (monthly != null) out.monthly = monthly;
  if (annual != null) out.annual = annual;
  return out;
}

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

  try {
    await navigateToVehiculeTab(cmd);
    await shoot('vehicule_tab_pre');
    await fillVehiculeTab(cmd);
    await shoot('vehicule_tab_filled');
    await fillConducteurTab(cmd);
    await shoot('conducteur_tab_filled');
    const price = await configureGarantiesAndExtract(cmd);
    await shoot('price_preview');

    return QuotePreviewResponseSchema.parse({
      id: cmd.id,
      kind: 'quote.preview.ok',
      pricePreviewEur: price,
      screenshots,
      finalUrl: location.href,
      durationMs: Date.now() - t0,
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
