/**
 * devis.resume flow — V1 Chrome-extension Maxance driver (M8.T7 B2).
 *
 * Resumes an existing devis so the closing (souscription) flow can continue
 * from the Garanties tab. Mirrors quote-preview / quote-confirm: an
 * advance-loop with `.navigating` responses, URL/marker-based screen
 * detection, and SW-orchestrated re-invocation across top-frame navigations.
 *
 * Pre-condition: caller ran login.ensure on the same tab (we're somewhere in
 * /Proximeo/). The SW orchestrator (background.ts) drives this exactly like
 * the quote flows.
 *
 * Screens (in nav order):
 *   1. search          → fill ACCES PORTEFEUILLE bar (critereSelected=NO +
 *                        #valeurCritere=devisNumber) + click #mainSearchLink
 *                        (MAIN world, inline doSubmit) → navigates.
 *   2. visualisation   → "Visualisation du devis" dossier page → call
 *                        doSubmit('repriseDevisMoto.do') (MAIN world) →
 *                        navigates to the resumed VÉHICULE tab.
 *   3. reprise_vehicule→ #validerVehicule Suivant (button-container MAIN-world
 *                        click) → navigates to CONDUCTEUR.
 *   4. reprise_conducteur → #validerConducteur Suivant → navigates to Garanties.
 *   5. garanties       → applyGarantiesConfig (commission ALWAYS re-forced to
 *                        22 — it RESETS to 9.0 on every reprise) +
 *                        extractComptantBreakdown → DONE (devis.resume.ok).
 *
 * Self-healing (background.ts): on ERROR → reset the tab to accueil.do; on
 * SUCCESS → NO reset (the subscription flow needs the Garanties state).
 */
import {
  REPRISE_DO,
  REPRISE_HEADER_RE,
  VALEUR_CRITERE_ID,
  VALIDER_CONDUCTEUR_ID,
  VALIDER_VEHICULE_ID,
  VISUALISATION_TITLE,
  clampCommissionPct,
  formuleLabel,
} from '../maxance/selectors.js';
import { captureScreenshot, clickMaxanceButton, sleep, waitFor } from '../dom.js';
import {
  GarantiesNavigatedError,
  applyGarantiesConfig,
  extractComptantBreakdown,
} from './garanties-controls.js';
import {
  type ComptantBreakdown,
  type DevisResumeCommandSchema,
  DevisResumeResponseSchema,
  DevisResumeNavigatingResponseSchema,
  ErrorResponseSchema,
  type Response,
  type Screenshot,
} from '../wire.js';
import { reportProgress } from './progress.js';
import type {
  RepriseSearchRequest,
  RepriseSearchResponse,
  RepriseSubmitRequest,
  RepriseSubmitResponse,
} from '../content-protocol.js';
import type { z } from 'zod';

type DevisResumeCommand = z.infer<typeof DevisResumeCommandSchema>;

/** Best-effort settle pause between framework navigations. */
const SETTLE_MS = 800;

/**
 * Probe which resume screen we're on. URL + markers, not internal state
 * (the content script dies on every top-frame navigation).
 */
