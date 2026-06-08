/**
 * Reporter Agent — broadcasts HUMAN_ACTION events to the WhatsApp group
 * thread shared by Ridaa + Achraf (option G).
 *
 * Per `memory/project_human_action_channel.md` (2026-05-16 lock):
 * every human-action must reach Ridaa or Achraf in TWO places — the
 * admin UI AND the WhatsApp group — because they're often away from
 * the laptop. The admin UI side is already wired (realtime/notify.ts
 * fans the human_actions trigger out over a WebSocket). This agent
 * closes the WhatsApp side.
 *
 * Consumes the `human_action` queue. Two intents handled:
 *
 *   - HUMAN_ACTION.REQUESTED → load the row, format a French message
 *     with severity glyph + summary + numbered options + action ID,
 *     post to the group chat via WAHA sendText.
 *
 *   - HUMAN_ACTION.RESOLVED → post a closure confirmation in the same
 *     group ("✅ Action XXX clôturée via admin — choix : approve").
 *     Always posted, even if resolved via admin UI — keeps the group
 *     thread in sync.
 *
 * Single instance (concurrency=1, instanceId='singleton'): one logical
 * group thread, no need for sharding. The BullMQ queue serialises
 * messages so they arrive in the order they were enqueued.
 *
 * Failure modes:
 *   - WAHA unreachable / 5xx → log + return {ok:false, error}. The
 *     row stays in `pending`; the admin UI side already has it; a
 *     human can resolve there. BullMQ's retry policy may re-attempt.
 *   - human_actions row missing (rare — INSERT NOTIFY is supposed to
 *     happen before the dispatcher message, but race possible) →
 *     return {ok:false, error:'row_not_found'} so the dispatcher
 *     surfaces the inconsistency in logs.
 *   - groupChatId not configured → onStart throws so the operator
 *     sees the misconfig at boot, not at first event.
 *
 * Out of scope for option G (deferred to a follow-up):
 *   - Inbound parsing: when Ridaa/Achraf reply "1" in the group, the
 *     WAHA webhook must parse it + map to the open action's option +
 *     call resolveAction. Requires routing logic in the WhatsApp
 *     webhook handler (channels/whatsapp/webhook.ts).
 *   - Idempotency / cross-surface notification: if the admin resolves
 *     first, we still post the closure in WA — but we don't currently
 *     edit the original request message. WAHA doesn't expose message
 *     edits on individual messages by default; we accept the closure
 *     message as the "thread is now done" signal.
 */
import { readFile } from 'node:fs/promises';
import { BaseAgent } from '../base.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';
import { getActionById } from '../../db/repositories/human-actions.js';
import { getCampaignTree } from '../../db/repositories/ads.js';
import type { WahaClient } from '../../channels/whatsapp/waha-client.js';
import { formatHumanActionRequest, formatHumanActionResolved } from './format.js';

/**
 * Construction dependencies. Both are injected so tests can swap a stub
 * WahaClient + a fake group chat id without touching env or the registry.
 */
export interface ReporterAgentDeps {
  waha: WahaClient;
  /** WAHA group chat id, e.g. "120363012345678901@g.us". */
  groupChatId: string;
}

export class ReporterAgent extends BaseAgent {
  private readonly waha: WahaClient;
  private readonly groupChatId: string;

  constructor(cfg: ConstructorParameters<typeof BaseAgent>[0], deps: ReporterAgentDeps) {
    super(cfg);
    this.waha = deps.waha;
    this.groupChatId = deps.groupChatId;
  }

  protected async onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    try {
      switch (envelope.intent) {
        case 'HUMAN_ACTION.REQUESTED':
          return await this.handleHumanActionRequested(envelope);
        case 'HUMAN_ACTION.RESOLVED':
          return await this.handleHumanActionResolved(envelope);
        default:
          logger.debug(
            { intent: envelope.intent, instanceId: this.instanceId },
            'reporter-agent: ignoring unhandled intent',
          );
          return { ok: true, result: { skipped: 'unhandled-intent', intent: envelope.intent } };
      }
    } catch (err) {
      logger.error(
        { err, intent: envelope.intent, instanceId: this.instanceId },
        'reporter-agent: onMessage threw',
      );
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send the request to the WA group. The payload only carries
   * (humanActionId, severity, summary) — to render the full options
   * block we re-load the row from DB. Cheaper than enlarging the payload
   * + keeps the formatter as the single source of truth on layout.
   */
  private async handleHumanActionRequested(
    envelope: AgentMessageEnvelope,
  ): Promise<MessageHandlerResult> {
    const payload = envelope.payload as { humanActionId: string };
    const action = await getActionById(this.db, payload.humanActionId);
    if (!action) {
      logger.warn(
        { humanActionId: payload.humanActionId },
        'reporter-agent: action row not found (race with delete?)',
      );
      return { ok: false, error: 'row_not_found' };
    }
    const text = formatHumanActionRequest(action);
    await this.waha.sendText({ chatId: this.groupChatId, text });

    // M12: a campaign draft also ships its creative images so Ridaa can judge
    // the visuals before approving. Best-effort — a failed image send must not
    // fail the (already-sent) text request.
    if (action.intent === 'CAMPAIGN_DRAFT' && action.correlationId) {
      await this.sendDraftCreatives(action.correlationId).catch((err) => {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            campaignId: action.correlationId,
          },
          'reporter-agent: failed to send draft creatives',
        );
      });
    }

    logger.info(
      {
        humanActionId: action.id,
        severity: action.severity,
        intent: action.intent,
      },
      'reporter-agent: posted human-action request to WA group',
    );
    return { ok: true, result: { posted: true, humanActionId: action.id } };
  }

  /**
   * Send each distinct creative image of a draft campaign as a WhatsApp image
   * (base64 — the cloud WAHA can't fetch our local files). Captions the angle +
   * headline so Ridaa sees which is which.
   */
  private async sendDraftCreatives(campaignId: string): Promise<void> {
    const tree = await getCampaignTree(this.db, campaignId);
    if (!tree) return;
    const seen = new Set<string>();
    for (const adset of tree.adsets) {
      for (const ad of adset.ads) {
        const c = ad.creative;
        if (!c || seen.has(c.id)) continue;
        seen.add(c.id);
        try {
          const bytes = await readFile(c.fileUrl);
          await this.waha.sendImage({
            chatId: this.groupChatId,
            data: bytes.toString('base64'),
            mimetype: 'image/png',
            filename: `${c.angle}.png`,
            caption: `🅰️ Angle « ${c.angle} » — ${c.headline ?? ''}`,
          });
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), creativeId: c.id },
            'reporter-agent: creative image send failed',
          );
        }
      }
    }
  }

  /**
   * Post the closure message. We always post, regardless of resolution
   * source, so the group thread reflects "this action is done."
   */
  private async handleHumanActionResolved(
    envelope: AgentMessageEnvelope,
  ): Promise<MessageHandlerResult> {
    const payload = envelope.payload as {
      humanActionId: string;
      choice: string;
      source: 'admin' | 'whatsapp';
    };
    const text = formatHumanActionResolved(payload);
    await this.waha.sendText({ chatId: this.groupChatId, text });
    logger.info(
      {
        humanActionId: payload.humanActionId,
        source: payload.source,
        choice: payload.choice,
      },
      'reporter-agent: posted human-action closure to WA group',
    );
    return { ok: true, result: { posted: true, humanActionId: payload.humanActionId } };
  }
}
