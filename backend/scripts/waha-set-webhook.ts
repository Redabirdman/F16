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
  // NOTE: we DON'T short-circuit when the URL already matches — re-applying is
  // idempotent and is the only way to add/refresh the HMAC signing key on an
  // already-registered webhook.
  // Drop any prior F16 webhook (old/dead tunnel) but keep other apps' webhooks.
  const kept = existing.filter((w) => !String(w?.url ?? '').endsWith('/webhooks/waha'));
  // M16 — when WAHA_HMAC_SECRET is set, ask WAHA to sign our webhook (HMAC-SHA512
  // in the X-Webhook-Hmac header). The backend verifies it (default algo sha512).
  const hmacSecret = process.env.WAHA_HMAC_SECRET;
  const ours: Record<string, unknown> = { url: hookUrl, events: ['message'] };
  if (hmacSecret) {
    ours.hmac = { key: hmacSecret };
    console.log('HMAC signing ENABLED on this webhook (X-Webhook-Hmac, sha512)');
  } else {
    console.log('HMAC signing DISABLED (WAHA_HMAC_SECRET empty) — backend skips verification');
  }
  const webhooks = [...kept, ours];
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