function detectResumeScreen():
  | 'search'
  | 'visualisation'
  | 'reprise_vehicule'
  | 'reprise_conducteur'
  | 'garanties'
  | 'unknown' {
  const body = document.body?.innerText ?? '';

  // Garanties of the resumed devis: both Valider buttons present (same
  // disambiguation the confirm flow's container-ID detection relies on).
  if (document.getElementById('validerSouscription') && document.getElementById('validerDevis')) {
    return 'garanties';
  }

  // Resumed CONDUCTEUR tab: the stable-named "Aucun permis" checkbox is the
  // reliable marker (same as the preview flow's conducteur detection).
  if (document.querySelector('input[name="currentConducteur.flagAucunPermis"]')) {
    return 'reprise_conducteur';
  }

  // Resumed VÉHICULE tab: reprise header + the first Suivant container, with
  // the conducteur marker absent (checked above).
  if (REPRISE_HEADER_RE.test(body) && document.getElementById(VALIDER_VEHICULE_ID)) {
    return 'reprise_vehicule';
  }

  // Dossier page reached after the search.
  if (new RegExp(VISUALISATION_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(body)) {
    return 'visualisation';
  }

  // Initial search bar available and nothing else matched → run the search.
  if (document.getElementById(VALEUR_CRITERE_ID)) {
    return 'search';
  }

  return 'unknown';
}

/** Ask the SW to fill + submit the ACCES PORTEFEUILLE search (MAIN world). */
async function submitSearch(devisNumber: string): Promise<void> {
  const msg: RepriseSearchRequest = { kind: 'reprise.search-mw', devisNumber };
  const resp = (await chrome.runtime.sendMessage(msg)) as RepriseSearchResponse | undefined;
  if (!resp) throw new Error('maxance_resume_search_failed:no_response');
  if (resp.kind !== 'reprise.search.ok') {
    throw new Error(`maxance_resume_search_failed:${resp.error} [${resp.log.join(',')}]`);
  }
}

/** Ask the SW to call doSubmit('repriseDevisMoto.do') (MAIN world). */
async function submitReprise(): Promise<void> {
  const msg: RepriseSubmitRequest = { kind: 'reprise.submit-mw', repriseDo: REPRISE_DO };
  const resp = (await chrome.runtime.sendMessage(msg)) as RepriseSubmitResponse | undefined;
  if (!resp) throw new Error('maxance_resume_reprise_failed:no_response');
  if (resp.kind !== 'reprise.submit.ok') {
    throw new Error(`maxance_resume_reprise_failed:${resp.error} [${resp.log.join(',')}]`);
  }
}

/**
 * Configure Garanties (commission ALWAYS forced — it resets to 9.0 on every
 * reprise) and extract prices + comptant breakdown. Re-uses the B1 module.
 */
async function configureGarantiesAndExtract(cmd: DevisResumeCommand): Promise<{
  monthly?: number;
  annual?: number;
  comptantBreakdown: ComptantBreakdown;
}> {
  await reportProgress(cmd.id, 'resume_garanties_apply_config');
  const cfgResult = await applyGarantiesConfig({
    commissionPct: clampCommissionPct(cmd.commissionPct ?? 22),
    ...(cmd.formule !== undefined ? { formule: cmd.formule } : {}),
    ...(cmd.fractionnement !== undefined ? { fractionnement: cmd.fractionnement } : {}),
  });
  await reportProgress(cmd.id, 'resume_garanties_config_applied', JSON.stringify(cfgResult));

  const formule = cmd.formule ?? 'tiers_illimite';
  const targetLabel = formuleLabel(formule);
  const monthly = await waitFor<number>(() => extractFormulePrice(targetLabel), {
    label: `resume_await_formule_price:${formule}`,
    timeoutMs: 20_000,
  }).catch(() => undefined);

  const annualMatch = /Co[ûu]t annuel brut[*\s]*\n[^\n]*?(\d+[.,]\d{2})\s*$/im.exec(
    document.body.innerText,
  );
  const annualFallback = /co[ûu]t annuel[^\n]*?(\d+[.,]\d{2})/im.exec(document.body.innerText);
  const annualRaw = annualMatch?.[1] ?? annualFallback?.[1];
  const annual = annualRaw ? Number.parseFloat(annualRaw.replace(',', '.')) : undefined;

  const out: { monthly?: number; annual?: number; comptantBreakdown: ComptantBreakdown } = {
    comptantBreakdown: extractComptantBreakdown(),
  };
  if (monthly != null && Number.isFinite(monthly)) out.monthly = monthly;
  if (annual != null && Number.isFinite(annual)) out.annual = annual;
  return out;
}

/** Extract a formule's EUR price from the Garanties body text (same parse as
 *  quote-preview). Returns null while the number hasn't rendered yet. */
function extractFormulePrice(label: string): number | null {
  const body = document.body.innerText;
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sameLineRe = new RegExp(`${escapedLabel}\\s*[\\t ]+(\\d[\\d\\s]*[,.]\\d{2})`, 'i');
  const sameLine = sameLineRe.exec(body);
  if (sameLine?.[1]) {
    return Number.parseFloat(sameLine[1].replace(/\s/g, '').replace(',', '.'));
  }
  const multiLineRe = new RegExp(`${escapedLabel}\\s*\\n\\s*(\\d[\\d\\s]*[,.]\\d{2})`, 'i');
  const multi = multiLineRe.exec(body);
  if (multi?.[1]) {
    return Number.parseFloat(multi[1].replace(/\s/g, '').replace(',', '.'));
  }
  return null;
}

/**
 * Single-screen advance of the devis.resume flow. The SW orchestrator calls
 * this repeatedly across top-frame navigations (same contract as the quote
 * flows): returns `devis.resume.navigating` after triggering a navigation,
 * `devis.resume.ok` on completion, or `error`.
 */
export async function runDevisResume(cmd: DevisResumeCommand): Promise<Response> {
  const t0 = Date.now();
  const screenshots: Screenshot[] = [];
  const shoot = async (step: string): Promise<void> => {
    try {
      screenshots.push(await captureScreenshot(step));
    } catch (err) {
      console.warn('[f16-ext] screenshot failed at', step, err);
    }
  };

  const navigating = (fromScreen: string, expectedScreen: string): Response =>
    DevisResumeNavigatingResponseSchema.parse({
      id: cmd.id,
      kind: 'devis.resume.navigating',
      fromScreen,
      expectedScreen,
      screenshots,
    });

  try {
    await sleep(SETTLE_MS);

    for (let iter = 0; iter < 8; iter += 1) {
      const screen = detectResumeScreen();
      await reportProgress(cmd.id, 'resume_advance_iter', `screen=${screen}`);

      if (screen === 'search') {
        await shoot('resume_search_pre');
        await reportProgress(cmd.id, 'resume_search', cmd.devisNumber);
        await submitSearch(cmd.devisNumber);
        await shoot('resume_search_submitted');
        return navigating('search', 'visualisation');
      }

      if (screen === 'visualisation') {
        await shoot('resume_visualisation');
        await reportProgress(cmd.id, 'resume_reprise');
        await submitReprise();
        await shoot('resume_reprise_submitted');
        return navigating('visualisation', 'reprise_vehicule');
      }

      if (screen === 'reprise_vehicule') {
        await shoot('resume_vehicule_pre');
        await reportProgress(cmd.id, 'resume_suivant_vehicule');
        await clickMaxanceButton(VALIDER_VEHICULE_ID, { label: 'resume_suivant_vehicule' });
        await shoot('resume_vehicule_after_suivant');
        return navigating('reprise_vehicule', 'reprise_conducteur');
      }

      if (screen === 'reprise_conducteur') {
        await shoot('resume_conducteur_pre');
        await reportProgress(cmd.id, 'resume_suivant_conducteur');
        await clickMaxanceButton(VALIDER_CONDUCTEUR_ID, { label: 'resume_suivant_conducteur' });
        await shoot('resume_conducteur_after_suivant');
        return navigating('reprise_conducteur', 'garanties');
      }

      if (screen === 'garanties') {
        await shoot('resume_garanties_pre');
        try {
          const { comptantBreakdown, ...price } = await configureGarantiesAndExtract(cmd);
          await shoot('resume_garanties_configured');
          return DevisResumeResponseSchema.parse({
            id: cmd.id,
            kind: 'devis.resume.ok',
            devisNumber: cmd.devisNumber,
            pricePreviewEur: price,
            comptantBreakdown,
            screenshots,
            finalUrl: location.href,
            durationMs: Date.now() - t0,
          });
        } catch (gErr) {
          // Same nav-resilience as quote.preview: a Garanties control (the
          // commission onblur) navigates instead of AJAX-refreshing. Hand back
          // to the SW orchestrator to await the reload + re-invoke; the applied
          // control reads 'already' on the fresh page so the step converges.
          if (gErr instanceof GarantiesNavigatedError) {
            await shoot('resume_garanties_navigated');
            await reportProgress(cmd.id, 'resume_garanties_navigated', `url=${location.href}`);
            return navigating('garanties', 'garanties');
          }
          throw gErr;
        }
      }

      // unknown — settle and retry detection once
      await sleep(SETTLE_MS);
    }

    return ErrorResponseSchema.parse({
      id: cmd.id,
      kind: 'error',
      errorCode: 'maxance_resume_unknown_screen',
      detail: `advance loop exhausted on screen=${detectResumeScreen()} url=${location.href}`,
      screenshots,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return ErrorResponseSchema.parse({
      id: cmd.id,
      kind: 'error',
      errorCode: msg.startsWith('maxance_') ? msg.split(':')[0] : 'maxance_resume_unknown',
      detail: msg.slice(0, 240),
      screenshots,
    });
  }
}
