/**
 * BillionMail email channel adapter (M4.T4).
 *
 * Implements `ConversationChannel` for email on top of an SMTP transport
 * (nodemailer in production; a stub in tests). The adapter combines all
 * `ContentBlock`s in `SendOptions.body` into ONE email — subject derived
 * from the first text/markdown block, body rendered as both `text` and
 * `html` parts, and media blocks (image/audio/video/document) attached as
 * nodemailer attachments.
 *
 * Out of scope here:
 *   - inbound email parsing — deferred to V2 (most replies come on WhatsApp)
 *   - DKIM signing — BillionMail handles this at the server level
 *   - marketing template rendering — M11 follow-up cascades
 *   - conversation_turns persistence — M4.T7
 *
 * PII discipline (§9): the adapter NEVER logs the recipient address,
 * subject, or body. Errors surfaced to callers are scrubbed in `smtp-client`.
 */
import type {
  ChannelCapabilities,
  ContentBlock,
  ConversationChannel,
  DeliveryReceipt,
  SendOptions,
} from '../types.js';
import type { Attachment } from 'nodemailer/lib/mailer/index.js';
import { renderMarkdownToHtml, stripMarkdownToText } from './markdown.js';
import { sendEmail, type EmailTransportLike, type SendEmailInput } from './smtp-client.js';

const SUBJECT_MAX_LEN = 80;
const SUBJECT_FALLBACK = 'Message from Assuryal';

export interface EmailAdapterOptions {
  transport: EmailTransportLike;
  /** Friendly display name for the From header, e.g. "Assuryal". */
  fromName: string;
  /** Bare RFC-5322 address, e.g. "noreply@assuryalconseil.fr". */
  fromAddress: string;
}

export class EmailAdapter implements ConversationChannel {
  readonly id = 'email' as const;
  private readonly transport: EmailTransportLike;
  private readonly fromName: string;
  private readonly fromAddress: string;

  constructor(opts: EmailAdapterOptions) {
    this.transport = opts.transport;
    this.fromName = opts.fromName;
    this.fromAddress = opts.fromAddress;
  }

  capabilities(): ChannelCapabilities {
    return {
      interactive: false, // email has no native buttons; rendered as links if used
      voice: false,
      attachments: true,
      markdown: true,
    };
  }

