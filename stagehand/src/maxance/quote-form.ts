/**
 * Quote-flow shared helpers (M8.T3).
 *
 * 🚨 MIXED FILE — constants stay canonical, Playwright helpers go dead.
 *
 * The Maxance constants in this file (Marque, Cylindrée, Type d'acquisition,
 * Profession codes, Version-band mapping, Stationnement codes, Formule/
 * Fractionnement labels, formatDateFr) are CANONICAL and survive the V1
 * driver migration — the M8.T8 phase 2 Chrome extension will re-export them
 * from here directly. The Playwright form helpers (setSelectByLabel,
 * fillByLabel, clickByTextOrThrow) and the LLM tab-detection prompt are
 * Stagehand-runtime artifacts that DO NOT drive prod (Cloudflare blocks
 * Playwright on Maxance — see project_hosting_pivot.md). When phase 2 lands,
 * the helpers will be replaced by the extension's content-script DOM
 * equivalents; the constants will not move.
 *
 * Extracted from `quote.ts` to keep both files under the 500-line guideline.
 * Holds:
 *   - Verified Maxance constants (Marque label, Cylindrée, Type d'acquisition,
 *     Profession code, Version-band mapping, Stationnement option codes)
 *   - Deterministic Playwright form helpers (setSelectByLabel, fillByLabel,
 *     clickByTextOrThrow) that bypass Stagehand.act for stable elements
 *   - Detection schema + LLM prompt for the Proximéo wizard tabs
 *
 * Why these live in a separate file:
 *   - Constants are reference data (verified 2026-05-22, stable 12+ months
 *     per Ridaa) — they change at a different cadence than the step planner
 *   - The form helpers are pure, framework-only code (no business logic)
 *   - quote.ts then focuses on the step planner, easier to review
 */
