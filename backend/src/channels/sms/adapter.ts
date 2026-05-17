/**
 * SMS outbound channel adapter (M4.T5).
 *
 * Implements `ConversationChannel` on top of {@link SmsGatewayClient} (which
 * talks to a self-hosted android-sms-gateway server). SMS is the V1
 * last-resort fallback — only used when WhatsApp, voice, and email have all
 * failed (§8.1 / M4.T6) — so this adapter optimizes for "send *something*
 * over the wire" rather than full fidelity:
 *
 *   - text + markdown blocks → concatenated into a single message, with
 *     markdown stripped to plain text
 *   - image / audio / video / document blocks → degraded into inline
 *     placeholders (`[image: <caption-or-url>]`, `[file: <filename>]`) so
 *     the recipient at least knows something was attached
 *   - location → degraded to a maps link
 *   - interactive → silently dropped (SMS has no interactive)
 *
 * Length: SMS carriers fragment messages > 160 GSM-7 chars (or 70 UCS-2).
 * The gateway and carrier do the fragmentation transparently, so we don't
 * truncate — we just log a warning so operators can spot multi-segment bills.
 *
 * Out of scope here (deferred):
 *   - inbound SMS receiver — V1 doesn't consume SMS replies
 *   - delivery status polling — getMessageStatus exists on the client but
 *     no worker polls it yet
 *   - carrier-specific routing — single gateway / single SIM for V1
 *
 * PII discipline (§9): NEVER log the phone number or message body. Errors
 * surfaced to callers come from the client and only contain HTTP status +
 * short response prefix.
 */
import type {
  ChannelCapabilities,
  ContentBlock,
  ConversationChannel,
  DeliveryReceipt,
  SendOptions,
} from '../types.js';
import { SmsGatewayClient } from './gateway-client.js';
import { logger } from '../../logger.js';

/** Single-segment SMS in GSM-7. Multi-segment still goes through; we just warn. */
const SMS_SINGLE_SEGMENT_LEN = 160;

export interface SmsAdapterOptions {
  client: SmsGatewayClient;
}

export class SmsAdapter implements ConversationChannel {
  readonly id = 'sms' as const;
  private readonly client: SmsGatewayClient;

  constructor(opts: SmsAdapterOptions) {
    this.client = opts.client;
  }

  capabilities(): ChannelCapabilities {
    return {
      interactive: false,
      voice: false,
      attachments: false,
      markdown: false,
    };
  }

  async send(opts: SendOptions): Promise<DeliveryReceipt> {
    if (opts.to.channel !== this.id) {
      throw new Error(`SMS adapter cannot send to ${opts.to.channel} contact`);
    }

    const composed = composeBody(opts.body).trim();
    if (composed.length === 0) {
      throw new Error('SMS body is empty');
    }

    if (composed.length > SMS_SINGLE_SEGMENT_LEN) {
      // Don't include the text itself — PII discipline. Log only the length so
      // operators can correlate with multi-segment carrier bills.
      logger.warn(
        { length: composed.length, limit: SMS_SINGLE_SEGMENT_LEN },
        'sms: message exceeds single-segment length; carrier will fragment',
      );
    }

    const result = await this.client.sendMessage({
      phoneNumber: opts.to.address,
      message: composed,
    });

    return {
      channel: 'sms',
      externalId: result.id,
      acceptedAt: new Date(),
      raw: { state: result.state },
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    return this.client.healthCheck();
  }
}

// -----------------------------------------------------------------------------
// Body composition
// -----------------------------------------------------------------------------

/**
 * Fold the heterogeneous ContentBlock list into one plain-text SMS body.
 * Markdown is stripped; media blocks degrade to short bracketed markers so
 * the recipient knows the agent intended an attachment.
 *
 * Blocks are joined by single newlines — SMS doesn't care about paragraphing
 * but a newline keeps "[image: x]" markers visually separable from the
 * surrounding prose.
 */
function composeBody(body: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of body) {
    const piece = renderBlock(b);
    if (piece) parts.push(piece);
  }
  return parts.join('\n');
}

function renderBlock(b: ContentBlock): string {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'markdown':
      return stripMarkdown(b.text);
    case 'image':
      return `[image: ${b.caption ?? b.url}]`;
    case 'audio':
      return `[audio: ${b.caption ?? b.url}]`;
    case 'video':
      return `[video: ${b.caption ?? b.url}]`;
    case 'document':
      return `[file: ${b.filename}]`;
    case 'location':
      return `[location: ${b.name ?? ''} https://maps.google.com/?q=${b.lat},${b.lng}]`.replace(
        /\s+/g,
        ' ',
      );
    case 'interactive':
      // No SMS analogue — drop silently. The channel-switching policy
      // (M4.T6) shouldn't be sending interactive blocks to SMS in the first
      // place; if it does, we'd rather drop them than throw and lose the
      // text portion of the conversation.
      return '';
  }
}

/**
 * Cheap markdown → plain-text stripper. Mirrors `email/markdown.ts`'s helper
 * but kept local so the SMS adapter doesn't pull in the `marked` parser for
 * a stripping pass it doesn't need.
 */
function stripMarkdown(src: string): string {
  return (
    src
      // Links: [text](url) → text (url)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      // Images: ![alt](url) → alt (url)
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
      // Bold **x** / __x__
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      // Italic *x* / _x_
      .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1$2')
      .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')
      // Inline code `x`
      .replace(/`([^`]+)`/g, '$1')
      // Leading heading hashes
      .replace(/^#{1,6}\s+/gm, '')
      // Leading bullet markers
      .replace(/^\s*[-*+]\s+/gm, '- ')
      // Leading ordered list markers
      .replace(/^\s*\d+\.\s+/gm, '')
      .trim()
  );
}
