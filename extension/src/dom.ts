/**
 * Vanilla DOM helpers — used by every content-script flow.
 *
 * These replace the Stagehand `getByLabel` / `getByText` / `setSelectByLabel`
 * helpers from quote-form.ts. Difference: we have full DOM access from an
 * extension content script (Stagehand had only what its accessibility tree
 * surfaced), so the helpers are simpler and more deterministic. Same naming
 * convention as the Stagehand helpers so anyone reading both can map them
 * easily.
 *
 * Convention: every helper throws a tagged error of the form
 * `maxance_dom_<op>_failed:<label>` on miss. The flow caller catches +
 * re-throws as a top-level maxance_quote_* / maxance_confirm_* tag so the
 * backend's QUOTE.FAILED mapping (unchanged from M8.T4) routes correctly.
 */

/** Default per-step poll budget. Tunable per call. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Polling interval inside waitFor* helpers. */
const POLL_INTERVAL_MS = 200;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Predicate-driven wait. Resolves when fn() returns truthy; rejects on timeout. */
export async function waitFor<T>(
  fn: () => T | null | undefined,
  opts: { timeoutMs?: number; label: string },
): Promise<NonNullable<T>> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`maxance_dom_wait_timeout:${opts.label}`);
}

/** True if the element is in the layout (offsetParent set OR has non-zero box). */
export function isVisible(el: Element | null | undefined): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.offsetParent !== null) return true;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Wait for the first matching, visible element. */
export function waitForVisible<T extends Element = HTMLElement>(
  selector: string,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const label = opts.label ?? selector;
  return waitFor<T>(
    () => {
      const el = document.querySelector<T>(selector);
      return isVisible(el as Element | null) ? el : null;
    },
    {
      label,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
  );
}

/** Wait until the current location matches a predicate. */
export function waitForUrl(
  predicate: (url: URL) => boolean,
  opts: { timeoutMs?: number; label: string },
): Promise<URL> {
  return waitFor<URL>(() => {
    const u = new URL(location.href);
    return predicate(u) ? u : null;
  }, opts);
}

/**
 * Find the <label> with the given text, then the <input|select|textarea>
 * it controls. Handles two markup patterns Maxance uses:
 *   1) `<label for="id">…</label> <input id="id">`
 *   2) `<label>… <input>` (input nested inside the label)
 * Plus a fallback: the next form element AFTER the label in the DOM.
 *
 * Match is substring + case-insensitive on textContent, matching how the
 * Stagehand `getByLabel` worked.
 */
export function findControlByLabel<T extends HTMLElement>(
  labelText: string,
  tags: readonly string[],
): T | null {
  const needle = normaliseLabel(labelText);
  // Pattern 1-3: standard <label> element lookup (RFC, prefer when present).
  const labels = Array.from(document.querySelectorAll('label'));
  for (const lab of labels) {
    const text = normaliseLabel(lab.textContent ?? '');
    if (!text.includes(needle)) continue;
    const forId = lab.getAttribute('for');
    if (forId) {
      const ctl = document.getElementById(forId);
      if (ctl && tags.includes(ctl.tagName)) return ctl as T;
    }
    const nested = lab.querySelector<HTMLElement>(tags.join(','));
    if (nested) return nested as T;
    let n: Element | null = lab.nextElementSibling;
    while (n) {
      if (tags.includes(n.tagName)) return n as T;
      const inner = n.querySelector<HTMLElement>(tags.join(','));
      if (inner) return inner as T;
      n = n.nextElementSibling;
    }
  }
  // Pattern 4 (Maxance fallback): the form-control's `name` attribute
  // embeds the French label. E.g. `<select name="vehiculeMarque">` for
  // "Marque", `<select name="vehiculeCylindree">` for "Cylindrée",
  // `<select name="mouvement.codeModeStationnement">` for "Stationnement".
  // Maxance's Proximéo doesn't use HTML `<label>` elements — labels live
  // in adjacent `<td>` cells of layout tables — so this name-fallback
  // catches the common case without us having to walk every layout row.
  const compactNeedle = needle.replace(/\s+/g, '');
  const noDiacriticsNeedle = stripDiacritics(compactNeedle);
  const candidates = document.querySelectorAll<HTMLElement>(tags.join(','));
  for (const ctl of candidates) {
    const compactName = normaliseLabel(ctl.getAttribute('name') ?? '').replace(/\s+/g, '');
    const compactId = normaliseLabel(ctl.getAttribute('id') ?? '').replace(/\s+/g, '');
    if (
      compactName.includes(compactNeedle) ||
      compactId.includes(compactNeedle) ||
      compactName.includes(noDiacriticsNeedle) ||
      compactId.includes(noDiacriticsNeedle)
    ) {
      return ctl as T;
    }
  }
  // Pattern 5 (last-resort): walk layout-table / div-grid labels — look
  // for a non-<label> element whose text matches the needle, then take
  // the first form control in its row's siblings or descendants.
  const textBearers = Array.from(document.querySelectorAll<HTMLElement>('td, th, div, span'));
  for (const el of textBearers) {
    if (el.querySelector(tags.join(','))) continue;
    const text = normaliseLabel(el.textContent ?? '');
    if (!text.includes(needle)) continue;
    let n: Element | null = el.nextElementSibling;
    while (n) {
      if (tags.includes(n.tagName)) return n as T;
      const inner = n.querySelector<HTMLElement>(tags.join(','));
      if (inner) return inner as T;
      n = n.nextElementSibling;
    }
    const parentRow = el.closest('tr');
    if (parentRow?.nextElementSibling) {
      const downstream = parentRow.nextElementSibling.querySelector<HTMLElement>(tags.join(','));
      if (downstream) return downstream as T;
    }
  }
  return null;
}

function normaliseLabel(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function stripDiacritics(s: string): string {
  // Maxance names drop accents — `vehiculeCylindree` for "Cylindrée".
  return s.normalize('NFD').replace(/\p{M}+/gu, '');
}

/**
 * Set a <select> by visible label. Tries selectOption-by-value first; if
 * the option's value attribute matches `value`, use that. Otherwise fall
 * back to matching the option's text. Fires change + input events so
 * Maxance's jQuery onchange handlers run.
 */
export async function setSelectByLabel(
  labelText: string,
  value: string,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const stepLabel = opts.label ?? labelText;
  // Re-find the select on each poll. Maxance's Proximéo cascade replaces
  // dependent <select> elements wholesale when a parent changes — not
  // just their options — so a cached reference from a prior find quickly
  // becomes an orphan whose .options reflects the OLD state forever.
  // We pair "find select" and "lookup option" in one tick so we always
  // read options off the LIVE element.
  const found = await waitFor<{ select: HTMLSelectElement; option: HTMLOptionElement }>(
    () => {
      const select = findControlByLabel<HTMLSelectElement>(labelText, ['SELECT']);
      if (!select) return null;
      const byValue = Array.from(select.options).find((o) => o.value === value);
      if (byValue) return { select, option: byValue };
      const byText = Array.from(select.options).find(
        (o) => (o.textContent ?? '').trim().toLowerCase() === value.toLowerCase(),
      );
      return byText ? { select, option: byText } : null;
    },
    {
      label: `select_option:${stepLabel}:${value}`,
      // Long enough to survive AJAX populates (typical ~1-2s on Maxance,
      // up to ~5s when their backend is cold), short enough that a TRULY
      // missing option (wrong constant) fails fast.
      timeoutMs: 8_000,
    },
  ).catch((err: unknown) => {
    // Re-throw with the legacy tagged-error format so QUOTE.FAILED routing
    // continues to surface the same `maxance_dom_select_option_missing`
    // signature the Operator agent (M8.T4) already knows.
    throw err instanceof Error && err.message.startsWith('maxance_dom_wait_timeout')
      ? new Error(`maxance_dom_select_option_missing:${stepLabel}:${value}`)
      : err;
  });
  const { select, option: picked } = found;
  // Force a real change event even if the select already holds the
  // target value. Maxance's onchange handlers no-op when
  // oldValue === newValue, but downstream dependent dropdowns may not
  // have been populated yet (e.g. partial-fill from a crashed earlier
  // flow). Clearing to '' first guarantees the next assignment fires.
  if (select.value === picked.value) {
    select.value = '';
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  select.value = picked.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Fill a text input found by label. Fires input + change + blur. */
export async function fillByLabel(
  labelText: string,
  value: string,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const stepLabel = opts.label ?? labelText;
  const input = await waitFor(
    () =>
      findControlByLabel<HTMLInputElement | HTMLTextAreaElement>(labelText, ['INPUT', 'TEXTAREA']),
    {
      label: `find_input:${stepLabel}`,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
  );
  input.focus();
  // Use the native value setter so React/jQuery framework state stays
  // consistent. Plain `input.value = x` skips React's tracker.
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
 * Click the first visible element whose textContent matches `text`. Match
 * is substring + case-insensitive. Searches <a>, <button>, <input>, <td>,
 * <div>, <span> — covers Maxance's mix of mdiWindNet table-buttons and
 * standard form buttons.
 */
export async function clickByText(
  text: string,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const stepLabel = opts.label ?? text;
  // Normalise needle + haystack so the matcher tolerates &nbsp; (U+00A0)
  // and other whitespace variants Maxance sprinkles in its tab labels.
  // Without this, "Tarif - Nouveau Client" (ASCII spaces) never matched
  // the rendered "Tarif - Nouveau Client" — the live phase-2d
  // run timed out 25s into this exact click. M8.T8 phase-2d fix.
  const needle = normaliseSpaces(text);
  const el = await waitFor<HTMLElement>(
    () => {
      const candidates = document.querySelectorAll<HTMLElement>(
        'a, button, input[type=button], input[type=submit], td, div, span',
      );
      // Pick the SMALLEST-area visible candidate that contains the needle.
      // The naive "first match in document order" approach picks up the
      // outermost wrapper (e.g. Maxance's `#cacheHeader` at 1920×86) because
      // textContent contains every descendant's text — clicking it is a
      // no-op. The actual menu tab is a tight 170×19 leaf. Smallest-area
      // wins reliably for menu items, buttons, and label-style spans.
      // M8.T8 phase-2d fix (live-verified 2026-05-25).
      let best: HTMLElement | null = null;
      let bestArea = Number.POSITIVE_INFINITY;
      for (const c of candidates) {
        if (!isVisible(c)) continue;
        const t = normaliseSpaces(c.textContent ?? c.getAttribute('value') ?? '');
        if (!t.includes(needle)) continue;
        const r = c.getBoundingClientRect();
        const area = r.width * r.height || Number.POSITIVE_INFINITY;
        if (area < bestArea) {
          best = c;
          bestArea = area;
        }
      }
      return best;
    },
    {
      label: `click:${stepLabel}`,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
  );
  el.click();
}

/**
 * Lowercase + collapse every whitespace run (incl. U+00A0 nbsp, tabs,
 * newlines) to a single ASCII space. Used by `clickByText` so menu labels
 * rendered with `&nbsp;` still match user-typed needles with normal spaces.
 */
function normaliseSpaces(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Click any radio whose <label> matches the given text. Maxance's
 * Antécédents radios have visible labels next to them, so this is the
 * idiomatic way to bulk-set them.
 */
export async function clickRadioByLabel(
  labelText: string,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const stepLabel = opts.label ?? labelText;
  const radio = await waitFor(() => findControlByLabel<HTMLInputElement>(labelText, ['INPUT']), {
    label: `find_radio:${stepLabel}`,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (radio.type !== 'radio' && radio.type !== 'checkbox') {
    throw new Error(`maxance_dom_not_a_radio:${stepLabel}:${radio.type}`);
  }
  radio.click();
}

/**
 * Click a Maxance "Suivant >>" / "Valider devis" style button by its
 * stable container ID (e.g. `validerVehicule`, `validerConducteur`,
 * `validerDevis`).
 *
 * Why a dedicated helper instead of clickByText: the Maxance Proximéo UI
 * wraps every action button in `<div id="validerXxx"><div class="buttonMiddle">Suivant >></div>`
 * and binds its onclick to the `.buttonMiddle` child specifically on the
 * `mouseup` event (legacy mdiWindNet pattern). Calling `.click()` on the
 * outer `#validerXxx` div does NOT trigger the framework's onclick
 * because the event listener checks `event.target === buttonMiddle` and
 * fires on mouseup, not click. Dispatching `mousedown + mouseup + click`
 * on `.buttonMiddle` (or falling back to the container) is the only
 * pattern that actually navigates.
 *
 * Verified live 2026-05-25 phase-2e MCP investigation:
 *   #validerVehicule .buttonMiddle  → navigates from Véhicule → Conducteur
 *   #validerConducteur .buttonMiddle → navigates from Conducteur → Garanties
 */
export async function clickMaxanceButton(
  containerId: string,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const stepLabel = opts.label ?? containerId;
  // First wait until the button container exists in the DOM.
  await waitFor<HTMLElement>(() => document.getElementById(containerId), {
    label: `find_button:${stepLabel}`,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  // Phase-2f-4: route the actual mouse-event dispatch through the SW which
  // calls chrome.scripting.executeScript({ world: 'MAIN' }) — this is the
  // ONLY way to fire events in the page's main JS context from an MV3
  // extension that also bypasses the page's CSP. Earlier attempts:
  //   - Phase 2e: synthetic dispatch from isolated world without coords.
  //     Click fired, but Maxance's post-submit bounced to /accueil.do.
  //   - Phase 2f-1: added await_zonier_populated. No change.
  //   - Phase 2f-2: added clientX/clientY/button/buttons to MouseEventInit.
  //     No change — fields correct, dump shows it, still bounced.
  //   - Phase 2f-3: inject inline <script> from content script. Maxance's
  //     CSP blocked the script — click never fired (loop on vehicule_tab,
  //     no nav at all).
  // The Chrome MCP javascript_tool uses chrome.scripting under the hood
  // and the same input deterministically advanced past Suivant in the
  // diagnostic. So we use that same mechanism here.
  const msg: import('./content-protocol.js').MainWorldClickRequest = {
    kind: 'click.main-world',
    containerId,
  };
  const resp = (await chrome.runtime.sendMessage(msg)) as
    | { kind: 'click.ok' }
    | { kind: 'click.err'; error: string }
    | undefined;
  if (!resp || resp.kind !== 'click.ok') {
    throw new Error(
      `maxance_dom_click_failed:${stepLabel}:${resp?.kind === 'click.err' ? resp.error : 'no_response'}`,
    );
  }
}

/**
 * Find the FIRST <select> whose <option> list includes the given
 * `optionValue`. Used to identify ambiguous Maxance selects whose names
 * are JWT-encoded (e.g. the Conducteur tab's Profession dropdown — its
 * name is opaque but it's the only select that has value "125"). Pair
 * with `setSelectValue` to set it.
 */
export function findSelectByOptionValue(optionValue: string): HTMLSelectElement | null {
  const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
  return selects.find((s) => Array.from(s.options).some((o) => o.value === optionValue)) ?? null;
}

/** Set `select.value = value`, dispatch input + change. Force-fires when
 *  the select is already at value (Maxance's onchange no-ops on no-op set,
 *  so we briefly clear to '' first to guarantee a real change event). */
export function setSelectValue(select: HTMLSelectElement, value: string): void {
  if (select.value === value) {
    select.value = '';
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  select.value = value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Set a radio in the group whose ancestor chain contains `questionNeedle`
 * (case-insensitive substring match). Pairs the radio with siblings by
 * `name` then picks the one with `targetValue`. Dispatches click + change.
 *
 * Designed for Maxance's Conducteur tab where radio NAMES are JWT-encoded
 * but each radio group sits in a layout row whose previous cell carries
 * the French question text ("Souscripteur?", "Titulaire carte grise?",
 * "...résiliation par votre assureur?", etc.).
 */
export function setRadioByQuestion(
  questionNeedle: string,
  targetValue: string,
): { ok: true; groupName: string } | { ok: false; reason: string } {
  const needle = normaliseLabel(questionNeedle);
  const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=radio]'));
  const seenNames = new Set<string>();
  for (const r of radios) {
    if (!r.name || seenNames.has(r.name)) continue;
    seenNames.add(r.name);
    // Phase-2f-7 (2026-05-25 PM live-diag fix): match ONLY against the
    // radio's closest <tr> (or, for non-table layouts, the closest
    // ancestor that contains exactly one <input type=radio> group). The
    // previous "walk up 6 ancestors" approach was greedy — a high-level
    // ancestor (TBODY/TABLE wrapping multiple rows) contains text from
    // EVERY question in the section, so any needle that appears anywhere
    // in that section matched the FIRST radio group encountered. Concrete
    // case: needle "annulation, d'une suspension" matched the
    // condamnationDelit group at TBODY level (level 5), setting
    // condamnation again and leaving annulation empty → Maxance Suivant
    // rejected with "La valeur du champ ... est obligatoire" alerte.
    const tr = r.closest('tr');
    const scopeText = normaliseLabel(tr?.textContent ?? '');
    if (!scopeText.includes(needle)) continue;
    const target = radios.find((x) => x.name === r.name && x.value === targetValue);
    if (!target) return { ok: false, reason: `no_value_${targetValue}_in_group_${r.name}` };
    target.checked = true;
    target.dispatchEvent(new Event('click', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, groupName: r.name };
  }
  return { ok: false, reason: 'no_radio_group_matched_needle' };
}

/**
 * Capture the current viewport as a PNG data URL. Used to attach
 * screenshots to flow results so the backend's operator UI can show them.
 * Implemented via chrome.tabs.captureVisibleTab from the SW (content
 * scripts can't capture themselves). The content script signals "ready
 * for screenshot" via a chrome.runtime.sendMessage of type
 * 'capture_screenshot'; the SW captures + responds with the data URL.
 */
export async function captureScreenshot(step: string): Promise<{ step: string; dataUrl: string }> {
  const resp = (await chrome.runtime.sendMessage({ kind: 'capture_screenshot' })) as
    | { kind: 'capture.ok'; dataUrl: string }
    | { kind: 'capture.err'; error: string };
  if (resp.kind !== 'capture.ok') {
    throw new Error(`maxance_dom_screenshot_failed:${step}:${resp.error}`);
  }
  return { step, dataUrl: resp.dataUrl };
}

/**
 * Parse a French-formatted EUR price string ("18,95 €" / "90.85€" /
 * "1 234,56 €") into a number. Returns null on no match.
 */
export function parseEurPrice(text: string | null | undefined): number | null {
  if (!text) return null;
  // Match a digit-block (optionally with thousand separators), then a
  // decimal separator + 2 digits, then € or EUR.
  const m = /(\d[\d\s.]*)[,.](\d{2})\s*(?:€|EUR)/.exec(text);
  if (!m) return null;
  const whole = (m[1] ?? '').replace(/[\s.]/g, '');
  const decimal = m[2] ?? '0';
  return Number.parseFloat(`${whole}.${decimal}`);
}
