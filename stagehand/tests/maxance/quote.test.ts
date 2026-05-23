/**
 * Unit tests for `startQuote` (M8.T3).
 *
 * Real Stagehand is replaced with a `StubStagehand` that records every act /
 * extract / goto call and returns scripted responses. No network, no Chromium,
 * no Anthropic spend — each test case runs in <100ms.
 *
 * Coverage:
 *   - happy path: vehicle_picker → vehicule_tab → conducteur_tab → bridge_modal
 *     → garanties_tab → price_preview ⇒ MaxanceQuoteResult with the price
 *   - resume case: caller already on vehicule_tab (vehicle picker skipped)
 *   - guardrails: non-trottinette vehicleKind, dryRun=false, no entry page
 *   - commission clamp: out-of-range values snap to the legal band
 *   - error path: unexpected page mid-flow surfaces a tagged error
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startQuote } from '../../src/maxance/quote.js';
import type { MaxanceQuoteParams } from '../../src/maxance/types.js';

/**
 * Minimal Page stand-in — same shape as the login.test.ts stub, plus a
 * `getByText` shim because quote.ts now bypasses Stagehand.act and clicks
 * the Proximéo menu items directly via Playwright. The stub records every
 * `getByText().first().click()` chain so tests can assert which labels
 * the flow clicked.
 */
class StubPage {
  goto = async (_url: string, _opts: unknown): Promise<void> => {
    this.gotos.push(_url);
  };
  url = (): string => 'https://www.maxance.com/Proximeo/quote/preview';
  title = async (): Promise<string> => 'stub';
  screenshot = async (_opts: { type: 'png'; fullPage: boolean }): Promise<Buffer> =>
    Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  gotos: string[] = [];
  textClicks: string[] = [];

  getByText = (
    text: string,
    _opts?: { exact?: boolean },
  ): {
    first: () => { click: (opts?: { timeout?: number }) => Promise<void> };
  } => {
    const recordClick = async (_opts?: { timeout?: number }): Promise<void> => {
      this.textClicks.push(text);
    };
    return { first: () => ({ click: recordClick }) };
  };
}

/**
 * Configurable double. Returns scripted `extract` responses in two flavours:
 *   - tab detections (`{ tab: <QuoteTab> }`)
 *   - price extractions (`{ monthly: number|null, annual: number|null }`)
 *
 * The two are dispatched on the instruction text — `detectTab` uses the
 * "Identify which Proximéo quote-flow screen" prompt; `extractPrice` uses
 * the "Extract the headline price" prompt.
 */
class StubStagehand {
  page = new StubPage();
  context = { activePage: (): StubPage => this.page };

  tabResponses: string[] = [];
  priceResponses: Array<{ monthly: number | null; annual: number | null }> = [];
  actCalls: { instruction: string; variables?: Record<string, string> }[] = [];

  extract = async (instruction: string, _schema: unknown): Promise<unknown> => {
    if (instruction.includes('which Proximéo quote-flow screen')) {
      const next = this.tabResponses.shift();
      if (!next) throw new Error('StubStagehand: ran out of scripted tab responses');
      return { tab: next };
    }
    if (instruction.includes('Extract the headline price')) {
      const next = this.priceResponses.shift();
      if (!next) throw new Error('StubStagehand: ran out of scripted price responses');
      return next;
    }
    throw new Error(`StubStagehand: unrecognised extract instruction: ${instruction}`);
  };

  act = async (
    instruction: string,
    opts?: { variables?: Record<string, string> },
  ): Promise<void> => {
    this.actCalls.push({ instruction, ...(opts?.variables ? { variables: opts.variables } : {}) });
  };
}

const asStagehand = <T>(s: T): import('@browserbasehq/stagehand').Stagehand =>
  s as unknown as import('@browserbasehq/stagehand').Stagehand;

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'f16-maxance-quote-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

const baseParams: MaxanceQuoteParams = {
  vehicleKind: 'trottinette',
  purchasePriceEur: 350,
  purchaseDate: new Date('2026-01-15T00:00:00Z'),
  postalCode: '75001',
  stationnement: 'garage_box',
  clientDateOfBirth: new Date('1990-06-12T00:00:00Z'),
};

