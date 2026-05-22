/**
 * Shared types for the M8.T2 Maxance login + heartbeat module.
 *
 * Kept separate from `src/types.ts` (which carries HTTP-surface contracts) so
 * the Maxance-specific surface can evolve without churning unrelated callers.
 */

/**
 * Outcome of one `extract` call against the live page. The page-type label is
 * narrow on purpose — the login flow's branching switch only handles these
 * cases. Anything Stagehand returns outside this set collapses to `unknown`
 * and escalates.
 */
export type MaxancePageType =
  | 'login_form'
  | 'password_form'
  | 'dashboard'
  | 'sms_prompt'
  | 'proximeo_home'
  | 'error_page'
  | 'unknown';

/**
 * One screenshot captured during the login flow. `step` is a short slug
 * (`login_form_pre`, `dashboard_post`, `proximeo_home`) for audit-log
 * correlation; `url` is the served path (`/v1/static/screenshots/...`).
 */
export interface MaxanceLoginScreenshot {
  step: string;
  url: string;
}

/**
 * Success payload returned by `loginMaxance`. On any unrecoverable failure
 * the function throws (sanitised — never carrying creds) instead of returning
 * a partial result.
 */
export interface MaxanceLoginResult {
  sessionId: string;
  durationMs: number;
  screenshots: MaxanceLoginScreenshot[];
  alreadyLoggedIn: boolean;
  requiredHumanAction: boolean;
  /** Should match the Proximéo home URL on success. */
  finalUrl: string;
}

/**
 * The human-action resolver is wired by the HTTP layer (or M8.T4 directly)
 * to the backend's HUMAN_ACTION.REQUESTED flow. The login function calls it
 * once on a 2FA prompt and AWAITS the returned promise — when the human
 * supplies the code (via admin UI or WhatsApp), the resolver resolves.
 *
 * On timeout (login flow's responsibility, 15min default) the caller should
 * race a timeout and throw so the user-data dir doesn't sit half-authenticated.
 */
export type HumanActionResolver = (req: HumanActionRequest) => Promise<string>;

export interface HumanActionRequest {
  /** Short human-readable summary for the operator. */
  summary: string;
  /** Allowed response options. For 2FA: a free-text code. */
  options: { type: 'free_text'; label: string }[];
  /** Correlation id to attach to the HUMAN_ACTION row. */
  correlationId: string;
}

export interface MaxanceLoginOptions {
  /** Resolver invoked on 2FA SMS prompt. Required — there is no automatic fallback. */
  humanActionResolver: HumanActionResolver;
  /** Where to write screenshots. Defaults to STAGEHAND_DATA_DIR. */
  dataRoot?: string;
  /**
   * Override the 2FA wait budget. Default 15min. Tests override to ~50ms.
   * The login function throws `maxance_2fa_timeout` if exceeded.
   */
  twoFactorTimeoutMs?: number;
  /** Optional callback fired after each screenshot capture (for streaming UIs). */
  screenshotCallback?: (shot: MaxanceLoginScreenshot) => void;
  /**
   * When true, the function does NOT try to fill / submit the MFA code itself.
   * It pauses on the SMS prompt and polls the page until a human has manually
   * typed the code, ticked "Se souvenir 30 jours", and clicked Continuer in
   * the visible browser. Use for the first-of-the-month bootstrap when SMS
   * codes expire faster than we can route them through chat.
   *
   * Polls every `manualSmsPollIntervalMs` (default 2000ms) up to
   * `twoFactorTimeoutMs`. Throws `maxance_2fa_timeout` if exceeded.
   */
  manualSmsHandling?: boolean;
  /** Poll interval for manualSmsHandling mode. Default 2000ms. */
  manualSmsPollIntervalMs?: number;
}
