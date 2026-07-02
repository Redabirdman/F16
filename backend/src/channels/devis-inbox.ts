/**
 * Devis-inbox watcher — the receiving half of the 2026-07-02 inbox-relay
 * delivery.
 *
 * Why: Maxance's own mail relay is silently dropped by gmail.com mailboxes
 * (live-verified — even manual sends never arrive), so the extension now
 * directs the devis courrier to the Assuryal Workspace inbox
 * (F16_DEVIS_COURRIER_TO, e.g. contact@assuryalconseil.fr). This watcher
 * polls that inbox over IMAP with the SAME App Password the SMTP channel
 * already uses, grabs the devis PDF attachment, stores it under
 * `var/devis/<DR>.pdf`, and emits DEVIS.PDF_RECEIVED — the Sales Agent then
 * re-delivers the PDF to the customer via WhatsApp + a branded Assuryal
 * email. Side benefit: the inbox itself is the ACPR record copy.
 *
 * Shared-mailbox etiquette: contact@ is a REAL mailbox Ridaa/Achraf use.
 * The watcher only marks \Seen the messages it successfully processed as
 * devis emails (subject carries a DR number + a PDF attached); everything
 * else is left untouched.
 *
 * Gating: requires SMTP_USER + SMTP_PASS (reused for IMAP) and
 * F16_DEVIS_INBOX=1. IMAP host override via F16_DEVIS_IMAP_HOST
 * (default imap.gmail.com). NOTE: Workspace admin must have IMAP access
 * enabled (Admin console → Gmail → End User Access), otherwise Google
 * rejects the login with "Invalid credentials" even when they're correct.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Database } from '../db/index.js';
import { sendMessage } from '../messaging/dispatcher.js';
import { logger } from '../logger.js';

/** Poll cadence. The devis email typically lands <60s after the Maxance send. */
const POLL_MS = 20_000;
/** Reconnect backoff after an IMAP error. */
const RECONNECT_MS = 30_000;
/** Anchored devis-number pattern — we control the subject (mailObjet). */
const DR_RE = /\b(DR\d{8,12})\b/;

export interface DevisInboxWatcher {
  stop(): Promise<void>;
}

interface WatcherDeps {
  db: Database;
}

/** Directory devis PDFs are stored in (absolute). */
export function devisStorageDir(): string {
  return resolve(process.cwd(), 'var', 'devis');
}

/**
 * Start the watcher. Returns null (with a log line) when unconfigured —
 * callers treat that as "feature off", never an error.
 */
export function startDevisInboxWatcher(deps: WatcherDeps): DevisInboxWatcher | null {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const enabled = process.env.F16_DEVIS_INBOX === '1';
  if (!enabled || !user || !pass) {
    logger.info(
      { enabled, hasCreds: Boolean(user && pass) },
      'devis-inbox: watcher disabled (set F16_DEVIS_INBOX=1 + SMTP_USER/SMTP_PASS)',
    );
    return null;
  }
  const host = process.env.F16_DEVIS_IMAP_HOST ?? 'imap.gmail.com';

  let stopped = false;
  let client: ImapFlow | null = null;
  let timer: NodeJS.Timeout | null = null;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        client = new ImapFlow({
          host,
          port: 993,
          secure: true,
          auth: { user, pass },
          logger: false,
        });
        // Surface socket-level errors to the catch below instead of crashing.
        client.on('error', (err: Error) => {
          logger.warn({ err: err.message }, 'devis-inbox: imap socket error');
        });
        await client.connect();
        logger.info({ host, user }, 'devis-inbox: connected');

        while (!stopped) {
          await scanOnce(client, deps.db);
          await new Promise<void>((r) => {
            timer = setTimeout(r, POLL_MS);
          });
        }
      } catch (err) {
        if (stopped) return;
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'devis-inbox: connection lost — reconnecting',
        );
        try {
          await client?.logout();
        } catch {
          /* already gone */
        }
        await new Promise<void>((r) => {
          timer = setTimeout(r, RECONNECT_MS);
        });
      }
    }
  };
  void loop();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        await client?.logout();
      } catch {
        /* closing anyway */
      }
    },
  };
}

/** One UNSEEN sweep: process devis emails, leave everything else untouched. */
async function scanOnce(client: ImapFlow, db: Database): Promise<void> {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const unseen = await client.search({ seen: false });
    if (!Array.isArray(unseen) || unseen.length === 0) return;

    for (const uid of unseen) {
      // Cheap envelope pass first — only download full sources for likely hits.
      const meta = await client.fetchOne(String(uid), { envelope: true });
      const subject = (typeof meta === 'object' && meta?.envelope?.subject) || '';
      const drMatch = DR_RE.exec(subject);
      if (!drMatch?.[1]) continue;
      const devisNumber = drMatch[1];

      const full = await client.fetchOne(String(uid), { source: true });
      if (typeof full !== 'object' || !full?.source) continue;
      const mail = await simpleParser(full.source);
      const pdf = (mail.attachments ?? []).find(
        (a) => a.contentType === 'application/pdf' || (a.filename ?? '').endsWith('.pdf'),
      );
      if (!pdf) {
        logger.warn({ devisNumber }, 'devis-inbox: DR subject but no PDF attachment — skipping');
        continue;
      }

      const dir = devisStorageDir();
      await mkdir(dir, { recursive: true });
      const pdfPath = resolve(dir, `${devisNumber}.pdf`);
      await writeFile(pdfPath, pdf.content);

      await sendMessage(
        { db },
        {
          fromRole: 'devis-inbox',
          fromInstance: 'devis-inbox',
          toRole: 'sales-agent',
          intent: 'DEVIS.PDF_RECEIVED',
          payload: {
            devisNumber,
            pdfPath,
            filename: pdf.filename ?? `${devisNumber}.pdf`,
            ...(mail.from?.value?.[0]?.address ? { from: mail.from.value[0].address } : {}),
          },
          correlationId: devisNumber,
        },
      );

      // Mark processed so the shared inbox doesn't re-trigger; only OUR hits.
      await client.messageFlagsAdd(String(uid), ['\\Seen']);
      logger.info({ devisNumber, pdfPath, bytes: pdf.content.length }, 'devis-inbox: PDF relayed');
    }
  } finally {
    lock.release();
  }
}
