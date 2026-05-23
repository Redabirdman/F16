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
import { logger } from '../logger.js';
import type {
  MaxanceQuoteOptions,
  MaxanceQuoteParams,
  MaxanceQuoteResult,
  MaxanceQuoteScreenshot,
} from './types.js';
import {
  CYLINDREE_TROTTINETTE,
  MARQUE_TROTTINETTE,
  PROFESSION_EMPLOYE_SECTEUR_PRIVE,
  PROXIMEO_SSO_URL,
  PricePreviewInstruction,
  PricePreviewSchema,
  TYPE_ACQUISITION_REMPLACEMENT,
  captureStep,
  clickByTextOrThrow,
  detectTab,
  fillByLabel,
  formatDateFr,
  formuleLabel,
  fractionnementLabel,
  setSelectByLabel,
  settleMs,
  sleep,
  stationnementOption,
  trottinetteVersionBand,
  withTimeout,
} from './quote-form.js';

const DEFAULT_QUOTE_TIMEOUT_MS = 5 * 60 * 1000;

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

    // Step 1 — entry. Maxance's UI is stable for the next 12+ months
    // (Ridaa confirmed 2026-05-22), so we use deterministic Playwright
    // text-selectors throughout the navigation chain. The LLM-driven
    // detectTab only fires AFTER we've reached a form page where the
    // exact tab is genuinely ambiguous.
    //
    // Decision flow:
    //   - Detect once. If we're mid-wizard (vehicule/conducteur/garanties/
    //     price_preview/bridge_modal), resume from there.
    //   - Otherwise: blind-navigate via Accès Proximéo → Tarif → 2 roues →
    //     Trottinette using Playwright text-clicks. Any missing element
    //     throws with a descriptive `maxance_quote_click_failed:<step>`.
    let tab = await detectTab(stagehand);
    await pushShot('pre_navigate');

    const inWizard =
      tab === 'vehicule_tab' ||
      tab === 'conducteur_tab' ||
      tab === 'garanties_tab' ||
      tab === 'price_preview' ||
      tab === 'bridge_modal';

    if (!inWizard) {
      // Sidebar click → Proximéo welcome page. We bypass Stagehand.act here
      // too (the bug doesn't care which call hits it; the sidebar click is
      // as deterministic as the menu clicks below).
      try {
        await clickByTextOrThrow(page, 'Accès Proximéo', 'acces_proximeo', totalTimeoutMs);
      } catch (err) {
        logger.warn(
          { err, sessionId },
          'maxance-quote: Accès Proximéo click failed, falling back to direct SSO URL',
        );
        // Cast via `unknown` because the Stagehand-shaped Page returns
        // Promise<Response|null> for goto, while our minimal stub returns void.
        // We don't care about the return value here.
        const pageGoto = page as unknown as {
          goto: (u: string, o: unknown) => Promise<unknown>;
        };
        await pageGoto.goto(PROXIMEO_SSO_URL, { waitUntil: 'domcontentloaded' });
      }
      await sleep(settleMs(2500));
      await pushShot('post_proximeo_entry');

      // After Accès Proximéo we always land on the standalone Proximéo
      // welcome page (widgets layout, no product cards visible). We don't
      // re-detect — we just drive the menu chain blind. If any click misses
      // we throw with a descriptive label.
      tab = 'vehicle_picker';
    }

    // Step 2 — navigate to the Trottinette form. Verified live 2026-05-22:
    //   standalone Proximéo welcome → "Tarif - Nouveau Client" top menu item
    //   → "2 roues et quads" dropdown → "Trottinette" sub-category → form.
    //
    // The integrated extranet dashboard's vehicle-card grid was a newer
    // shortcut whose backing API silently 403s under Playwright — we never
    // enter through it. The standalone Proximéo welcome page is a classic
    // JSP UI with the top menu; that's where this click chain runs.
    if (tab === 'vehicle_picker') {
      // The Proximéo menu is a plain JSP UI with stable text labels. We
      // bypass Stagehand.act for this sequence and click via Playwright
      // directly because Stagehand v3 hits an intermittent `$PARAMETER_NAME`
      // wrapping bug with Anthropic models that the act-retry can't recover
      // from. Direct getByText is also faster (no LLM round-trip per click).
      //
      // Labels match the live UI verified on 2026-05-22:
      //   "Tarif - Nouveau Client"  (top menu)
      //   "2 roues et quads"        (dropdown) → lands directly on Véhicule
      //
      // Note: there is NO separate "Trottinette" click step in the live UI.
      // Trottinette is set later via the Marque dropdown on the Véhicule tab.
      // Earlier iterations of this flow tried to click a "Trottinette"
      // sub-category link that doesn't exist — the click silently no-op'd
      // and the LLM detector returned 'vehicle_picker' again. Live trace
      // proved the actual flow is just two clicks (Tarif → 2 roues et quads).
      await clickByTextOrThrow(page, 'Tarif - Nouveau Client', 'tarif', totalTimeoutMs);
      await sleep(settleMs(1500));
      await pushShot('tarif_nouveau_client_open');

      await clickByTextOrThrow(page, '2 roues et quads', 'deux_roues', totalTimeoutMs);
      await sleep(settleMs(2500));
      await pushShot('vehicule_tab_open');
      tab = await detectTab(stagehand);

      // After the menu chain we MUST land on the Véhicule tab. Anything
      // else (vehicle_picker again, dashboard, unknown) means a click in the
      // chain silently missed or Maxance returned an error page. Fail loudly
      // with a descriptive label so the operator knows where the flow broke.
      if (
        tab !== 'vehicule_tab' &&
        tab !== 'conducteur_tab' && // resume edge — already past vehicule
        tab !== 'bridge_modal' &&
        tab !== 'garanties_tab' &&
        tab !== 'price_preview'
      ) {
        throw new Error(`maxance_quote_unexpected_entry_page:${tab}`);
      }
    }

    // Step 3 — Véhicule tab. Auto-fill the deterministic defaults Achraf
    // flagged + the per-quote params. All dropdowns + text inputs use
    // direct Playwright locators (50ms each) instead of stagehand.act
    // (~3s each, plus the $PARAMETER_NAME wrapping bug). The labels and
    // option values are stable for the next 12+ months per Ridaa.
    if (tab === 'vehicule_tab') {
      const acquisitionDate = formatDateFr(params.purchaseDate);
      const stationnement = stationnementOption(params.stationnement);

      // Marque + Cylindrée + Version drive the price-band lookup.
      // Verified values: TROTTINETTE / 25 / 8181-8192.
      await setSelectByLabel(page, 'Marque', MARQUE_TROTTINETTE, 'marque', totalTimeoutMs);
      await setSelectByLabel(page, 'Cylindrée', CYLINDREE_TROTTINETTE, 'cylindree', totalTimeoutMs);
      await sleep(settleMs(1000)); // Version dropdown populates server-side after Cylindrée.
      await setSelectByLabel(
        page,
        'Version',
        trottinetteVersionBand(params.purchasePriceEur),
        'version',
        totalTimeoutMs,
      );

      // Première mise en circulation + Date d'acquisition both take the
      // purchase date (Achraf: identical values, sourced from the invoice).
      await fillByLabel(
        page,
        'Première mise en circulation',
        acquisitionDate,
        'pmec',
        totalTimeoutMs,
      );
      await fillByLabel(page, "Date d'acquisition", acquisitionDate, 'dacq', totalTimeoutMs);

      // Type d'acquisition + Stationnement: deterministic values.
      // Protection vol = Non, Mode d'acquisition = comptant are already the
      // form defaults — we skip them to save two LLM/Playwright round trips.
      await setSelectByLabel(
        page,
        "Type d'acquisition du véhicule à assurer",
        TYPE_ACQUISITION_REMPLACEMENT,
        'typeacq',
        totalTimeoutMs,
      );
      await setSelectByLabel(
        page,
        'Stationnement',
        stationnement.value,
        'stationnement',
        totalTimeoutMs,
      );

      // CP — Maxance auto-resolves Ville from the postal code on blur, so
      // setting Ville explicitly is usually unnecessary. Provided as a
      // best-effort override if the caller passed one.
      await fillByLabel(page, 'Code postal', params.postalCode, 'cp', totalTimeoutMs);
      if (params.city) {
        await withTimeout(
          stagehand.act(
            'If a "Ville" dropdown is shown and is not already populated with the right city, set it to %city%',
            { variables: { city: params.city } },
          ),
          totalTimeoutMs,
          'maxance_quote_timeout_city',
        );
      }
      await pushShot('vehicule_filled');

      // Suivant → Conducteur. The button has a stable visible label.
      await clickByTextOrThrow(page, 'Suivant >>', 'suivant_conducteur', totalTimeoutMs);
      await sleep(settleMs(2500));
      await pushShot('post_vehicule_suivant');
      tab = await detectTab(stagehand);
    }

    // Step 4 — Conducteur tab. Per Achraf: trottinette = no permis (the
    // "Aucun permis" checkbox is pre-checked, so we just skip Permis), and
    // DOB is the only client-supplied field. Situation familiale defaults
    // to "Célibataire" so we don't set it; Profession + the three Antécédents
    // radios need explicit setting.
    if (tab === 'conducteur_tab') {
      await fillByLabel(
        page,
        'Date de naissance',
        formatDateFr(params.clientDateOfBirth),
        'dob',
        totalTimeoutMs,
      );
      await setSelectByLabel(
        page,
        'Profession',
        PROFESSION_EMPLOYE_SECTEUR_PRIVE,
        'profession',
        totalTimeoutMs,
      );

      // Three Risk-Aggravé / Antécédents radio groups — all "Non". Each is
      // a separate radio set. The labels are long sentences ("Depuis le
      // dd/mm/yyyy, avez-vous…") so we'd need brittle text matching to
      // address them individually. Stagehand.act handles this fuzzy case
      // well — one LLM call sets all three to Non. Souscripteur + Titulaire
      // carte grise = Oui are form defaults (no action needed).
      await withTimeout(
        stagehand.act(
          'For every "Antécédents" / "Risque aggravé" question on this page (resiliation, condamnation pour delit de fuite, annulation ou suspension de permis), select the "Non" radio button. Leave nothing blank. Do NOT change "Souscripteur" or "Titulaire carte grise" — they should stay at the default "Oui".',
        ),
        totalTimeoutMs,
        'maxance_quote_timeout_antecedents',
      );
      await pushShot('conducteur_filled');

      await clickByTextOrThrow(page, 'Suivant >>', 'suivant_garanties', totalTimeoutMs);
      await sleep(settleMs(3000));
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
