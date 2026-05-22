/**
 * Maxance quote-flow intent library (M8.T3).
 *
 * Encodes Achraf's walkthrough (`Assuryal/Maxance insstructions/ETAPE MAXANCE AI.pdf`,
 * steps 1-4) as a deterministic Stagehand step planner for EDPM trottinettes.
 * Drives the Proximéo quote engine from the broker home through:
 *
 *     vehicle_picker → vehicule_tab → conducteur_tab → garanties_tab → price_preview
 *
 * STOPS at the price-preview screen by default (`dryRun: true`). NEVER clicks
 * "Valider souscription" unless explicitly opted in — a Valider creates a real
 * record in Maxance and notifies the inspector. Per Achraf's directive in
 * `project_maxance_access.md`, only he can sign off on the first live submission.
 *
 * Pre-condition: caller has already run `loginMaxance` on the same Stagehand
 * session so the active page is the Proximéo home (vehicle-card grid visible).
 *
 * Side-effects:
 *   - One screenshot per material step under `<dataRoot>/screenshots/` with
 *     the same `/v1/static/screenshots/...` URL the M8.T1 intent layer serves.
 *   - One LLM-driven `extract` call to pull the headline price off the
 *     Garanties tab when the flow lands on the preview.
 *
 * The defaults Achraf flagged as "auto-fill" (Cylindrée=25, Protection vol=Non,
 * Mode d'acquisition=Comptant, Type d'acquisition="Achat d'un véhicule de
 * remplacement", Profession=Employé secteur privé, all Antécédents=Non, both
 * Souscripteur/Titulaire=Oui) are baked into the act instructions directly so
 * a per-quote caller can't accidentally drift them.
 */
