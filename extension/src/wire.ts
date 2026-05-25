/**
 * Wire schemas for backend ↔ extension communication (M8.T8 phase 2).
 *
 * Transport: WebSocket. The extension service worker (`background.ts`) opens
 * an outbound WS to `ws://127.0.0.1:9223` (backend's `extension-client.ts`,
 * landing in phase 2c). Both directions exchange Zod-validated JSON messages
 * — schemas defined here are the single source of truth.
 *
 * Conventions:
 *   - Every envelope carries `id` (uuid) + `kind` (discriminator).
 *   - Commands FLOW backend → extension: `quote.preview`, `quote.confirm`,
 *     `login.ensure`, `ping`. Each command has a paired response with the
 *     same `id`.
 *   - Status events flow extension → backend: `ready`, `quote.progress`,
 *     `error`. These are not paired with a request id (they're spontaneous).
 *
 * Mirrors the in-process types from `stagehand/src/maxance/types.ts` where
 * possible — same field names + value enums — so the eventual selectors-only
 * import from stagehand stays cheap. Where the wire side needs JSON-safe
 * representations (no `Date`), we use ISO strings.
 */
import { z } from 'zod';

/** Maxance quote-flow params over the wire. JSON-safe (dates as ISO strings). */
export const QuoteParamsSchema = z.object({
  vehicleKind: z.literal('trottinette'),
  purchasePriceEur: z.number().positive(),
  /** ISO date string e.g. "2026-01-15". */
  purchaseDate: z.string(),
  postalCode: z.string().regex(/^\d{5}$/),
  city: z.string().optional(),
  stationnement: z.enum(['garage_box', 'parking_prive_clos', 'parking_prive_non_clos', 'rue']),
  /** ISO date string e.g. "1990-06-12". */
  clientDateOfBirth: z.string(),
  formule: z.enum(['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents']).optional(),
  commissionPct: z.number().min(0).max(100).optional(),
  fractionnement: z.enum(['mensuel', 'annuel']).optional(),
});
export type QuoteParams = z.infer<typeof QuoteParamsSchema>;

/** Subscriber info for the Devis tab. JSON-safe. */
export const SubscriberInfoSchema = z.object({
  civilite: z.enum(['monsieur', 'madame']),
  lastName: z.string().min(1),
  firstName: z.string().min(1),
  addressLine: z.string().min(1),
  addressComplement: z.string().optional(),
  postalCode: z.string().regex(/^\d{5}$/),
  city: z.string().min(1),
  phoneMobile: z.string().min(1),
  email: z.string().email(),
  profession: z
    .enum(['employe_prive', 'employe_public', 'etudiant', 'retraite', 'sans_profession'])
    .optional(),
});
export type SubscriberInfo = z.infer<typeof SubscriberInfoSchema>;

/** One screenshot result reported back to the backend (data URL). */
export const ScreenshotSchema = z.object({
  step: z.string(),
  /** Base64 PNG data URL — the extension captures via chrome.tabs.captureVisibleTab. */
  dataUrl: z.string().startsWith('data:image/png;base64,'),
});
export type Screenshot = z.infer<typeof ScreenshotSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Backend → extension commands                                              */
/* ────────────────────────────────────────────────────────────────────────── */

export const PingCommandSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('ping'),
  /** Optional payload echoed back in the pong, useful for round-trip tests. */
  nonce: z.string().optional(),
});

export const LoginEnsureCommandSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('login.ensure'),
  /** Wall-clock budget for the warm-path check. Default 60s on the server. */
  timeoutMs: z.number().int().positive().optional(),
});

export const QuotePreviewCommandSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('quote.preview'),
  params: QuoteParamsSchema,
  /** Always true in V1 — the prod flow stops at the price preview. */
  dryRun: z.literal(true),
  timeoutMs: z.number().int().positive().optional(),
});

export const QuoteConfirmCommandSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('quote.confirm'),
  subscriber: SubscriberInfoSchema,
  /** True = stop before final Envoyer click. False = send the real email. */
  dryRun: z.boolean(),
  timeoutMs: z.number().int().positive().optional(),
});

export const CommandSchema = z.discriminatedUnion('kind', [
  PingCommandSchema,
  LoginEnsureCommandSchema,
  QuotePreviewCommandSchema,
  QuoteConfirmCommandSchema,
]);
export type Command = z.infer<typeof CommandSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Extension → backend responses                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export const PongResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('pong'),
  nonce: z.string().optional(),
});

export const LoginEnsureResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('login.ensure.ok'),
  alreadyLoggedIn: z.boolean(),
  /** "M8.T2.required_human_action" → caller surfaces via human-action flow. */
  requiredHumanAction: z.boolean(),
  finalUrl: z.string().url(),
  durationMs: z.number().nonnegative(),
});

