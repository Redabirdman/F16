/**
 * Unified send wrapper (design §8 / M4.T7).
 *
 * `sendViaChannel` is the ONLY way the app sends outbound traffic. It owns
 * two responsibilities so callers (agents, tools, the admin "reply" panel)
 * don't have to coordinate them:
 *
 *   1. Resolve the channel adapter from the registry and call `send()`.
 *   2. Write a matching `conversation_turns` row so the admin timeline
 *      reflects every outbound message — same audit shape as inbound rows
 *      written by the WAHA webhook.
 *
 * Why a wrapper (and not DB writes baked into each adapter):
 *   - Adapters stay focused on their provider (WAHA / BillionMail / SMS
 *     gateway) and remain unit-testable without a DB.
 *   - The audit shape is identical regardless of channel — derived from
 *     `ContentBlock` rather than channel-specific payloads.
 *   - Future channels (voice/M10) plug in by implementing the channel
 *     interface; nothing else changes here.
 *
 * Order of operations is "send first, log second" on purpose:
 *   - If `channel.send()` throws, we do NOT write a row. Auditing a
 *     phantom send would be worse than no row — the customer never
 *     received the message.
 *   - If the DB write fails AFTER a successful send, we log the receipt
 *     loudly and re-throw. The customer DID get the message; silently
 *     swallowing the error would lose the audit trail.
 */
import type { Database } from '../db/index.js';
import { getChannel } from './registry.js';
import type { ContentBlock, DeliveryReceipt, MessageRef, ContactRef } from './types.js';
import { insertTurn } from '../db/repositories/conversation-turns.js';
import { logger } from '../logger.js';

export interface SendViaChannelInput {
  db: Database;
  customerId: string;
  /** Optional — conversation turns predate leads (returning customer pings before a lead row exists). */
  leadId?: string | null;
  to: ContactRef;
  body: readonly ContentBlock[];
  replyTo?: MessageRef;
  /** Outbound attribution written into `conversation_turns`. */
  agentRole?: string;
  agentInstance?: string;
  /** Optional correlation id propagated to the channel adapter for tracing. */
  correlationId?: string;
  /** Email-only presentation hints (subject/preheader/CTA) — see SendOptions.email. */
  email?: { subject?: string; preheader?: string; cta?: { label: string; url: string } };
}

export interface SendViaChannelResult {
  receipt: DeliveryReceipt;
  /** `conversation_turns.id` of the row written for this send. */
  turnId: string;
}

/**
 * Send a message via the configured channel adapter AND log a matching
 * `conversation_turns` row. Throws if either side fails (see header comment
 * for the exact contract — channel-failure short-circuits before any write,
 * DB-failure-after-send re-throws so callers know the audit didn't land).
 */
export async function sendViaChannel(input: SendViaChannelInput): Promise<SendViaChannelResult> {
  const channel = getChannel(input.to.channel);

  // Pass through the optional SendOptions fields exactly as supplied. We
  // spread conditionally so we don't introduce `undefined` properties (some
  // adapters distinguish "missing" from "explicitly undefined").
  const receipt = await channel.send({
    to: input.to,
    body: input.body,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.agentRole ? { agentRole: input.agentRole } : {}),
    ...(input.agentInstance ? { agentInstance: input.agentInstance } : {}),
    ...(input.email ? { email: input.email } : {}),
  });

  // Channel send succeeded — derive the audit shape from the body. We map
  // each ContentBlock to a human-readable line for `content` and pull the
  // URL-bearing blocks into `attachments`.
  const content = deriveContent(input.body);
  const attachments = deriveAttachments(input.body);

  try {
    const turn = await insertTurn(input.db, {
      customerId: input.customerId,
      leadId: input.leadId ?? null,
      channel: input.to.channel,
      direction: 'outbound',
      agentRole: input.agentRole ?? null,
      agentInstance: input.agentInstance ?? null,
      content,
      ...(attachments.length ? { attachments } : {}),
    });
    return { receipt, turnId: turn.id };
  } catch (err) {
    // The customer DID receive the message — we just couldn't audit it.
    // Re-throw so callers retry/page rather than silently dropping the row.
    logger.error(
      { err, externalId: receipt.externalId, channel: input.to.channel },
      'sendViaChannel: channel send succeeded but conversation_turns insert failed',
    );
    throw err;
  }
}

/**
 * Render a body of ContentBlocks into a single human-readable string for the
 * admin timeline. Text/markdown blocks are concatenated as-is; media and
 * interactive blocks degrade to a bracketed placeholder so the row still
 * reads sensibly without the original payload.
 */
function deriveContent(body: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of body) {
    switch (b.type) {
      case 'text':
      case 'markdown':
        parts.push(b.text);
        break;
      case 'image':
        parts.push(b.caption ? `[image: ${b.caption}]` : '[image]');
        break;
      case 'audio':
        parts.push(b.caption ? `[audio: ${b.caption}]` : '[audio]');
        break;
      case 'video':
        parts.push(b.caption ? `[video: ${b.caption}]` : '[video]');
        break;
      case 'document':
        parts.push(`[document: ${b.filename}]`);
        break;
      case 'location':
        parts.push(`[location: ${b.name ?? `${b.lat},${b.lng}`}]`);
        break;
      case 'interactive':
        parts.push('[interactive]');
        break;
    }
  }
  return parts.join('\n').trim();
}

/**
 * Pull URL-bearing blocks out of the body into the `attachments` JSONB
 * column shape: `{ url, type, size?, sha256? }`. The `type` field uses the
 * ContentBlock kind (image/audio/video/document) — matches what the inbound
 * webhook writes for symmetry.
 */
function deriveAttachments(
  body: readonly ContentBlock[],
): Array<{ url: string; type: string; size?: number; sha256?: string }> {
  return body.flatMap((b) => {
    if (b.type === 'image') {
      return [{ url: auditUrl(b.url), type: 'image', ...(b.sha256 ? { sha256: b.sha256 } : {}) }];
    }
    if (b.type === 'audio') {
      return [{ url: auditUrl(b.url), type: 'audio' }];
    }
    if (b.type === 'video') {
      return [{ url: auditUrl(b.url), type: 'video' }];
    }
    if (b.type === 'document') {
      return [
        {
          url: auditUrl(b.url, b.filename),
          type: 'document',
          ...(b.sha256 ? { sha256: b.sha256 } : {}),
        },
      ];
    }
    return [];
  });
}

/**
 * Audit-safe URL for the attachments JSONB. A devis PDF rides the send as a
 * multi-MB base64 `data:` URI — persisting that verbatim bloats every
 * conversation_turns row (~1.35× the PDF, twice per devis) and drags the
 * admin timeline payloads. Store a compact reference instead; the real file
 * lives on disk (var/devis/<DR>.pdf) and in the recipient's mailbox/chat.
 */
function auditUrl(url: string, filename?: string): string {
  if (!url.startsWith('data:')) return url;
  const mime = url.slice(5, url.indexOf(';') > 0 ? url.indexOf(';') : 5 + 30).split(',')[0];
  return `inline:${filename ?? mime ?? 'attachment'}`;
}
