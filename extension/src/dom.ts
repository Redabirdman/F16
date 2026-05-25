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
  const needle = labelText.toLowerCase().trim();
  const labels = Array.from(document.querySelectorAll('label'));
  for (const lab of labels) {
    const text = (lab.textContent ?? '').toLowerCase().trim();
    if (!text.includes(needle)) continue;
    // Pattern 1: explicit for=id
    const forId = lab.getAttribute('for');
    if (forId) {
      const ctl = document.getElementById(forId);
      if (ctl && tags.includes(ctl.tagName)) return ctl as T;
    }
    // Pattern 2: nested control
    const nested = lab.querySelector<HTMLElement>(tags.join(','));
    if (nested) return nested as T;
    // Pattern 3: next form element in DOM order
    let n: Element | null = lab.nextElementSibling;
    while (n) {
      if (tags.includes(n.tagName)) return n as T;
      const inner = n.querySelector<HTMLElement>(tags.join(','));
      if (inner) return inner as T;
      n = n.nextElementSibling;
    }
  }
  return null;
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
  const select = await waitFor(() => findControlByLabel<HTMLSelectElement>(labelText, ['SELECT']), {
    label: `find_select:${stepLabel}`,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  // Try value-match first.
  const byValue = Array.from(select.options).find((o) => o.value === value);
  const byText = byValue
    ? null
    : Array.from(select.options).find(
        (o) => (o.textContent ?? '').trim().toLowerCase() === value.toLowerCase(),
      );
  const picked = byValue ?? byText;
  if (!picked) {
    throw new Error(`maxance_dom_select_option_missing:${stepLabel}:${value}`);
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
