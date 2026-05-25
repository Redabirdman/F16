/**
 * Standalone WS-server bootstrap for M8.T8 phase 2d live verification.
 *
 * Boots ONLY the ExtensionClient WS server + a tiny HTTP control plane
 * (no Postgres, no Redis, no BullMQ, no Hono webhooks). Lets us verify
 * the extension-to-backend WS link end to end without needing the full
 * F16 backend stack running locally.
 *
 * Usage:
 *   pnpm extension:ws
 *
 * What it does:
 *   1. Starts the WS server on 127.0.0.1:9223 (or MAXANCE_EXTENSION_WS_PORT).
 *   2. Starts the HTTP control plane on 127.0.0.1:9224 (or
 *      MAXANCE_EXTENSION_HTTP_PORT) so a human/curl can fire commands.
 *   3. Logs every connect / disconnect / inbound frame.
 *   4. Sends a `ping` every 10s once connected, logs the pong.
 *   5. Exposes the client on `global.extClient` so a REPL/inspector can
 *      drive `ensureLoggedIn() / runQuote() / confirmQuote()` interactively.
 *   6. Ctrl-C cleans up.
 *
 * Phase-2d trigger examples (after the extension connects):
 *
 *   curl -X POST http://127.0.0.1:9224/health
 *   curl -X POST http://127.0.0.1:9224/login
 *   curl -X POST http://127.0.0.1:9224/quote-preview \
 *        -H 'Content-Type: application/json' \
 *        -d '{"vehicleKind":"trottinette","purchasePriceEur":350,
 *             "purchaseDate":"2025-01-15","postalCode":"75011",
 *             "stationnement":"garage_box",
 *             "clientDateOfBirth":"1992-04-12"}'
 *
 * Optional: set `EXTENSION_WS_TRIGGER_TOKEN=...` to gate the HTTP plane
 * with a Bearer token (recommended once the dedicated PC is up to prevent
 * a stale browser tab from accidentally firing a real flow).
 *
 * Once we've verified the round-trip works, swap to `pnpm dev` (which
 * boots the full backend) for the end-to-end QUOTE.REQUESTED → preview
 * → confirm path via BullMQ.
 */
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { ExtensionClient } from '../src/agents/maxance-operator/extension-client.js';
import {
  buildExtensionControlPlane,
  DEFAULT_CONTROL_PLANE_PORT,
} from '../src/agents/maxance-operator/control-plane.js';
import { logger } from '../src/logger.js';

const wsPort = Number.parseInt(process.env.MAXANCE_EXTENSION_WS_PORT ?? '', 10) || 9223;
const httpPort =
  Number.parseInt(process.env.MAXANCE_EXTENSION_HTTP_PORT ?? '', 10) || DEFAULT_CONTROL_PLANE_PORT;
// 5 min — comfortably above the SW orchestrator's 240s hard deadline for
// navigation-prone flows (quote.preview chains 4 top-frame navigations).
const client = new ExtensionClient({ port: wsPort, timeoutMs: 5 * 60_000 });

let httpServer: Server | undefined;
let pingTimer: NodeJS.Timeout | undefined;

async function main(): Promise<void> {
  await client.start();
  logger.info(
    { port: wsPort },
    'extension-ws-only: ws server up; waiting for the extension to connect',
  );

  // HTTP control plane — bind 127.0.0.1 only (loopback). Optional Bearer
  // token via EXTENSION_WS_TRIGGER_TOKEN; when unset, no auth (dev convenience).
  const triggerToken = process.env.EXTENSION_WS_TRIGGER_TOKEN;
  const controlPlaneOpts: Parameters<typeof buildExtensionControlPlane>[0] = { client };
  if (triggerToken) controlPlaneOpts.triggerToken = triggerToken;
  const cp = buildExtensionControlPlane(controlPlaneOpts);
  httpServer = serve({ fetch: cp.fetch, port: httpPort, hostname: '127.0.0.1' }) as Server;
  logger.info(
    { port: httpPort, authGated: Boolean(triggerToken) },
    'extension-ws-only: http control plane up — POST /health /login /quote-preview /quote-confirm',
  );

  // Periodic ping while connected — gives a heartbeat trace in the logs.
  pingTimer = setInterval(() => {
    if (!client.isConnected()) return;
    void client
      .health()
      .then((res) => logger.info(res, 'extension-ws-only: ping ok'))
      .catch((err: unknown) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'extension-ws-only: ping failed',
        ),
      );
  }, 10_000);

  // Expose for REPL inspection — `pnpm extension:ws --inspect` lets you
  // poke at `globalThis.extClient.ensureLoggedIn()` from chrome://inspect.
  (globalThis as unknown as { extClient: ExtensionClient }).extClient = client;
  (globalThis as unknown as { randomUUID: () => string }).randomUUID = randomUUID;

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'extension-ws-only: shutting down');
    if (pingTimer) clearInterval(pingTimer);
    if (httpServer) httpServer.close();
    void client.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'extension-ws-only: failed to start',
  );
  process.exit(1);
});