describe('startQuote — happy path (full picker → price)', () => {
  it('navigates picker → vehicule → conducteur → bridge → garanties → price', async () => {
    const sh = new StubStagehand();
    // New entry flow: after Accès Proximéo click, we DON'T re-detect — we
    // drive the menu chain blindly via Playwright getByText. detectTab fires
    // only AFTER Trottinette has been clicked (entry to vehicule_tab).
    sh.tabResponses = [
      'vehicle_picker', // entry detection (integrated dashboard)
      'vehicule_tab', // after Trottinette click
      'conducteur_tab', // after vehicule Suivant
      'bridge_modal', // after conducteur Suivant
      'garanties_tab', // after bridge modal
      'price_preview', // after Garanties config (terminal)
    ];
    sh.priceResponses = [{ monthly: 12.34, annual: null }];

    const out = await startQuote(asStagehand(sh), 'sess-quote-1', baseParams, {
      dataRoot: dataDir,
      dryRun: true,
    });

    expect(out.dryRun).toBe(true);
    expect(out.pricePreviewEur.monthly).toBe(12.34);
    expect(out.pricePreviewEur.annual).toBeUndefined();
    expect(out.finalUrl).toMatch(/maxance/);
    expect(out.screenshots.length).toBeGreaterThanOrEqual(5);

    // The whole entry+menu chain runs via direct Playwright getByText clicks
    // — no LLM round-trips (sidesteps Stagehand v3's $PARAMETER_NAME bug on
    // Anthropic) and ~50× faster than the act-based equivalent.
    expect(sh.page.textClicks).toEqual(
      expect.arrayContaining([
        'Accès Proximéo',
        'Tarif - Nouveau Client',
        '2 roues et quads',
        'Trottinette',
      ]),
    );

    // Spot-check that purchase price + dates were passed via `variables`,
    // not interpolated into the instruction text.
    const priceAct = sh.actCalls.find((c) => c.instruction.includes('%priceEur%'));
    expect(priceAct?.variables?.priceEur).toBe('350');
    const pmecAct = sh.actCalls.find((c) => c.instruction.includes('Première mise en circulation'));
    expect(pmecAct?.variables?.dateFr).toBe('15/01/2026');

    // Defaults Achraf flagged: Cylindrée=25, Protection vol=Non, etc. must
    // have fired even though they're not in the params.
    expect(sh.actCalls.find((c) => c.instruction.includes('Cylindrée'))).toBeDefined();
    expect(sh.actCalls.find((c) => c.instruction.includes('Protection vol'))).toBeDefined();
    expect(sh.actCalls.find((c) => c.instruction.includes('Comptant'))).toBeDefined();
    expect(sh.actCalls.find((c) => c.instruction.includes('Antécédents'))).toBeDefined();
    expect(sh.actCalls.find((c) => c.instruction.includes('Souscripteur'))).toBeDefined();
  });
});

describe('startQuote — resume from mid-flow', () => {
  it('skips picker when entry is already vehicule_tab', async () => {
    const sh = new StubStagehand();
    sh.tabResponses = [
      'vehicule_tab', // entry already on the first form tab
      'conducteur_tab',
      'garanties_tab', // no bridge modal this time
      'price_preview',
    ];
    sh.priceResponses = [{ monthly: null, annual: 142.5 }];

    const out = await startQuote(asStagehand(sh), 'sess-quote-resume', baseParams, {
      dataRoot: dataDir,
      dryRun: true,
    });

    expect(out.pricePreviewEur.annual).toBe(142.5);
    expect(out.pricePreviewEur.monthly).toBeUndefined();
    // No menu clicks since the picker was skipped (resume entry was already
    // on the vehicule_tab, so the inWizard branch took over).
    expect(sh.page.textClicks).not.toContain('Tarif - Nouveau Client');
    expect(sh.page.textClicks).not.toContain('Trottinette');
  });

  it('skips the bridge modal when it does not appear', async () => {
    const sh = new StubStagehand();
    sh.tabResponses = [
      'vehicule_tab',
      'conducteur_tab',
      'garanties_tab', // straight to Garanties — no modal pop-up
      'price_preview',
    ];
    sh.priceResponses = [{ monthly: 11, annual: null }];

    const out = await startQuote(asStagehand(sh), 'sess-no-modal', baseParams, {
      dataRoot: dataDir,
      dryRun: true,
    });

    expect(out.pricePreviewEur.monthly).toBe(11);
    // No "Confirmer" / bridge click should have fired.
    expect(sh.actCalls.find((c) => c.instruction.includes('bridled at 25'))).toBeUndefined();
  });
});

