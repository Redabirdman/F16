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
/**
 * Capped exponential reconnect backoff. Gmail hiccups are transient, so we
 * retry FOREVER (self-healing mandate) — never park the watcher on a dead
 * connection until a human restarts the backend.
 */
const MAX_RECONNECT_BACKOFF_MS = 60_000;
const RECONNECT_BACKOFF_MS = [5_000, 10_000, 30_000, MAX_RECONNECT_BACKOFF_MS] as const;
/** Anchored devis-number pattern — we control the subject (mailObjet). */
const DR_RE = /\b(DR\d{8,12})\b/;

/**
 * Auth rejections (535 / "Invalid credentials" / AUTHENTICATIONFAILED) are
 * NOT transient — the App Password was likely revoked (it has happened
 * live). We log loud at error and retry only at the max backoff so we don't
 * hammer Google (which can escalate to a temporary account lock).
 */
export function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const flagged = err as Error & { authenticationFailed?: boolean };
  if (flagged.authenticationFailed === true) return true;
  return /\b535\b|invalid credentials|authenticationfailed|username and password not accepted/i.test(
    err.message,
  );
}

/**
 * Connection-class errors — the IMAP session is gone (or never came up) and
 * a reconnect fixes it. This is what "Connection not available" from
 * imapflow looks like after an overnight drop (live-observed 2026-07-05).
 */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (isAuthError(err)) return false;
  const code = (err as NodeJS.ErrnoException).code ?? '';
  if (
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'NoConnection',
    ].includes(code)
  ) {
    return true;
  }
  return /connection (not available|closed|lost|reset|ended)|socket (hang ?up|closed|error)|ECONNRESET|greeting never received/i.test(
    err.message,
  );
}

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
  let connected = false;
  let everConnected = false;
  /**
   * Single-flight reconnect guard: 'close'/'error' events, sweep failures
   * and poll ticks can all detect the loss around the same time — they must
   * share ONE reconnect, never spawn parallel IMAP connections.
   */
  let reconnectPromise: Promise<void> | null = null;
  const timers = new Set<NodeJS.Timeout>();

  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => {
      const t = setTimeout(() => {
        timers.delete(t);
        r();
      }, ms);
      timers.add(t);
    });

  /**
   * Flip to "down" exactly once per outage (one warn per state change — a
   * dead connection must not warn-spam every 20s sweep) and kick the
   * background reconnect.
   */
  const markDown = (reason: string): void => {
    if (stopped || !connected) return;
    connected = false;
    logger.warn({ reason }, 'devis-inbox: connection lost — reconnecting');
    void ensureConnected();
  };

  const connectOnce = async (): Promise<void> => {
    const c = new ImapFlow({
      host,
      port: 993,
      secure: true,
      auth: { user, pass },
      logger: false,
    });
    // Detect drops between sweeps. Guard on `client === c` so stragglers
    // from an already-replaced client can't tear down the healthy one.
    c.on('error', (err: Error) => {
      logger.warn({ err: err.message }, 'devis-inbox: imap socket error');
      if (client === c) markDown(`socket error: ${err.message}`);
    });
    c.on('close', () => {
      if (client === c) markDown('socket closed');
    });
    await c.connect();
    client = c;
    connected = true;
  };

  /** Reconnect with capped exponential backoff; retries until stop(). */
  const ensureConnected = (): Promise<void> => {
    if (reconnectPromise) return reconnectPromise;
    reconnectPromise = (async () => {
      // Dispose the dead client first (best effort).
      const dead = client;
      client = null;
      connected = false;
      try {
        await dead?.logout();
      } catch {
        /* already gone */
      }
      let attempt = 0;
      while (!stopped) {
        try {
          await connectOnce();
          logger.info(
            { host, user },
            everConnected ? 'devis-inbox: reconnected' : 'devis-inbox: connected',
          );
          everConnected = true;
          return;
        } catch (err) {
          if (stopped) return;
          const msg = err instanceof Error ? err.message : String(err);
          const auth = isAuthError(err);
          const delayMs = auth
            ? MAX_RECONNECT_BACKOFF_MS
            : (RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)] ??
              MAX_RECONNECT_BACKOFF_MS);
          if (auth) {
            logger.error(
              { err: msg, retryInMs: delayMs },
              'devis-inbox: IMAP auth rejected — App Password likely revoked (renew in Google Workspace); retrying slowly',
            );
          } else {
            logger.warn(
              { err: msg, attempt: attempt + 1, retryInMs: delayMs },
              'devis-inbox: reconnect attempt failed — retrying',
            );
          }
          attempt += 1;
          await sleep(delayMs);
        }
      }
    })().finally(() => {
      reconnectPromise = null;
    });
    return reconnectPromise;
  };

  const loop = async (): Promise<void> => {
    await ensureConnected();
    while (!stopped) {
      if (!connected || reconnectPromise || !client) {
        // Down — the reconnect path owns recovery; sweeps just skip quietly.
        logger.debug('devis-inbox: connection down — skipping sweep');
      } else {
        const current = client;
        try {
          await scanOnce(current, deps.db);
        } catch (err) {
          if (stopped) break;
          const msg = err instanceof Error ? err.message : String(err);
          if (client !== current) {
            // Stale failure from a client that was already replaced.
            logger.debug({ err: msg }, 'devis-inbox: sweep failed on replaced client — ignoring');
          } else if (isConnectionError(err)) {
            markDown(msg);
          } else {
            logger.warn({ err: msg }, 'devis-inbox: sweep failed');
          }
        }
      }
      if (stopped) break;
      await sleep(POLL_MS);
    }
  };
  void loop();

  return {
    async stop(): Promise<void> {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      try {
        await client?.logout();
      } catch {
        /* closing anyway */
      }
    },
  };
}

