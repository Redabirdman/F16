/**
 * Extension WS client (M8.T8 phase 2c) — drop-in replacement for
 * `stagehand-client.ts` when MAXANCE_DRIVER=chrome_extension.
 *
 * Architecture: the backend hosts a WebSocket server on
 * 127.0.0.1:9223. The Chrome extension running inside Ridaa's daily
 * Chrome connects outbound to this server (extension/src/background.ts).
 * The backend sends wire Commands (`ping`, `login.ensure`, `quote.preview`,
 * `quote.confirm`) and awaits matching Responses correlated by `id`.
 *
 * Same method surface as `StagehandClient` so MaxanceOperatorAgent
 * doesn't change shape — only the implementation behind the methods
 * differs. The agent picks one or the other based on MAXANCE_DRIVER env.
 *
 * V1 keeps it simple: single extension, single backend, localhost-only.
 * No HMAC handshake in this iteration — the WS listener binds to
 * 127.0.0.1 so the OS firewall enforces the trust boundary. Phase 2d
 * can add HMAC if the dedicated PC ever runs with the WS server exposed.
 *
 * Pending-command tracker: each method awaits its Response by storing a
 * `{resolve, reject, timer}` entry keyed by the Command's UUID. When the
 * WS receives a Response, we look up the entry and resolve. Disconnect
 * rejects all pending entries with `extension_disconnected`.
 */
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { randomUUID } from 'node:crypto';
import { logger } from '../../logger.js';
import { parseFrame, type Command, type Response } from '@f16/extension/wire';

const DEFAULT_WS_PORT = 9223;
const DEFAULT_TIMEOUT_MS = 6 * 60_000;
const PING_TIMEOUT_MS = 5_000;

/** Mirrors StagehandClient's shapes — keeps MaxanceOperatorAgent unchanged. */
export interface QuotePreviewResult {
  sessionId: string;
  durationMs: number;
  screenshots: { step: string; url: string }[];
  dryRun: boolean;
  pricePreviewEur: { monthly?: number; annual?: number };
  finalUrl: string;
}
export interface LoginResult {
  sessionId: string;
  durationMs: number;
  screenshots: { step: string; url: string }[];
  alreadyLoggedIn: boolean;
  requiredHumanAction: boolean;
  finalUrl: string;
}
export interface ConfirmQuoteResult {
  sessionId: string;
  durationMs: number;
  screenshots: { step: string; url: string }[];
  devisNumber: string;
  pdfSentTo: string;
  finalUrl: string;
}

export interface ExtensionSubscriberInfo {
  civilite: 'monsieur' | 'madame';
  lastName: string;
  firstName: string;
  addressLine: string;
  addressComplement?: string;
  postalCode: string;
  city: string;
  phoneMobile: string;
  email: string;
  profession?: 'employe_prive' | 'employe_public' | 'etudiant' | 'retraite' | 'sans_profession';
}

export interface ExtensionQuoteParams {
  vehicleKind: 'trottinette';
  purchasePriceEur: number;
  /** ISO date string (preferred) OR a Date — normalised to ISO before send. */
  purchaseDate: string | Date;
  postalCode: string;
  city?: string;
  stationnement: 'garage_box' | 'parking_prive_clos' | 'parking_prive_non_clos' | 'rue';
  clientDateOfBirth: string | Date;
  formule?: 'tiers_illimite' | 'vol_incendie' | 'dommages_tous_accidents';
  commissionPct?: number;
  fractionnement?: 'mensuel' | 'annuel';
}

export class ExtensionClientError extends Error {
  constructor(
    message: string,
    public readonly errorCode: string,
  ) {
    super(message);
    this.name = 'ExtensionClientError';
  }
}

export interface ExtensionClientConfig {
  /** Port to listen on. Default 9223. */
  port?: number;
  /** Default per-command timeout in ms. Default 6 min. */
  timeoutMs?: number;
}

