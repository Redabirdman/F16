/**
 * Standalone WS-server bootstrap for M8.T8 phase 2d live verification.
 *
 * Boots ONLY the ExtensionClient WS server — no Postgres, no Redis, no
 * BullMQ, no Hono. Lets us verify the extension-to-backend WS link end
 * to end without needing the full F16 backend stack running locally.
 *
 * Usage:
 *   pnpm extension:ws
 *
 * What it does:
 *   1. Starts the WS server on 127.0.0.1:9223 (or MAXANCE_EXTENSION_WS_PORT).
 *   2. Logs every connect / disconnect / inbound frame.
 *   3. Sends a `ping` every 10s once connected, logs the pong.
 *   4. Exposes the client on `global.extClient` so a REPL/inspector can
 *      drive `ensureLoggedIn() / runQuote() / confirmQuote()` interactively.
 *   5. Ctrl-C cleans up.
 *
 * Once we've verified the round-trip works, swap to `pnpm dev` (which
 * boots the full backend) for the end-to-end QUOTE.REQUESTED → preview
 * → confirm path via BullMQ.
 */
import { randomUUID } from 'node:crypto';
import { ExtensionClient } from '../src/agents/maxance-operator/extension-client.js';
import { logger } from '../src/logger.js';

const port = Number.parseInt(process.env.MAXANCE_EXTENSION_WS_PORT ?? '', 10) || 9223;
const client = new ExtensionClient({ port, timeoutMs: 60_000 });

async function main(): Promise<void> {
  await client.start();
  logger.info({ port }, 'extension-ws-only: server up; waiting for the extension to connect');

  // Periodic ping while connected — gives a heartbeat trace in the logs.
  setInterval(() => {
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

  process.on('SIGINT', () => {
    logger.info('extension-ws-only: SIGINT, shutting down');
    void client.stop().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void client.stop().then(() => process.exit(0));
  });
}

void main().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'extension-ws-only: failed to start',
  );
  process.exit(1);
});