/**
 * Mailboxes swept each poll. Gmail routinely spam-folders Maxance's relay
 * (live-observed) until a Workspace admin whitelist exists, so the Spam
 * folder is swept too — the DR-subject match keeps this surgical.
 */
const MAILBOXES = ['INBOX', '[Gmail]/Spam'] as const;

/** One UNSEEN sweep across the watched mailboxes. */
async function scanOnce(client: ImapFlow, db: Database): Promise<void> {
  for (const mailbox of MAILBOXES) {
    try {
      await scanMailbox(client, db, mailbox);
    } catch (err) {
      // A dead connection must bubble up so the watcher reconnects —
      // swallowing it here is exactly the 2026-07-05 "dead until manual
      // restart" bug.
      if (isConnectionError(err)) throw err;
      // A missing/renamed folder (locale variants of Spam) must not kill the
      // INBOX sweep — log and continue.
      logger.warn(
        { mailbox, err: err instanceof Error ? err.message : String(err) },
        'devis-inbox: mailbox sweep failed',
      );
    }
  }
}

/** UNSEEN sweep of one mailbox: process devis emails, leave the rest alone. */
async function scanMailbox(client: ImapFlow, db: Database, mailbox: string): Promise<void> {
  logger.debug({ mailbox }, 'devis-inbox: sweep start');
  const lock = await client.getMailboxLock(mailbox);
  try {
    const unseen = await client.search({ seen: false });
    const count = Array.isArray(unseen) ? unseen.length : 0;
    logger.info({ mailbox, unseen: count }, 'devis-inbox: sweep');
    if (!Array.isArray(unseen) || unseen.length === 0) return;

    for (const uid of unseen) {
      // Cheap envelope pass first — only download full sources for likely hits.
      const meta = await client.fetchOne(String(uid), { envelope: true });
      const subject = (typeof meta === 'object' && meta?.envelope?.subject) || '';
      logger.debug(
        { mailbox, seq: uid, metaType: typeof meta, subject: subject.slice(0, 60) },
        'devis-inbox: envelope',
      );
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
      logger.info(
        { devisNumber, pdfPath, mailbox, bytes: pdf.content.length },
        'devis-inbox: PDF relayed',
      );
    }
  } finally {
    lock.release();
  }
}