type PendingEntry = {
  resolve: (resp: Response) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * Hosts the WS server, tracks the (singular) connected extension, and
 * exposes Stagehand-shape methods that the MaxanceOperatorAgent calls.
 */
export class ExtensionClient {
  private readonly port: number;
  private readonly timeoutMs: number;
  private wss: WebSocketServer | null = null;
  private socket: WsClient | null = null;
  private readonly pending = new Map<string, PendingEntry>();

  constructor(cfg: ExtensionClientConfig = {}) {
    this.port = cfg.port ?? DEFAULT_WS_PORT;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Start the WS server. Idempotent. */
  async start(): Promise<void> {
    if (this.wss) return;
    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
      wss.once('listening', () => {
        this.wss = wss;
        logger.info({ port: this.port }, 'extension-client: ws server listening');
        resolve();
      });
      wss.once('error', (err: Error) => reject(err));
      wss.on('connection', (sock: WsClient) => this.onConnection(sock));
    });
  }

  /** Stop the WS server + reject any pending commands. */
  async stop(): Promise<void> {
    const pending = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new ExtensionClientError('extension_client_stopping', 'extension_stopping'));
    }
    if (this.socket) {
      try {
        this.socket.close(1000, 'extension-client stopping');
      } catch {
        /* noop */
      }
      this.socket = null;
    }
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss?.close(() => resolve());
      });
      this.wss = null;
    }
  }

  isConnected(): boolean {
    return this.socket?.readyState === WsClient.OPEN;
  }

  private onConnection(sock: WsClient): void {
    if (this.socket && this.socket.readyState === WsClient.OPEN) {
      // V1 supports a single extension. Reject any extras to avoid two
      // browsers fighting over the same Maxance tab.
      logger.warn(
        { remoteAddress: '127.0.0.1' },
        'extension-client: rejecting extra connection (V1 = single extension)',
      );
      sock.close(1008, 'already_connected');
      return;
    }
    this.socket = sock;
    logger.info('extension-client: extension connected');
    sock.on('message', (data) => this.onMessage(typeof data === 'string' ? data : data.toString()));
    sock.on('close', () => {
      logger.warn('extension-client: extension disconnected');
      if (this.socket === sock) this.socket = null;
      this.rejectPending('extension_disconnected');
    });
    sock.on('error', (err: Error) => {
      logger.warn({ err: err.message }, 'extension-client: socket error');
    });
  }

  private onMessage(text: string): void {
    let parsed;
    try {
      parsed = parseFrame(text);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'extension-client: invalid inbound frame');
      return;
    }
    if (parsed.side === 'response') {
      const id = parsed.value.id;
      const entry = this.pending.get(id);
      if (!entry) {
        logger.warn(
          { id, kind: parsed.value.kind },
          'extension-client: response without pending entry',
        );
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(parsed.value);
    } else if (parsed.side === 'event') {
      logger.info({ kind: parsed.value.kind }, 'extension-client: event received');
      // V1: just log. Phase 2d may forward progress events to the
      // operator UI via a separate channel.
    }
  }

  private rejectPending(errorCode: string): void {
    const entries = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [, entry] of entries) {
      clearTimeout(entry.timer);
      entry.reject(new ExtensionClientError(`extension_${errorCode}`, errorCode));
    }
  }

  /**
   * Send a Command and await the matching Response. Throws
   * ExtensionClientError on timeout or if no extension is connected.
   */
  private send<R extends Response>(cmd: Command, timeoutMs?: number): Promise<R> {
    const sock = this.socket;
    if (!sock || sock.readyState !== WsClient.OPEN) {
      return Promise.reject(
        new ExtensionClientError(
          'extension_no_active_connection: no Chrome extension is connected to the backend WS',
          'no_active_connection',
        ),
      );
    }
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmd.id);
        reject(
          new ExtensionClientError(`extension_command_timeout:${cmd.kind}`, 'command_timeout'),
        );
      }, timeoutMs ?? this.timeoutMs);
      this.pending.set(cmd.id, {
        resolve: (resp) => {
          if (resp.kind === 'error') {
            reject(new ExtensionClientError(resp.detail ?? resp.errorCode, resp.errorCode));
            return;
          }
          resolve(resp as R);
        },
        reject,
        timer,
      });
      try {
        sock.send(JSON.stringify(cmd));
      } catch (err) {
        this.pending.delete(cmd.id);
        clearTimeout(timer);
        reject(
          new ExtensionClientError(
            `extension_send_failed:${(err as Error).message}`,
            'send_failed',
          ),
        );
      }
    });
  }

  /** Normalise Date → ISO string for the wire layer. */
  private toIso(d: string | Date): string {
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return d.slice(0, 10);
  }

  /**
   * Convert wire-shape screenshots (`{step, dataUrl}`) into the
   * StagehandClient-shape (`{step, url}`) consumed by MaxanceOperatorAgent.
   * V1 keeps the data URL inline — phase 2d can swap to writing the PNG to
   * disk + returning a `/v1/static/screenshots/...` URL if the operator UI
   * needs that path. For now we pass the data URL through verbatim.
   */
  private mapScreenshots(
    raw: Array<{ step: string; dataUrl: string }> | undefined,
  ): Array<{ step: string; url: string }> {
    if (!raw) return [];
    return raw.map((s) => ({ step: s.step, url: s.dataUrl }));
  }

  /* ────────────────────────────────────────────────────────────────────── */
  /*  Methods — same surface as StagehandClient                              */
  /* ────────────────────────────────────────────────────────────────────── */

  async ensureLoggedIn(_sessionName = 'maxance-default'): Promise<LoginResult> {
    void _sessionName; // single-session V1; the extension owns the tab choice
    const cmd: Command = { id: randomUUID(), kind: 'login.ensure' };
    const resp = await this.send(cmd);
    if (resp.kind !== 'login.ensure.ok') {
      throw new ExtensionClientError(
        `extension_login_unexpected_kind:${resp.kind}`,
        'unexpected_kind',
      );
    }
    return {
      sessionId: cmd.id, // re-use the command id as the session id (one-to-one in V1)
      durationMs: resp.durationMs,
      screenshots: [],
      alreadyLoggedIn: resp.alreadyLoggedIn,
      requiredHumanAction: resp.requiredHumanAction,
      finalUrl: resp.finalUrl,
    };
  }

  async runQuote(
    _sessionName: string,
    params: ExtensionQuoteParams,
    opts: { dryRun?: boolean; timeoutMs?: number } = {},
  ): Promise<QuotePreviewResult> {
    void _sessionName;
    const cmd: Command = {
      id: randomUUID(),
      kind: 'quote.preview',
      params: {
        vehicleKind: 'trottinette',
        purchasePriceEur: params.purchasePriceEur,
        purchaseDate: this.toIso(params.purchaseDate),
        postalCode: params.postalCode,
        ...(params.city !== undefined ? { city: params.city } : {}),
        stationnement: params.stationnement,
        clientDateOfBirth: this.toIso(params.clientDateOfBirth),
        ...(params.formule !== undefined ? { formule: params.formule } : {}),
        ...(params.commissionPct !== undefined ? { commissionPct: params.commissionPct } : {}),
        ...(params.fractionnement !== undefined ? { fractionnement: params.fractionnement } : {}),
      },
      dryRun: true,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    };
    const resp = await this.send(cmd, opts.timeoutMs);
    if (resp.kind !== 'quote.preview.ok') {
      throw new ExtensionClientError(
        `extension_quote_unexpected_kind:${resp.kind}`,
        'unexpected_kind',
      );
    }
    return {
      sessionId: cmd.id,
      durationMs: resp.durationMs,
      screenshots: this.mapScreenshots(resp.screenshots),
      dryRun: true,
      pricePreviewEur: {
        ...(resp.pricePreviewEur.monthly !== undefined
          ? { monthly: resp.pricePreviewEur.monthly }
          : {}),
        ...(resp.pricePreviewEur.annual !== undefined
          ? { annual: resp.pricePreviewEur.annual }
          : {}),
      },
      finalUrl: resp.finalUrl,
    };
  }

  async confirmQuote(
    _sessionName: string,
    subscriber: ExtensionSubscriberInfo,
    opts: { dryRun?: boolean; timeoutMs?: number } = {},
  ): Promise<ConfirmQuoteResult> {
    void _sessionName;
    const dryRun = opts.dryRun ?? true;
    const cmd: Command = {
      id: randomUUID(),
      kind: 'quote.confirm',
      subscriber: {
        civilite: subscriber.civilite,
        lastName: subscriber.lastName,
        firstName: subscriber.firstName,
        addressLine: subscriber.addressLine,
        ...(subscriber.addressComplement !== undefined
          ? { addressComplement: subscriber.addressComplement }
          : {}),
        postalCode: subscriber.postalCode,
        city: subscriber.city,
        phoneMobile: subscriber.phoneMobile,
        email: subscriber.email,
        ...(subscriber.profession !== undefined ? { profession: subscriber.profession } : {}),
      },
      dryRun,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    };
    const resp = await this.send(cmd, opts.timeoutMs);
    if (resp.kind !== 'quote.confirm.ok') {
      throw new ExtensionClientError(
        `extension_confirm_unexpected_kind:${resp.kind}`,
        'unexpected_kind',
      );
    }
    return {
      sessionId: cmd.id,
      durationMs: resp.durationMs,
      screenshots: this.mapScreenshots(resp.screenshots),
      devisNumber: resp.devisNumber,
      pdfSentTo: resp.pdfSentTo,
      finalUrl: resp.finalUrl,
    };
  }

  /**
   * Liveness probe. Sends a `ping` and awaits the `pong` within 5s. If the
   * extension is connected, the round trip resolves; otherwise this throws.
   */
  async health(): Promise<{ status: 'ok' | 'no_extension' }> {
    if (!this.isConnected()) return { status: 'no_extension' };
    try {
      const cmd: Command = { id: randomUUID(), kind: 'ping', nonce: 'health' };
      const resp = await this.send(cmd, PING_TIMEOUT_MS);
      if (resp.kind !== 'pong') {
        throw new ExtensionClientError(
          `extension_health_unexpected_kind:${resp.kind}`,
          'unexpected_kind',
        );
      }
      return { status: 'ok' };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'extension-client: health probe failed',
      );
      throw err;
    }
  }
}

/** Singleton accessor — created lazily on first use, started on demand. */
let defaultClient: ExtensionClient | null = null;
export function getDefaultExtensionClient(): ExtensionClient {
  if (!defaultClient) {
    defaultClient = new ExtensionClient({
      port: Number.parseInt(process.env.MAXANCE_EXTENSION_WS_PORT ?? '', 10) || DEFAULT_WS_PORT,
    });
  }
  return defaultClient;
}