describe('startQuote — guardrails', () => {
  it('rejects non-trottinette vehicleKind', async () => {
    const sh = new StubStagehand();
    await expect(
      startQuote(
        asStagehand(sh),
        'sess-bad-veh',
        { ...baseParams, vehicleKind: 'auto' as unknown as 'trottinette' },
        { dataRoot: dataDir, dryRun: true },
      ),
    ).rejects.toThrow(/maxance_quote_unsupported_vehicle/);
  });

  it('rejects dryRun=false (full submission not implemented yet)', async () => {
    const sh = new StubStagehand();
    await expect(
      startQuote(asStagehand(sh), 'sess-no-submit', baseParams, {
        dataRoot: dataDir,
        dryRun: false,
      }),
    ).rejects.toThrow(/maxance_quote_full_submission_not_implemented/);
  });

  it('throws when the post-Trottinette tab is unrecognised (broken Maxance UI)', async () => {
    const sh = new StubStagehand();
    // Entry detects as unknown → not inWizard → blind menu chain runs (stub
    // accepts every getByText) → detectTab after Trottinette → unknown × 3
    // (retry budget exhausted) → throws unexpected_entry_page:unknown.
    sh.tabResponses = [
      // detectTab retries 3× on `unknown` before giving up — supply enough
      // responses for both the entry detect and the post-Trottinette detect.
      'unknown',
      'unknown',
      'unknown', // entry detect exhausts retries → returns 'unknown'
      'unknown',
      'unknown',
      'unknown', // post-Trottinette detect exhausts retries → throws
    ];

    await expect(
      startQuote(asStagehand(sh), 'sess-bad-entry', baseParams, {
        dataRoot: dataDir,
        dryRun: true,
      }),
    ).rejects.toThrow(/maxance_quote_unexpected_entry_page/);
  });
});

describe('startQuote — commission clamping', () => {
  it('clamps an out-of-range commission down to 22', async () => {
    const sh = new StubStagehand();
    sh.tabResponses = [
      'garanties_tab', // resume directly on Garanties
      'price_preview',
    ];
    sh.priceResponses = [{ monthly: 20, annual: null }];

    await startQuote(
      asStagehand(sh),
      'sess-commission-high',
      { ...baseParams, commissionPct: 99 },
      { dataRoot: dataDir, dryRun: true },
    );

    const commissionAct = sh.actCalls.find((c) => c.instruction.includes('commission slider'));
    expect(commissionAct?.variables?.pct).toBe('22');
  });

  it('clamps a negative commission up to 9', async () => {
    const sh = new StubStagehand();
    sh.tabResponses = ['garanties_tab', 'price_preview'];
    sh.priceResponses = [{ monthly: 10, annual: null }];

    await startQuote(
      asStagehand(sh),
      'sess-commission-low',
      { ...baseParams, commissionPct: -5 },
      { dataRoot: dataDir, dryRun: true },
    );

    const commissionAct = sh.actCalls.find((c) => c.instruction.includes('commission slider'));
    expect(commissionAct?.variables?.pct).toBe('9');
  });
});

describe('startQuote — error path', () => {
  it('throws maxance_quote_unexpected_pricing_page when Garanties never settles', async () => {
    const sh = new StubStagehand();
    sh.tabResponses = [
      'vehicule_tab', // entry
      'conducteur_tab',
      'garanties_tab',
      'unknown', // after configuring Garanties, no price preview detected
      'unknown',
      'unknown',
    ];

    await expect(
      startQuote(asStagehand(sh), 'sess-no-price', baseParams, {
        dataRoot: dataDir,
        dryRun: true,
      }),
    ).rejects.toThrow(/maxance_quote_unexpected_pricing_page/);
  });
});

describe('startQuote — screenshot capture', () => {
  it('writes screenshots to disk and returns served URLs', async () => {
    const sh = new StubStagehand();
    sh.tabResponses = [
      'vehicle_picker', // entry
      'vehicule_tab', // after Trottinette click
      'conducteur_tab',
      'garanties_tab',
      'price_preview',
    ];
    sh.priceResponses = [{ monthly: 9.99, annual: null }];

    const out = await startQuote(asStagehand(sh), 'sess-shots', baseParams, {
      dataRoot: dataDir,
      dryRun: true,
    });

    // Every returned screenshot URL points to /v1/static/screenshots/...
    for (const s of out.screenshots) {
      expect(s.url).toMatch(/^\/v1\/static\/screenshots\//);
    }

    const files = await readdir(join(dataDir, 'screenshots'));
    expect(files.length).toBe(out.screenshots.length);
    // Filenames must include the session id so multi-session captures don't
    // collide on the served path.
    for (const f of files) {
      expect(f).toContain('sess-shots');
      expect(f).toContain('maxance-quote-');
    }
  });
});