import type { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import type {
  MaxanceQuoteOptions,
  MaxanceQuoteParams,
  MaxanceQuoteResult,
  MaxanceQuoteScreenshot,
} from './types.js';

const DEFAULT_QUOTE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Tabs we explicitly recognise inside the Proximéo quote wizard. Mirrors
 * the same single-key extract schema we use in login.ts so the LLM has a
 * very narrow output surface.
 */
const QUOTE_TAB_VALUES = [
  'vehicle_picker',
  'vehicule_tab',
  'conducteur_tab',
  'garanties_tab',
  'price_preview',
  'bridge_modal',
  'devis_tab',
  'unknown',
] as const;
type QuoteTab = (typeof QUOTE_TAB_VALUES)[number];

const QuoteTabDetectionSchema = z.object({
  tab: z.enum(QUOTE_TAB_VALUES),
});

const QuoteTabDetectionInstruction =
  'Identify which Proximéo quote-flow screen is currently displayed. Use exactly one of these labels:' +
  ' "vehicle_picker" (the broker is choosing a product/vehicle type — vehicle cards Auto, Camping car, VSP, Deux Roues, Nouvelles mobilités, etc. are visible OR a Trottinette / NVEI subtype selector),' +
  ' "vehicule_tab" (the first tab of the quote form, with fields Marque / Cylindrée / Version / dates / Type d\'acquisition / Stationnement / CP),' +
  ' "conducteur_tab" (the second tab, with Date de naissance / Situation familiale / Profession / Antécédents),' +
  ' "garanties_tab" (the third tab — coverage formula choice with Tiers Illimité / Vol+Incendie / Dommages tous accidents and a commission slider),' +
  ' "price_preview" (a price has been computed and is visible on screen — a monthly or annual EUR amount is shown alongside the chosen formula),' +
  ' "bridge_modal" (a modal asking the broker to confirm the trottinette is bridled at 25 km/h),' +
  ' "devis_tab" (the fourth tab — subscriber info form with Civilité / Nom / Prénom / address fields),' +
  ' "unknown" (anything else, including a blank page, an error banner, or an unrelated Maxance page). ' +
  'If both a tab and a modal are visible, prefer "bridge_modal".';

/**
 * Zod schema for the price extract. Both fields nullable — Maxance only shows
 * the cadence the broker selected (Mensuel or Annuel), not both at once.
 */
const PricePreviewSchema = z.object({
  monthly: z.number().nullable(),
  annual: z.number().nullable(),
});

const PricePreviewInstruction =
  'Extract the headline price shown on the Garanties tab. Return TWO numeric fields:' +
  ' "monthly" — the monthly premium in EUR if a per-month price is visible, otherwise null.' +
  ' "annual" — the annual premium in EUR if a per-year price is visible, otherwise null.' +
  ' Use the numeric value only (no currency symbol, no thousands separator). If only one' +
  ' cadence is shown on the page, set the other field to null.';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helpers (shape stolen from login.ts so callers see a familiar surface)    */
/* ────────────────────────────────────────────────────────────────────────── */

function settleMs(defaultMs: number): number {
  const raw = process.env.MAXANCE_QUOTE_STEP_DELAY_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return defaultMs;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Take a screenshot of the active page. Same best-effort pattern as login.ts:
 * a capture failure is logged but does not abort the step.
 */
async function captureStep(
  stagehand: Stagehand,
  sessionId: string,
  step: string,
  dataRoot: string,
  callback?: (shot: MaxanceQuoteScreenshot) => void,
): Promise<MaxanceQuoteScreenshot | undefined> {
  try {
    const page = stagehand.context.activePage();
    if (!page) return undefined;
    const dir = join(dataRoot, 'screenshots');
    await mkdir(dir, { recursive: true });
    const filename = `${sessionId}-${Date.now()}-maxance-quote-${step}.png`;
    const png = await page.screenshot({ type: 'png', fullPage: false });
    await writeFile(join(dir, filename), png);
    const shot: MaxanceQuoteScreenshot = {
      step,
      url: `/v1/static/screenshots/${filename}`,
    };
    callback?.(shot);
    return shot;
  } catch (err) {
    logger.warn({ err, sessionId, step }, 'maxance-quote: screenshot capture failed');
    return undefined;
  }
}

/**
 * Detect which quote-flow tab we're on. Retries on `unknown` because the
 * Proximéo wizard renders each tab in a second JS pass — a `domcontentloaded`
 * wait isn't enough on slower runs.
 */
async function detectTab(stagehand: Stagehand, attempts = 3, waitMs = 1500): Promise<QuoteTab> {
  let last: QuoteTab = 'unknown';
  for (let i = 0; i < attempts; i++) {
    const out = await stagehand.extract(QuoteTabDetectionInstruction, QuoteTabDetectionSchema);
    last = out.tab;
    if (last !== 'unknown') return last;
    await sleep(settleMs(waitMs));
  }
  return last;
}

/**
 * Bound a long-running step against the overall flow timeout. Used so a hung
 * `act` call doesn't blow past the caller's wall-clock budget.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Format a `Date` as Maxance's `dd/mm/yyyy` input mask. Stagehand variable
 * substitution sends the value verbatim — we want the displayed string to
 * match the broker's mental model from the PDF.
 */
function formatDateFr(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Translate the param-shaped stationnement enum into the verbatim French
 * label Maxance shows in its dropdown. Keeping this mapping local so
 * params.ts stays language-agnostic.
 */
function stationnementLabel(s: MaxanceQuoteParams['stationnement']): string {
  switch (s) {
    case 'garage_box':
      return 'Garage / box fermé';
    case 'parking_prive_clos':
      return 'Parking privé clos';
    case 'parking_prive_non_clos':
      return 'Parking privé non clos';
    case 'rue':
      return 'Rue / voie publique';
  }
}

function formuleLabel(f: NonNullable<MaxanceQuoteParams['formule']>): string {
  switch (f) {
    case 'tiers_illimite':
      return 'Tiers Illimité';
    case 'vol_incendie':
      return 'Vol + Incendie';
    case 'dommages_tous_accidents':
      return 'Dommages tous accidents';
  }
}

function fractionnementLabel(f: NonNullable<MaxanceQuoteParams['fractionnement']>): string {
  return f === 'annuel' ? 'Annuel' : 'Mensuel';
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Step planner                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Main entry point. See module-level doc for the step plan.
 *
 * Concurrency note: this function assumes exclusive access to the Stagehand
 * session for its duration. Callers should `borrow()` from the pool, run
 * this, then `release()` — same contract as `loginMaxance`.
 */
export async function startQuote(
  stagehand: Stagehand,
  sessionId: string,
  params: MaxanceQuoteParams,
  opts: MaxanceQuoteOptions,
): Promise<MaxanceQuoteResult> {
  if (params.vehicleKind !== 'trottinette') {
    throw new Error(`maxance_quote_unsupported_vehicle:${params.vehicleKind}`);
  }
  if (!opts.dryRun) {
    // Hard guardrail. M8.T3 NEVER ships a real submission path — the rest of
    // the flow (Devis tab → Edition → Envoyer email → Reprendre devis →
    // Coordonnées bancaires → Valider) lands in M8.T4-T6 with explicit
    // sign-off from Achraf. Make a non-dryRun call explicit by throwing now.
    throw new Error('maxance_quote_full_submission_not_implemented');
  }

  const t0 = Date.now();
  const dataRoot = opts.dataRoot ?? process.env.STAGEHAND_DATA_DIR ?? './data';
  const totalTimeoutMs = opts.timeoutMs ?? DEFAULT_QUOTE_TIMEOUT_MS;
  const screenshots: MaxanceQuoteScreenshot[] = [];

  const pushShot = async (step: string): Promise<void> => {
    const s = await captureStep(stagehand, sessionId, step, dataRoot, opts.screenshotCallback);
    if (s) screenshots.push(s);
  };

  try {
    const page = stagehand.context.activePage();
    if (!page) throw new Error('maxance_quote_no_active_page');

    // Step 1 — pre-flight: confirm we're on a quote-launchable page. We accept
    // either the broker home (which holds the vehicle-card grid in the new
    // UI) or any of the wizard tabs (resume case). If we're somewhere else
    // the caller didn't run loginMaxance first — fail fast.
    let tab = await detectTab(stagehand);
    if (
      tab !== 'vehicle_picker' &&
      tab !== 'vehicule_tab' &&
      tab !== 'conducteur_tab' &&
      tab !== 'garanties_tab' &&
      tab !== 'price_preview'
    ) {
      throw new Error(`maxance_quote_unexpected_entry_page:${tab}`);
    }
    await pushShot('entry');

    // Step 2 — navigate to the Trottinette form if we landed on the picker.
    // Achraf's PDF: Deux Roues → Trottinette. The integrated home shows the
    // top-level cards directly; the click sequence is two acts.
    if (tab === 'vehicle_picker') {
      await withTimeout(
        stagehand.act('Click the "Deux Roues" (2 wheels) product card to open its sub-categories'),
        totalTimeoutMs,
        'maxance_quote_timeout_click_deux_roues',
      );
      await sleep(settleMs(1500));
      await pushShot('deux_roues_open');

      await withTimeout(
        stagehand.act(
          'Click the "Trottinette" sub-category (also labelled "EDPM" or "NVEI" on some skins) to launch the trottinette quote form',
        ),
        totalTimeoutMs,
        'maxance_quote_timeout_click_trottinette',
      );
      await sleep(settleMs(2000));
      await pushShot('trottinette_launched');
      tab = await detectTab(stagehand);
    }

    // Step 3 — Véhicule tab. Auto-fill the deterministic defaults Achraf
    // flagged + the per-quote params (purchase price drives Version band).
    if (tab === 'vehicule_tab') {
      const acquisitionDate = formatDateFr(params.purchaseDate);
      // Marque is the only free-text on this form; "TROTTINETTE" verbatim is
      // the canonical label Maxance auto-suggests. Cylindrée 25 is hardcoded
      // (trottinettes must be bridled at 25 km/h — Achraf's directive).
      await withTimeout(
        stagehand.act(
          'Set the "Marque" field to "TROTTINETTE" (select from the dropdown if it auto-suggests)',
        ),
        totalTimeoutMs,
        'maxance_quote_timeout_marque',
      );
      await withTimeout(
        stagehand.act(
          'Set the "Cylindrée" field to "25" (the trottinette must be bridled to 25 km/h)',
        ),
        totalTimeoutMs,
        'maxance_quote_timeout_cylindree',
      );
      // Version is the price band. Pass the raw price as a hint; the LLM will
      // pick the matching band from the dropdown (e.g. "200 € - 400 €").
      await withTimeout(
        stagehand.act(
          'Select the "Version" entry whose price band contains %priceEur% €. Bands look like "≤ 200 €", "200 € - 400 €", "400 € - 700 €", etc.',
          { variables: { priceEur: String(Math.round(params.purchasePriceEur)) } },
        ),
        totalTimeoutMs,
        'maxance_quote_timeout_version',
      );
      // Première mise en circulation + Date d'acquisition both take the
      // purchase date (Achraf: identical values, sourced from the invoice).
      await withTimeout(
        stagehand.act(
          'Fill the "Première mise en circulation" date field with %dateFr% (DD/MM/YYYY format)',
          { variables: { dateFr: acquisitionDate } },
        ),
        totalTimeoutMs,
        'maxance_quote_timeout_pmec',
      );
      await withTimeout(
        stagehand.act(
          'Fill the "Date d\'acquisition" date field with %dateFr% (DD/MM/YYYY format)',
          { variables: { dateFr: acquisitionDate } },
        ),
        totalTimeoutMs,
        'maxance_quote_timeout_dacq',
      );
      // Type d'acquisition, Protection vol, Mode d'acquisition: hardcoded
      // per Achraf.
      await withTimeout(
        stagehand.act(
          'Set the "Type d\'acquisition" dropdown to "Achat d\'un véhicule de remplacement"',
        ),
        totalTimeoutMs,
        'maxance_quote_timeout_typeacq',
      );
      await withTimeout(
        stagehand.act('Set the "Protection vol" radio / dropdown to "Non"'),
        totalTimeoutMs,
        'maxance_quote_timeout_vol',
      );
      await withTimeout(
        stagehand.act('Set the "Mode d\'acquisition" dropdown to "Comptant"'),
        totalTimeoutMs,
        'maxance_quote_timeout_modeacq',
      );
      // Stationnement: client-supplied (not a default). CP + ville filled
      // from params. City is best-effort — Maxance often auto-fills from CP,
      // so we only act on it if the caller passed one.
      await withTimeout(
        stagehand.act('Set the "Stationnement" dropdown to %label%', {
          variables: { label: stationnementLabel(params.stationnement) },
        }),
        totalTimeoutMs,
        'maxance_quote_timeout_stationnement',
      );
      await withTimeout(
        stagehand.act('Fill the postal-code field ("CP" or "Code postal") with %cp%', {
          variables: { cp: params.postalCode },
        }),
        totalTimeoutMs,
        'maxance_quote_timeout_cp',
      );
      if (params.city) {
        await withTimeout(
          stagehand.act(
            'If a "Ville" field is shown and is not already populated, set it to %city%',
            { variables: { city: params.city } },
          ),
          totalTimeoutMs,
          'maxance_quote_timeout_city',
        );
      }
      await pushShot('vehicule_filled');

      // Suivant → Conducteur.
      await withTimeout(
        stagehand.act('Click the "Suivant" button to advance to the Conducteur tab'),
        totalTimeoutMs,
        'maxance_quote_timeout_suivant_conducteur',
      );
      await sleep(settleMs(2000));
      await pushShot('post_vehicule_suivant');
      tab = await detectTab(stagehand);
    }

    // Step 4 — Conducteur tab. Per Achraf: trottinette = no permis, so DOB
    // is the only client-supplied field; everything else is the broker-side
    // default for our portfolio.
    if (tab === 'conducteur_tab') {
      await withTimeout(
        stagehand.act('Fill the "Date de naissance" field with %dob% (DD/MM/YYYY format)', {
          variables: { dob: formatDateFr(params.clientDateOfBirth) },
        }),
        totalTimeoutMs,
        'maxance_quote_timeout_dob',
      );
      await withTimeout(
        stagehand.act('Set the "Situation familiale" dropdown to "Célibataire"'),
        totalTimeoutMs,
        'maxance_quote_timeout_situation',
      );
      await withTimeout(
        stagehand.act('Set the "Profession" dropdown to "Employé secteur privé"'),
        totalTimeoutMs,
        'maxance_quote_timeout_profession',
      );
      // Achraf: ALL Antécédents / Risque aggravé questions → Non.
      await withTimeout(
        stagehand.act(
          'For every "Antécédents" question and every "Risque aggravé" question on this page, set the answer to "Non". Leave nothing blank.',
        ),
        totalTimeoutMs,
        'maxance_quote_timeout_antecedents',
      );
      // Souscripteur=Oui, Titulaire carte grise=Oui.
      await withTimeout(
        stagehand.act(
          'Set the "Souscripteur" question to "Oui" and the "Titulaire carte grise" question to "Oui"',
        ),
        totalTimeoutMs,
        'maxance_quote_timeout_souscripteur',
      );
      await pushShot('conducteur_filled');

      await withTimeout(
        stagehand.act('Click the "Suivant" button to advance to the Garanties tab'),
        totalTimeoutMs,
        'maxance_quote_timeout_suivant_garanties',
      );
      await sleep(settleMs(2500));
      await pushShot('post_conducteur_suivant');
      tab = await detectTab(stagehand);
    }

    // Step 5 — Bridge confirmation modal. Maxance pops a modal asking the
    // broker to confirm the trottinette is bridled at 25 km/h before showing
    // the Garanties tab. Single click + page settles.
    if (tab === 'bridge_modal') {
      await withTimeout(
        stagehand.act(
          'Confirm the modal that asks whether the trottinette is bridled at 25 km/h — click "Oui" / "Confirmer" / the affirmative button. Per our broker policy this is always yes.',
        ),
        totalTimeoutMs,
        'maxance_quote_timeout_bridge_modal',
      );
      await sleep(settleMs(1500));
      await pushShot('post_bridge_modal');
      tab = await detectTab(stagehand);
    }

    // Step 6 — Garanties tab. Pick formule, set commission, set fractionnement.
    // The page recomputes price after each toggle, so we let it settle between.
    if (tab === 'garanties_tab' || tab === 'price_preview') {
      const formule = params.formule ?? 'tiers_illimite';
      const commission = clampCommission(params.commissionPct ?? 9);
      const fractionnement = params.fractionnement ?? 'mensuel';

      await withTimeout(
        stagehand.act('Select the coverage formula labelled "%label%" (a card or radio button)', {
          variables: { label: formuleLabel(formule) },
        }),
        totalTimeoutMs,
        'maxance_quote_timeout_formule',
      );
      await sleep(settleMs(1500));

      // Commission slider 9 → 22. Set via natural-language; Stagehand can
      // drag sliders via keyboard arrow-keys or by setting the underlying
      // input value — letting the LLM choose is fine here.
      await withTimeout(
        stagehand.act(
          'Set the commission slider to %pct%% (the slider ranges from 9% to 22%). Drag or type the value as the UI requires.',
          { variables: { pct: String(commission) } },
        ),
        totalTimeoutMs,
        'maxance_quote_timeout_commission',
      );
      await sleep(settleMs(1500));

      await withTimeout(
        stagehand.act('Set the "Fractionnement" toggle / dropdown to "%label%"', {
          variables: { label: fractionnementLabel(fractionnement) },
        }),
        totalTimeoutMs,
        'maxance_quote_timeout_fractionnement',
      );
      await sleep(settleMs(2000));
      await pushShot('garanties_configured');
      tab = await detectTab(stagehand);
    }

    // Step 7 — terminal in dryRun: extract the price preview and return.
    // Accept either explicit "price_preview" or "garanties_tab" — Maxance
    // doesn't always swap the URL, so the LLM may still call it the tab.
    if (tab !== 'garanties_tab' && tab !== 'price_preview') {
      throw new Error(`maxance_quote_unexpected_pricing_page:${tab}`);
    }

    const price = await withTimeout(
      stagehand.extract(PricePreviewInstruction, PricePreviewSchema),
      totalTimeoutMs,
      'maxance_quote_timeout_price_extract',
    );
    await pushShot('price_extracted');

    return {
      sessionId,
      durationMs: Date.now() - t0,
      screenshots,
      dryRun: true,
      pricePreviewEur: {
        ...(price.monthly !== null ? { monthly: price.monthly } : {}),
        ...(price.annual !== null ? { annual: price.annual } : {}),
      },
      finalUrl: page.url(),
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    logger.warn({ sessionId, err: raw }, 'maxance-quote: flow failed');
    throw err instanceof Error ? err : new Error(raw);
  }
}

/**
 * Clamp the commission to Maxance's 9-22 % band. Out-of-range callers get
 * snapped silently rather than throwing — the slider would reject the
 * extreme value at click-time anyway and we'd prefer a quote at the nearest
 * legal commission over a hard failure.
 */
function clampCommission(pct: number): number {
  if (!Number.isFinite(pct)) return 9;
  if (pct < 9) return 9;
  if (pct > 22) return 22;
  return Math.round(pct);
}
