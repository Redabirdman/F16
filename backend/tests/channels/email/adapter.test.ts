/**
 * BillionMail email adapter tests (M4.T4).
 *
 * Strategy: inject a `StubTransport` that conforms to `EmailTransportLike` so
 * we never touch a real SMTP server. Each `sendMail` call is recorded, then
 * asserted against — subject derivation, html/text rendering, attachments,
 * replyTo header, channel guardrails, healthCheck, and PII discipline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SendMailOptions, SentMessageInfo } from 'nodemailer';
import { EmailAdapter } from '../../../src/channels/email/adapter.js';
import type { EmailTransportLike } from '../../../src/channels/email/smtp-client.js';
import type { ContentBlock } from '../../../src/channels/types.js';

interface SentRecord {
  from: SendMailOptions['from'];
  to: SendMailOptions['to'];
  subject: string;
  text: string;
  html: string;
  attachments: SendMailOptions['attachments'];
  replyTo: SendMailOptions['replyTo'];
  inReplyTo: SendMailOptions['inReplyTo'];
  messageId: string;
}

class StubTransport implements EmailTransportLike {
  sent: SentRecord[] = [];
  verifyImpl: () => Promise<true> = async () => true;
  sendImpl: ((opts: SendMailOptions) => Promise<SentMessageInfo>) | null = null;

  async sendMail(opts: SendMailOptions): Promise<SentMessageInfo> {
    if (this.sendImpl) return this.sendImpl(opts);
    const idx = this.sent.length + 1;
    const messageId = `<stub-${idx}@f16>`;
    this.sent.push({
      from: opts.from,
      to: opts.to,
      subject: String(opts.subject ?? ''),
      text: String(opts.text ?? ''),
      html: String(opts.html ?? ''),
      attachments: opts.attachments,
      replyTo: opts.replyTo,
      inReplyTo: opts.inReplyTo,
      messageId,
    });
    return {
      messageId,
      accepted: [opts.to as string],
      rejected: [],
      response: '250 OK',
      envelope: { from: '', to: [] },
      pending: [],
    } as unknown as SentMessageInfo;
  }

  async verify(): Promise<true> {
    return this.verifyImpl();
  }
}

function buildAdapter(transport: StubTransport): EmailAdapter {
  return new EmailAdapter({
    transport,
    fromName: 'Assuryal',
    fromAddress: 'noreply@assuryalconseil.fr',
  });
}

let transport: StubTransport;
beforeEach(() => {
  transport = new StubTransport();
});

describe('EmailAdapter.capabilities', () => {
  it('returns the expected capability shape', () => {
    const caps = buildAdapter(transport).capabilities();
    expect(caps).toEqual({
      interactive: false,
      voice: false,
      attachments: true,
      markdown: true,
    });
  });
});

describe('EmailAdapter.send — text block', () => {
  it('renders text block to plain text and HTML paragraph', async () => {
    const receipt = await buildAdapter(transport).send({
      to: { channel: 'email', address: 'marie@example.fr' },
      body: [{ type: 'text', text: 'Bonjour Marie, voici votre devis.' }],
    });

    expect(transport.sent).toHaveLength(1);
    const sent = transport.sent[0]!;
    expect(sent.text).toContain('Bonjour Marie, voici votre devis.');
    expect(sent.html).toContain('<p>Bonjour Marie, voici votre devis.</p>');
    expect(receipt.channel).toBe('email');
    expect(receipt.externalId).toBe('<stub-1@f16>');
    expect(receipt.acceptedAt).toBeInstanceOf(Date);
  });
});

describe('EmailAdapter.send — markdown block', () => {
  it('renders markdown to <strong>, <em>, <a>', async () => {
    await buildAdapter(transport).send({
      to: { channel: 'email', address: 'marie@example.fr' },
      body: [
        {
          type: 'markdown',
          text: 'Voici **bold** texte et un [link](https://a.com).',
        },
      ],
    });

    const sent = transport.sent[0]!;
    expect(sent.html).toContain('<strong>bold</strong>');
    expect(sent.html).toContain('<a href="https://a.com">link</a>');
    // Plain-text strips the markers but keeps the link inlined.
    expect(sent.text).toContain('bold');
    expect(sent.text).toContain('link (https://a.com)');
  });
});

describe('EmailAdapter.send — image block', () => {
  it('attaches image and renders <img src=url>', async () => {
    await buildAdapter(transport).send({
      to: { channel: 'email', address: 'marie@example.fr' },
      body: [
        {
          type: 'image',
          url: 'https://cdn.example.fr/toit.jpg',
          caption: 'Votre toit',
        },
      ],
    });

    const sent = transport.sent[0]!;
    expect(sent.html).toContain('<img src="https://cdn.example.fr/toit.jpg"');
    const atts = sent.attachments as Array<{ path?: string; filename?: string }>;
    expect(atts).toHaveLength(1);
    expect(atts[0]?.path).toBe('https://cdn.example.fr/toit.jpg');
  });
});

describe('EmailAdapter.send — document block', () => {
  it('attaches document and renders link with filename', async () => {
    await buildAdapter(transport).send({
      to: { channel: 'email', address: 'marie@example.fr' },
      body: [
        {
          type: 'document',
          url: 'https://cdn.example.fr/devis.pdf',
          filename: 'devis-marie.pdf',
          mimeType: 'application/pdf',
        },
      ],
    });

    const sent = transport.sent[0]!;
    expect(sent.html).toContain('href="https://cdn.example.fr/devis.pdf"');
    expect(sent.html).toContain('devis-marie.pdf');
    const atts = sent.attachments as Array<{
      path?: string;
      filename?: string;
      contentType?: string;
    }>;
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({
      path: 'https://cdn.example.fr/devis.pdf',
      filename: 'devis-marie.pdf',
      contentType: 'application/pdf',
    });
  });
});

describe('EmailAdapter.send — mixed body', () => {
  it('combines text + markdown + image + document into ONE email with 2 attachments', async () => {
    const body: ContentBlock[] = [
      { type: 'text', text: 'Bonjour Marie,' },
      { type: 'markdown', text: 'Voici **votre devis** détaillé.' },
      {
        type: 'image',
        url: 'https://cdn.example.fr/toit.jpg',
        caption: 'Toit',
      },
      {
        type: 'document',
        url: 'https://cdn.example.fr/devis.pdf',
        filename: 'devis.pdf',
        mimeType: 'application/pdf',
      },
    ];

    await buildAdapter(transport).send({
      to: { channel: 'email', address: 'marie@example.fr' },
      body,
    });

    expect(transport.sent).toHaveLength(1);
    const sent = transport.sent[0]!;
    expect(sent.text).toContain('Bonjour Marie,');
    expect(sent.text).toContain('votre devis');
    expect(sent.html).toContain('<p>Bonjour Marie,</p>');
    expect(sent.html).toContain('<strong>votre devis</strong>');
    expect(sent.html).toContain('<img src="https://cdn.example.fr/toit.jpg"');
    expect(sent.html).toContain('devis.pdf');
    const atts = sent.attachments as Array<unknown>;
    expect(atts).toHaveLength(2);
  });
});

describe('EmailAdapter.send — subject derivation', () => {
  it('uses first text block, truncated to 80 chars with ellipsis', async () => {
    const longText =
      'Bonjour Marie, voici votre devis pour la rénovation de votre toit avec une remise exceptionnelle ce mois-ci.';
    expect(longText.length).toBeGreaterThan(80);

    await buildAdapter(transport).send({
      to: { channel: 'email', address: 'marie@example.fr' },
      body: [{ type: 'text', text: longText }],
    });

    const subj = transport.sent[0]!.subject;
    expect(subj.endsWith('…')).toBe(true);
    // 80 chars + the ellipsis = length 81.
    expect(subj.length).toBe(81);
    expect(longText.startsWith(subj.slice(0, -1))).toBe(true);
  });

  it('falls back to "Message from Assuryal" when no text/markdown blocks', async () => {
    await buildAdapter(transport).send({
      to: { channel: 'email', address: 'marie@example.fr' },
      body: [
        {
          type: 'document',
          url: 'https://cdn.example.fr/devis.pdf',
          filename: 'devis.pdf',
          mimeType: 'application/pdf',
        },
      ],
    });
    expect(transport.sent[0]!.subject).toBe('Message from Assuryal');
  });
});

describe('EmailAdapter.send — from header', () => {
  it('formats from as "Name <address>"', async () => {
    await buildAdapter(transport).send({
      to: { channel: 'email', address: 'marie@example.fr' },
      body: [{ type: 'text', text: 'Bonjour' }],
    });
    expect(transport.sent[0]!.from).toBe('Assuryal <noreply@assuryalconseil.fr>');
  });
});

describe('EmailAdapter.send — replyTo / threading', () => {
  it('forwards MessageRef.externalId as nodemailer inReplyTo', async () => {
    await buildAdapter(transport).send({
      to: { channel: 'email', address: 'marie@example.fr' },
      body: [{ type: 'text', text: 'Re: votre devis' }],
      replyTo: {
        channel: 'email',
        externalId: '<previous-msg-id@assuryalconseil.fr>',
      },
    });
    expect(transport.sent[0]!.inReplyTo).toBe('<previous-msg-id@assuryalconseil.fr>');
  });
});

describe('EmailAdapter — guardrails', () => {
  it('throws when ContactRef.channel is not email and never calls sendMail', async () => {
    await expect(
      buildAdapter(transport).send({
        to: { channel: 'whatsapp', address: '+33612345678' },
        body: [{ type: 'text', text: 'oops' }],
      }),
    ).rejects.toThrow(/cannot send to whatsapp/);
    expect(transport.sent).toHaveLength(0);
  });
});

describe('EmailAdapter.healthCheck', () => {
  it('returns {healthy:true} when transport.verify() succeeds', async () => {
    const result = await buildAdapter(transport).healthCheck();
    expect(result).toEqual({ healthy: true });
  });

  it('returns {healthy:false, detail} when transport.verify() throws', async () => {
    transport.verifyImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await buildAdapter(transport).healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.detail).toBe('ECONNREFUSED');
  });
});

describe('EmailAdapter — PII discipline', () => {
  it('on transport error: thrown message contains neither recipient nor subject', async () => {
    transport.sendImpl = async () => {
      // Simulate an upstream error that echoes recipient + subject (worst
      // case) — adapter must scrub before re-throwing.
      throw new Error('SMTP failed: 550 to=marie@example.fr subject="Devis secret"');
    };

    let caught: unknown;
    try {
      await buildAdapter(transport).send({
        to: { channel: 'email', address: 'marie@example.fr' },
        body: [{ type: 'text', text: 'Devis secret' }],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).not.toContain('marie@example.fr');
    expect(msg).not.toContain('Devis secret');
  });
});
