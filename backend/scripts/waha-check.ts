/* eslint-disable no-console, @typescript-eslint/no-explicit-any -- standalone WAHA health check. */
/**
 * Verify the cloud WAHA instance from backend/.env: session status + the
 * connected number. Prints the base URL host (not the API key).
 *
 *   npx tsx scripts/waha-check.ts
 */
import 'dotenv/config';

const base = (process.env.WAHA_BASE_URL ?? '').replace(/\/+$/, '');
const session = process.env.WAHA_SESSION ?? 'default';
const apiKey = process.env.WAHA_API_KEY;

if (!base) {
  console.error('WAHA_BASE_URL not set in .env');
  process.exit(1);
}
const headers: Record<string, string> = {};
if (apiKey) headers['x-api-key'] = apiKey;

(async () => {
  console.log(
    'base host:',
    new URL(base).host,
    '| session:',
    session,
    '| apiKey:',
    Boolean(apiKey),
  );
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(session)}`, { headers });
  console.log('status:', res.status);
  const j = (await res.json().catch(() => ({}))) as any;
  console.log('session status:', j.status);
  if (j.me) console.log('connected number:', j.me.id, '| name:', j.me.pushName);
  else console.log('me:', JSON.stringify(j).slice(0, 300));
  console.log('existing webhooks:', JSON.stringify(j.config?.webhooks ?? []));
  process.exit(0);
})().catch((e) => {
  console.error('waha-check failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
