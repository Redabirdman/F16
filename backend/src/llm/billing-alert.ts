/**
 * LLM billing/credits failure alert (2026-07-07).
 *
 * When the Anthropic account runs out of credits, EVERY LLM call fails and the
 * whole sales brain goes silent — customers get no replies and nothing told
 * management (live: Achraf asked two questions into a dead agent before Ridaa
 * noticed). This module posts a direct WhatsApp alert to the management group
 * the moment a billing-class error is seen.
 *
 * Design constraints:
 *   - MUST NOT depend on the LLM (it's down) → plain templated English text.
 *   - MUST NOT depend on the DB/dispatcher (keep the failure path shallow) →
 *     talks straight to WAHA via env config.
 *   - Throttled to one alert per hour per process (a burst of failing calls
 *     must not spam the group; a backend restart re-alerting is a feature).
 */
import { WahaClient } from '../channels/whatsapp/waha-client.js';
import { logger } from '../logger.js';

const THROTTLE_MS = 60 * 60_000; // 1 hour
let lastAlertAt = 0;

/** Billing/credits/auth error shapes worth waking management for. */
const BILLING_ERROR =
  /credit balance is too low|purchase credits|billing|invalid x-api-key|authentication_error/i;

export function isLlmBillingError(errMsg: string): boolean {
  return BILLING_ERROR.test(errMsg);
}

/**
 * Fire-and-forget: post the SYSTEM DOWN alert to the management WhatsApp group
 * when `errMsg` is a billing-class failure. Never throws.
 */
export function maybeAlertLlmBillingError(errMsg: string): void {
  if (!isLlmBillingError(errMsg)) return;
  const now = Date.now();
  if (now - lastAlertAt < THROTTLE_MS) return;
  lastAlertAt = now;

  const chatId = process.env.HUMAN_ACTION_GROUP_CHAT_ID;
  const baseUrl = process.env.WAHA_BASE_URL;
  if (!chatId || !baseUrl) {
    logger.error(
      { hasChatId: Boolean(chatId), hasBaseUrl: Boolean(baseUrl) },
      'llm-billing-alert: cannot notify management — WAHA env missing',
    );
    return;
  }

  const text =
    '🔴 SYSTEM DOWN — the AI brain cannot run.\n\n' +
    'The Anthropic API rejected our calls (credits exhausted or key problem). ' +
    'The sales agent CANNOT reply to any customer until this is fixed.\n\n' +
    'Fix: console.anthropic.com → Plans & Billing → add credits (enable auto-reload).\n\n' +
    `Error: ${errMsg.slice(0, 180)}\n\n` +
    'This alert repeats at most once per hour while the failure continues.';

  const client = new WahaClient({
    baseUrl,
    ...(process.env.WAHA_API_KEY ? { apiKey: process.env.WAHA_API_KEY } : {}),
    ...(process.env.WAHA_SESSION ? { session: process.env.WAHA_SESSION } : {}),
  });
  void client
    .sendText({ chatId, text })
    .then(() => logger.warn('llm-billing-alert: SYSTEM DOWN alert posted to management group'))
    .catch((err: unknown) =>
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'llm-billing-alert: failed to post the alert',
      ),
    );
}
