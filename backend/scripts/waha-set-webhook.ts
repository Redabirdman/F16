/* eslint-disable no-console, @typescript-eslint/no-explicit-any -- standalone WAHA webhook configurator. */
/**
 * Point the cloud WAHA session's webhook at our backend (so inbound replies
 * route to /webhooks/waha). PRESERVES any existing webhooks (adds ours if not
 * already present) — never clobbers another app's webhook.
 *
 *   npx tsx scripts/waha-set-webhook.ts <publicBaseUrl>
 */
import 'dotenv/config';

const base = (process.env.WAHA_BASE_URL ?? '').replace(/\/+$/, '');
const session = process.env.WAHA_SESSION ?? 'default';
const key = process.env.WAHA_API_KEY;
const publicBase = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!base || !publicBase) {
  console.error('usage: waha-set-webhook <publicBaseUrl>  (WAHA_BASE_URL from .env)');
  process.exit(1);
}
const hookUrl = `${publicBase}/webhooks/waha`;
const headers: Record<string, string> = { 'content-type': 'application/json' };
if (key) headers['x-api-key'] = key;

(async () => {
  const cur = await (await fetch(`${base}/api/sessions/${session}`, { headers }))
    .json()
    .catch(() => ({}));
  const existing: any[] = (cur as any).config?.webhooks ?? [];
  if (existing.some((w) => w?.url === hookUrl)) {
    console.log('webhook already set:', hookUrl);
    process.exit(0);
  }
  // Drop any prior F16 webhook (old/dead tunnel) but keep other apps' webhooks.
  const kept = existing.filter((w) => !String(w?.url ?? '').endsWith('/webhooks/waha'));
  const webhooks = [...kept, { url: hookUrl, events: ['message'] }];
  const res = await fetch(`${base}/api/sessions/${session}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ config: { webhooks } }),
  });
  console.log('PUT update:', res.status, (await res.text()).slice(0, 300));
  const check = await (await fetch(`${base}/api/sessions/${session}`, { headers }))
    .json()
    .catch(() => ({}));
  console.log('webhooks now:', JSON.stringify((check as any).config?.webhooks ?? []));
})().catch((e) => {
  console.error('set-webhook failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