import type { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import type { MaxanceQuoteScreenshot } from './types.js';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Verified Maxance constants (M8.T8 phase 2: moved to ./selectors.ts)        */
/* ────────────────────────────────────────────────────────────────────────── */

// The canonical selectors + form values live in `./selectors.ts` (PURE module,
// importable from the Chrome extension). We re-export them here so existing
// callers in this workspace don't change.
export {
  PROXIMEO_SSO_URL,
  MARQUE_TROTTINETTE,
  CYLINDREE_TROTTINETTE,
  TYPE_ACQUISITION_REMPLACEMENT,
  PROFESSION_EMPLOYE_SECTEUR_PRIVE,
  trottinetteVersionBand,
  stationnementOption,
  formuleLabel,
  fractionnementLabel,
  formatDateFr,
} from './selectors.js';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Tab-detection schema + LLM prompts                                         */
/* ────────────────────────────────────────────────────────────────────────── */

export const QUOTE_TAB_VALUES = [
  'vehicle_picker',
  'vehicule_tab',
  'conducteur_tab',
  'garanties_tab',
  'price_preview',
  'bridge_modal',
  'devis_tab',
  'unknown',
] as const;
export type QuoteTab = (typeof QUOTE_TAB_VALUES)[number];

export const QuoteTabDetectionSchema = z.object({
  tab: z.enum(QUOTE_TAB_VALUES),
});

export const QuoteTabDetectionInstruction =
  'Identify which Proximéo quote-flow screen is currently displayed. Use exactly one of these labels:' +
  ' "vehicle_picker" (the broker is choosing a product/vehicle type. This covers BOTH the standalone' +
  ' Proximéo home — a top-menu page with "Tarif - Nouveau Client" / "Tarif Nouveau Client" / a row of' +
  ' product tiles Auto, Moto, Cyclomoteur, Camping car, VSP, 2 Roues, NVEI, Vélo, Speedbike, Habitation,' +
  ' Santé, etc. — AND the integrated extranet dashboard with the "Faire un devis pour un nouveau client"' +
  ' heading above the same product grid),' +
  ' "vehicule_tab" (the first tab of the quote form, with fields Marque / Cylindrée / Version / dates / Type d\'acquisition / Stationnement / CP),' +
  ' "conducteur_tab" (the second tab, with Date de naissance / Situation familiale / Profession / Antécédents),' +
  ' "garanties_tab" (the third tab — coverage formula choice with Tiers Illimité / Vol+Incendie / Dommages tous accidents and a commission slider),' +
  ' "price_preview" (a price has been computed and is visible on screen — a monthly or annual EUR amount is shown alongside the chosen formula),' +
  ' "bridge_modal" (a modal asking the broker to confirm the trottinette is bridled at 25 km/h),' +
  ' "devis_tab" (the fourth tab — subscriber info form with Civilité / Nom / Prénom / address fields),' +
  ' "unknown" (anything else, including a blank page, an error banner alone, or an unrelated Maxance page). ' +
  'If both a tab and a modal are visible, prefer "bridge_modal".' +
  ' If a 403 banner is visible but the product grid is also clearly visible, prefer the matching label' +
  ' (vehicle_picker). If the 403 banner is the only visible content, return "unknown".';

export const PricePreviewSchema = z.object({
  monthly: z.number().nullable(),
  annual: z.number().nullable(),
});

export const PricePreviewInstruction =
  'Extract the headline price shown on the Garanties tab. Return TWO numeric fields:' +
  ' "monthly" — the monthly premium in EUR if a per-month price is visible, otherwise null.' +
  ' "annual" — the annual premium in EUR if a per-year price is visible, otherwise null.' +
  ' Use the numeric value only (no currency symbol, no thousands separator). If only one' +
  ' cadence is shown on the page, set the other field to null.';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Sleep + settle helpers                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/** Read the per-run delay override (env). Used by tests to skip waits. */
export function settleMs(defaultMs: number): number {
  const raw = process.env.MAXANCE_QUOTE_STEP_DELAY_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return defaultMs;
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Bound a promise with a wall-clock timeout. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
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

/* ────────────────────────────────────────────────────────────────────────── */
/*  Deterministic Playwright form helpers                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Click an element by visible text via Playwright (no LLM). Used for the
 * stable Proximéo menu nav labels. Throws `maxance_quote_click_failed:<label>`
 * on miss.
 */
export async function clickByTextOrThrow(
  page: unknown,
  visibleText: string,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const p = page as {
    getByText: (
      text: string,
      opts?: { exact?: boolean },
    ) => {
      first: () => { click: (opts?: { timeout?: number }) => Promise<void> };
    };
  };
  try {
    await p
      .getByText(visibleText, { exact: false })
      .first()
      .click({ timeout: Math.min(timeoutMs, 30_000) });
  } catch (err) {
    throw new Error(
      `maxance_quote_click_failed:${label}:${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Set a <select> by its visible label via Playwright `getByLabel`. ~50× faster
 * than stagehand.act and immune to Stagehand v3's `$PARAMETER_NAME` bug.
 * Throws `maxance_quote_select_failed:<step>` on miss.
 */
export async function setSelectByLabel(
  page: unknown,
  labelText: string,
  value: string,
  stepLabel: string,
  timeoutMs: number,
): Promise<void> {
  const p = page as {
    getByLabel: (
      text: string,
      opts?: { exact?: boolean },
    ) => {
      selectOption: (
        value: string | { value: string } | { label: string },
        opts?: { timeout?: number },
      ) => Promise<unknown>;
    };
  };
  try {
    await p
      .getByLabel(labelText, { exact: false })
      .selectOption(value, { timeout: Math.min(timeoutMs, 30_000) });
  } catch (err) {
    throw new Error(
      `maxance_quote_select_failed:${stepLabel}:${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Fill a text input by its visible label. Same pattern as setSelectByLabel —
 * used for date inputs, postal code, free-text fields. Maxance's date
 * inputs accept `dd/mm/yyyy` strings directly (no calendar-picker click).
 */
export async function fillByLabel(
  page: unknown,
  labelText: string,
  value: string,
  stepLabel: string,
  timeoutMs: number,
): Promise<void> {
  const p = page as {
    getByLabel: (
      text: string,
      opts?: { exact?: boolean },
    ) => {
      fill: (value: string, opts?: { timeout?: number }) => Promise<void>;
    };
  };
  try {
    await p
      .getByLabel(labelText, { exact: false })
      .fill(value, { timeout: Math.min(timeoutMs, 30_000) });
  } catch (err) {
    throw new Error(
      `maxance_quote_fill_failed:${stepLabel}:${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Tab detection + screenshot capture                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Detect which quote-flow tab we're on. Retries on `unknown` because the
 * Proximéo wizard renders each tab in a second JS pass — `domcontentloaded`
 * isn't enough on slower runs.
 */
export async function detectTab(
  stagehand: Stagehand,
  attempts = 3,
  waitMs = 1500,
): Promise<QuoteTab> {
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
 * Take a screenshot of the active page. Best-effort: a capture failure is
 * logged but doesn't abort the step.
 */
export async function captureStep(
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
