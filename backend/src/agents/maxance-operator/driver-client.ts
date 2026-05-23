/**
 * Shared interface for the two Maxance driver clients (M8.T8 phase 2c).
 *
 * Both `StagehandClient` (legacy, dead in prod) and `ExtensionClient`
 * (V1 production) expose the same method surface so MaxanceOperatorAgent
 * doesn't need to know which one is wired. The factory below reads
 * MAXANCE_DRIVER and returns the right instance.
 */
import { logger } from '../../logger.js';
import {
  StagehandClient,
  StagehandClientError,
  getDefaultStagehandClient,
  type LoginResult,
  type QuotePreviewResult,
  type ConfirmQuoteResult,
  type StagehandQuoteParams,
  type StagehandSubscriberInfo,
} from './stagehand-client.js';
import {
  ExtensionClient,
  ExtensionClientError,
  getDefaultExtensionClient,
} from './extension-client.js';

/** Common surface. Both Stagehand + Extension clients satisfy this. */
export interface MaxanceDriverClient {
  ensureLoggedIn(sessionName?: string): Promise<LoginResult>;
  runQuote(
    sessionName: string,
    params: StagehandQuoteParams,
    opts?: { dryRun?: boolean; timeoutMs?: number },
  ): Promise<QuotePreviewResult>;
  confirmQuote(
    sessionName: string,
    subscriber: StagehandSubscriberInfo,
    opts?: { dryRun?: boolean; timeoutMs?: number },
  ): Promise<ConfirmQuoteResult>;
}

/** Read the per-error tag from either client's typed error. */
export function readErrorCode(err: unknown): string | null {
  if (err instanceof StagehandClientError) return err.errorCode;
  if (err instanceof ExtensionClientError) return err.errorCode;
  return null;
}

/**
 * Build the driver client matching MAXANCE_DRIVER. Starts the WS server
 * on first call when the driver is `chrome_extension`. Idempotent —
 * subsequent calls return the same singleton.
 */
let cached: { driver: string; client: MaxanceDriverClient } | null = null;

export async function getDefaultMaxanceDriverClient(
  driver: 'chrome_extension' | 'stagehand_legacy_DO_NOT_USE_IN_PROD',
): Promise<MaxanceDriverClient> {
  if (cached && cached.driver === driver) return cached.client;

  if (driver === 'chrome_extension') {
    const ext = getDefaultExtensionClient();
    await ext.start();
    logger.info('maxance-driver: using chrome_extension client (V1 prod)');
    cached = { driver, client: ext };
    return ext;
  }

  // Legacy Stagehand path — broken on prod, kept for non-Cloudflare staging.
  const sh = getDefaultStagehandClient();
  logger.warn(
    'maxance-driver: using stagehand_legacy client — CLOUDFLARE WILL BLOCK ON PROD MAXANCE',
  );
  cached = { driver, client: sh };
  return sh;
}

// Re-export for callers that want the explicit types.
export { StagehandClient, ExtensionClient };
