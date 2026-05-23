/**
 * Class registration for the Reporter Agent (option G).
 *
 * Idempotent — first call wins, subsequent calls no-op. Matches the
 * Sales Agent + Maxance Operator pattern.
 *
 * Env requirements (V1):
 *   WAHA_BASE_URL           — WAHA REST endpoint (e.g. http://127.0.0.1:3000)
 *   WAHA_API_KEY            — optional WAHA admin key
 *   WAHA_SESSION            — session name on the WAHA instance (default 'default')
 *   HUMAN_ACTION_GROUP_CHAT_ID — WhatsApp group chat id, e.g. '120363012345@g.us'
 *
 * The factory throws at spawn time when HUMAN_ACTION_GROUP_CHAT_ID is
 * unset — the alternative is a silent prod where escalations never reach
 * Ridaa/Achraf, which is worse than a noisy boot failure.
 */
import { registerAgentClass } from '../registry.js';
import { ReporterAgent } from './agent.js';
import { WahaClient } from '../../channels/whatsapp/waha-client.js';
import { QUEUE_NAMES } from '../../queue/queues.js';

let _registered = false;

export function registerReporterAgentClass(): void {
  if (_registered) return;
  _registered = true;
  registerAgentClass('human-router', (cfg) => {
    const baseUrl = process.env.WAHA_BASE_URL;
    const groupChatId = process.env.HUMAN_ACTION_GROUP_CHAT_ID;
    if (!baseUrl) {
      throw new Error('reporter-agent: WAHA_BASE_URL is required');
    }
    if (!groupChatId) {
      throw new Error(
        'reporter-agent: HUMAN_ACTION_GROUP_CHAT_ID is required (WhatsApp group chat id, ' +
          'e.g. 120363012345@g.us). Without it, human-actions only reach the admin UI ' +
          'and Ridaa/Achraf miss out-of-app escalations.',
      );
    }
    const wahaOptions: ConstructorParameters<typeof WahaClient>[0] = { baseUrl };
    if (process.env.WAHA_API_KEY) wahaOptions.apiKey = process.env.WAHA_API_KEY;
    if (process.env.WAHA_SESSION) wahaOptions.session = process.env.WAHA_SESSION;
    const waha = new WahaClient(wahaOptions);
    return new ReporterAgent(
      {
        role: 'human-router',
        instanceId: cfg.instanceId,
        model: 'haiku',
        // Single queue: human-action events both directions (REQUESTED + RESOLVED).
        queues: [QUEUE_NAMES.HUMAN_ACTION],
        // Concurrency 1 — one group thread, no need to parallelise; keeps message
        // ordering deterministic which matters for the closure-after-request flow.
        concurrency: 1,
        db: cfg.db,
        ...(cfg.meta ? { meta: cfg.meta } : {}),
      },
      { waha, groupChatId },
    );
  });
}

/** Test-only: clear the local registration guard. */
export function __resetReporterAgentRegistrationForTests(): void {
  _registered = false;
}