  async send(opts: SendOptions): Promise<DeliveryReceipt> {
    if (opts.to.channel !== this.id) {
      throw new Error(`Email adapter cannot send to ${opts.to.channel} contact`);
    }
    if (opts.body.length === 0) {
      throw new Error('Email send: body must contain at least one block');
    }

    const subject = deriveSubject(opts.body);
    const text = buildPlainText(opts.body);
    const html = buildHtml(opts.body);
    const attachments = buildAttachments(opts.body);

    const input: SendEmailInput = {
      from: `${this.fromName} <${this.fromAddress}>`,
      to: opts.to.address,
      subject,
      text,
      html,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(opts.replyTo?.externalId ? { inReplyTo: opts.replyTo.externalId } : {}),
    };

    const result = await sendEmail(this.transport, input);

    return {
      channel: 'email',
      externalId: result.messageId,
      acceptedAt: new Date(),
      raw: {
        accepted: result.accepted,
        rejected: result.rejected,
        response: result.response,
      },
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      await this.transport.verify();
      return { healthy: true };
    } catch (err) {
      return { healthy: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

// -----------------------------------------------------------------------------
// Subject derivation
// -----------------------------------------------------------------------------

function deriveSubject(body: readonly ContentBlock[]): string {
  // First text or markdown block becomes the subject (with markdown stripped).
  for (const b of body) {
    if (b.type === 'text') {
      return truncateSubject(b.text);
    }
    if (b.type === 'markdown') {
      return truncateSubject(stripMarkdownToText(b.text));
    }
  }
  return SUBJECT_FALLBACK;
}

function truncateSubject(raw: string): string {
  // Collapse whitespace so a multi-line first paragraph gives a sane subject.
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return SUBJECT_FALLBACK;
  if (clean.length <= SUBJECT_MAX_LEN) return clean;
  // Use ellipsis (single char) per the spec — keeps the header short.
  return `${clean.slice(0, SUBJECT_MAX_LEN)}…`;
}

// -----------------------------------------------------------------------------
// Plain-text rendering
// -----------------------------------------------------------------------------

function buildPlainText(body: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of body) {
    switch (b.type) {
      case 'text':
        parts.push(b.text);
        break;
      case 'markdown':
        parts.push(stripMarkdownToText(b.text));
        break;
      case 'image':
        parts.push(`[image] ${b.caption ?? ''} ${b.url}`.trim());
        break;
      case 'audio':
        parts.push(`[audio] ${b.caption ?? ''} ${b.url}`.trim());
        break;
      case 'video':
        parts.push(`[video] ${b.caption ?? ''} ${b.url}`.trim());
        break;
      case 'document':
        parts.push(`[document: ${b.filename}] ${b.url}`);
        break;
      case 'location':
        parts.push(
          `[location] ${b.name ?? ''} https://maps.google.com/?q=${b.lat},${b.lng}`.trim(),
        );
        break;
      case 'interactive':
        // Email has no native buttons; degrade silently (the html part may
        // render a textual hint if/when we extend the renderer).
        break;
    }
  }
  return parts.join('\n\n');
}

// -----------------------------------------------------------------------------
// HTML rendering
// -----------------------------------------------------------------------------

function buildHtml(body: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of body) {
    switch (b.type) {
      case 'text':
        parts.push(`<p>${escapeHtml(b.text)}</p>`);
        break;
      case 'markdown':
        parts.push(renderMarkdownToHtml(b.text));
        break;
      case 'image': {
        const alt = escapeHtml(b.caption ?? '');
        parts.push(
          `<p><img src="${escapeAttr(b.url)}" alt="${alt}" style="max-width:100%;height:auto;"/></p>`,
        );
        if (b.caption) parts.push(`<p>${escapeHtml(b.caption)}</p>`);
        break;
      }
      case 'audio':
      case 'video':
        // Email clients don't reliably render <audio>/<video> — surface as a
        // labeled link instead.
        parts.push(
          `<p><a href="${escapeAttr(b.url)}">${b.type === 'audio' ? 'Audio' : 'Video'}</a>${
            b.caption ? ` — ${escapeHtml(b.caption)}` : ''
          }</p>`,
        );
        break;
      case 'document':
        parts.push(`<p><a href="${escapeAttr(b.url)}">${escapeHtml(b.filename)}</a></p>`);
        break;
      case 'location':
        parts.push(
          `<p><a href="https://maps.google.com/?q=${b.lat},${b.lng}">${escapeHtml(
            b.name ?? `${b.lat},${b.lng}`,
          )}</a></p>`,
        );
        break;
      case 'interactive':
        // No HTML render for opaque interactive specs.
        break;
    }
  }
  return parts.join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// -----------------------------------------------------------------------------
// Attachments
// -----------------------------------------------------------------------------

function buildAttachments(body: readonly ContentBlock[]): Attachment[] {
  const out: Attachment[] = [];
  for (const b of body) {
    switch (b.type) {
      case 'image':
        // Nodemailer fetches http(s) URLs itself when `path` is set — this
        // avoids streaming the asset through Node memory.
        out.push({ path: b.url, filename: filenameFromUrl(b.url, 'image') });
        break;
      case 'audio':
        out.push({ path: b.url, filename: filenameFromUrl(b.url, 'audio') });
        break;
      case 'video':
        out.push({ path: b.url, filename: filenameFromUrl(b.url, 'video') });
        break;
      case 'document':
        out.push({
          path: b.url,
          filename: b.filename,
          contentType: b.mimeType,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

function filenameFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ?? fallback;
  } catch {
    return fallback;
  }
}