export const QuotePreviewResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('quote.preview.ok'),
  pricePreviewEur: z.object({
    monthly: z.number().nonnegative().optional(),
    annual: z.number().nonnegative().optional(),
  }),
  screenshots: z.array(ScreenshotSchema),
  finalUrl: z.string().url(),
  durationMs: z.number().nonnegative(),
});

/**
 * In-progress response from the content script signaling that it just
 * clicked a control that triggers a top-frame navigation (M8.T8 phase 2e).
 *
 * The content script in the OLD page cannot complete the whole flow
 * because Chrome destroys its JS context on navigation. Instead, it does
 * as much as possible WITHIN the current page, then returns this
 * response. The SW orchestrator awaits `chrome.webNavigation.onCompleted`
 * for the same tab, then sends the SAME outer command again — the new
 * page's freshly-injected content script picks up where the old one left
 * off (using `detectCurrentScreen()` to figure out where it is).
 *
 * The orchestrator accumulates `screenshots` across iterations and only
 * surfaces the final `quote.preview.ok` (or `error`) to the upstream
 * caller — so the existing `runQuote()` surface on ExtensionClient does
 * not need to change.
 */
export const QuotePreviewNavigatingResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('quote.preview.navigating'),
  /** Screen we were on when we triggered the navigation. */
  fromScreen: z.string(),
  /** What `detectCurrentScreen()` should report after the new page loads. */
  expectedScreen: z.string(),
  /** Screenshots captured during THIS advance iteration. SW concatenates. */
  screenshots: z.array(ScreenshotSchema),
});

export const QuoteConfirmResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('quote.confirm.ok'),
  devisNumber: z.string().min(3),
  pdfSentTo: z.string().email(),
  screenshots: z.array(ScreenshotSchema),
  finalUrl: z.string().url(),
  durationMs: z.number().nonnegative(),
});

/** Mirror of QuotePreviewNavigatingResponseSchema for the confirm flow. */
export const QuoteConfirmNavigatingResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('quote.confirm.navigating'),
  fromScreen: z.string(),
  expectedScreen: z.string(),
  screenshots: z.array(ScreenshotSchema),
});

/**
 * Generic error response. Caller correlates via `id`.
 * `errorCode` mirrors the tagged-error scheme the Operator agent already
 * consumes (maxance_quote_*, maxance_confirm_*, login_*, etc.) so the
 * existing QUOTE.FAILED routing keeps working unchanged.
 */
export const ErrorResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('error'),
  errorCode: z.string().min(1),
  detail: z.string().optional(),
  /** Best-effort screenshots captured before the failure point. */
  screenshots: z.array(ScreenshotSchema).optional(),
});

export const ResponseSchema = z.discriminatedUnion('kind', [
  PongResponseSchema,
  LoginEnsureResponseSchema,
  QuotePreviewResponseSchema,
  QuotePreviewNavigatingResponseSchema,
  QuoteConfirmResponseSchema,
  QuoteConfirmNavigatingResponseSchema,
  ErrorResponseSchema,
]);
export type Response = z.infer<typeof ResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Spontaneous events (extension → backend, not paired with an id)           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Hello frame sent immediately after the WS opens. Lets the backend log
 * the extension version + URL state so it knows which Chrome tab is the
 * active Maxance one (useful when the user has multiple Maxance tabs open).
 */
export const HelloEventSchema = z.object({
  kind: z.literal('hello'),
  extensionVersion: z.string(),
  /** Currently-active Maxance tab URL, or null if none open. */
  activeMaxanceUrl: z.string().url().nullable(),
  capabilities: z.array(z.string()).default([]),
});

/**
 * Progress event during a long-running flow. The extension emits one per
 * material step so the backend can stream updates to the operator UI.
 */
export const ProgressEventSchema = z.object({
  kind: z.literal('progress'),
  /** Command id this progress relates to. */
  commandId: z.string().uuid(),
  step: z.string(),
  detail: z.string().optional(),
});

export const EventSchema = z.discriminatedUnion('kind', [HelloEventSchema, ProgressEventSchema]);
export type Event = z.infer<typeof EventSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Anything-on-the-wire helper                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Parse an inbound WS frame (string) into one of the three message shapes.
 * Throws a tagged error if the JSON is malformed or doesn't match any schema.
 * Used by both sides of the wire (extension's background.ts inbox, backend's
 * extension-client.ts inbox).
 */
export function parseFrame(
  text: string,
):
  | { side: 'command'; value: Command }
  | { side: 'response'; value: Response }
  | { side: 'event'; value: Event } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('extension_wire_invalid_json');
  }
  const asCommand = CommandSchema.safeParse(raw);
  if (asCommand.success) return { side: 'command', value: asCommand.data };
  const asResponse = ResponseSchema.safeParse(raw);
  if (asResponse.success) return { side: 'response', value: asResponse.data };
  const asEvent = EventSchema.safeParse(raw);
  if (asEvent.success) return { side: 'event', value: asEvent.data };
  throw new Error('extension_wire_unrecognised_frame');
}
