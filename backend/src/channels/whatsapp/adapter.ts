/**
 * WhatsApp outbound channel adapter (M4.T2).
 *
 * Implements `ConversationChannel` on top of {@link WahaClient}. Translates
 * F16's neutral `ContentBlock[]` into individual WAHA send calls — WAHA has
 * no multi-block API, so we send one HTTP request per block and report the
 * last `id._serialized` as the `DeliveryReceipt.externalId` (mirrors
 * WhatsApp's per-message ack model).
 *
 * Out of scope here (will be wired in later M4 tasks):
 *   - inbound webhook normalization (M4.T3)
 *   - conversation_turns persistence (M4.T7)
 *   - channel switching policy (M4.T6)
 *   - WAHA session bootstrap (Ridaa runs it externally)
 */
import type {
  ChannelCapabilities,
  ContentBlock,
  ConversationChannel,
  DeliveryReceipt,
  SendOptions,
} from '../types.js';
import { WahaClient, phoneToChatId, type WahaSendResponse } from './waha-client.js';
import { logger } from '../../logger.js';

export interface WhatsAppAdapterOptions {
  client: WahaClient;
  /** Test seam — override the typing-pause sleep. Default: real setTimeout. */
  sleepMs?: (ms: number) => Promise<void>;
}

/**
 * Human-feel typing indicator (2026-07-07, Ridaa): show WhatsApp's "typing…"
 * briefly before each TEXT message. Duration scales with message length —
 * ~35 ms per character, clamped to [1s, 3.5s] so a long price menu doesn't
 * stall the pipeline. Media blocks (image/document) skip it: WhatsApp shows
 * its own upload progress for those.
 */
const TYPING_MS_PER_CHAR = 35;
const TYPING_MIN_MS = 1_000;
const TYPING_MAX_MS = 3_500;

function typingDurationMs(text: string): number {
  return Math.max(TYPING_MIN_MS, Math.min(TYPING_MAX_MS, text.length * TYPING_MS_PER_CHAR));
}

export class WhatsAppAdapter implements ConversationChannel {
  readonly id = 'whatsapp' as const;
  private client: WahaClient;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: WhatsAppAdapterOptions) {
    this.client = opts.client;
    this.sleep =
      opts.sleepMs ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  }

  capabilities(): ChannelCapabilities {
    return {
      interactive: true, // buttons / list
      voice: false, // voice handled by Pipecat in M10
      attachments: true, // image, doc, audio, video
      markdown: false, // WhatsApp uses its own *bold*/_italic_; handle in M6 prompts
    };
  }

  async send(opts: SendOptions): Promise<DeliveryReceipt> {
    if (opts.to.channel !== this.id) {
      throw new Error(`WhatsApp adapter cannot send to ${opts.to.channel} contact`);
    }
    if (opts.body.length === 0) {
      throw new Error('WhatsApp send: body must contain at least one block');
    }
    const chatId = phoneToChatId(opts.to.address);

    // WAHA has no multi-block API — send blocks sequentially. The final
    // provider response becomes the DeliveryReceipt (last message id wins,
    // matching how WhatsApp delivers/acks each message individually).
    let lastRaw: WahaSendResponse | undefined;
    for (const block of opts.body) {
      lastRaw = await this.sendBlock(chatId, block, opts.replyTo?.externalId);
    }

    // lastRaw is guaranteed defined here (body length checked above) but TS
    // can't prove it — explicit narrowing keeps strict mode happy.
    if (!lastRaw) {
      throw new Error('WhatsApp send: body must contain at least one block');
    }

    return {
      channel: 'whatsapp',
      externalId: lastRaw.id._serialized,
      acceptedAt: new Date(),
      raw: lastRaw as unknown as Record<string, unknown>,
    };
  }

  private async sendBlock(
    chatId: string,
    block: ContentBlock,
    replyTo?: string,
  ): Promise<WahaSendResponse> {
    switch (block.type) {
      case 'text':
      case 'markdown': {
        // Human feel: flash the "typing…" indicator proportionally to the
        // message length before sending. Entirely best-effort — setTyping
        // swallows its own errors, and a failed pause must never block a send.
        await this.client.setTyping(chatId, true);
        await this.sleep(typingDurationMs(block.text)).catch(() => undefined);
        const sent = await this.client.sendText({
          chatId,
          text: block.text,
          ...(replyTo ? { replyTo } : {}),
        });
        void this.client.setTyping(chatId, false);
        return sent;
      }
      case 'image':
        return this.client.sendImage({
          chatId,
          url: block.url,
          ...(block.caption ? { caption: block.caption } : {}),
        });
      case 'document': {
        // F16's `document` ContentBlock carries no caption (see channels/types.ts);
        // sendDocument's optional caption field stays unset.
        // data: URIs (local files — e.g. the devis-inbox PDF relay) are
        // decoded to WAHA's base64 `data` field; cloud WAHA can't fetch
        // anything that isn't a public URL.
        const dataUri = /^data:([^;,]+);base64,(.+)$/.exec(block.url);
        if (dataUri?.[1] && dataUri[2]) {
          return this.client.sendDocument({
            chatId,
            data: dataUri[2],
            mimetype: dataUri[1],
            filename: block.filename,
          });
        }
        return this.client.sendDocument({
          chatId,
          url: block.url,
          filename: block.filename,
        });
      }
      case 'audio':
      case 'video':
        // WAHA supports these via sendFile; use a generic filename hint.
        return this.client.sendDocument({
          chatId,
          url: block.url,
          filename: `media.${block.type}`,
        });
      case 'location':
        // No location helper on the client yet — degrade to a text+maps link
        // so the message still lands. Block reference is logged but not the
        // recipient (PII protection: chatId stays out of logs at info level).
        logger.warn(
          { blockType: block.type },
          'whatsapp: location block not implemented; degrading to text',
        );
        return this.client.sendText({
          chatId,
          text: `📍 ${block.name ?? ''} https://maps.google.com/?q=${block.lat},${block.lng}`,
        });
      case 'interactive':
        return this.client.sendInteractive({ chatId, spec: block.spec });
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      const s = await this.client.getSessionStatus();
      return { healthy: s.status === 'WORKING', detail: s.status };
    } catch (err) {
      return { healthy: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
