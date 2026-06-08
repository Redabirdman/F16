/* eslint-disable no-console -- standalone ops helper. */
/**
 * Enable WAHA inbound-webhook HMAC for production (M16 hardening).
 *
 * Generates a strong shared secret, writes WAHA_HMAC_SECRET + WAHA_HMAC_ALGO
 * into backend/.env (in place), then prints the two remaining steps that need
 * the current public tunnel URL. The backend verifies HMAC-SHA512 on every
 * inbound WAHA webhook once the secret is set (channels/whatsapp/webhook.ts).
 *
 * Do this AFTER the stable tunnel is up — enabling on a random TryCloudflare
 * URL means re-running waha-set-webhook on every rotation.
 *
 *   npx tsx scripts/enable-waha-hmac.ts
 *   # then:
 *   npx tsx scripts/waha-set-webhook.ts <publicBaseUrl>   # signs WAHA's side
 *   # restart the backend so it picks up WAHA_HMAC_SECRET
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const path = '.env';
const secret = randomBytes(32).toString('hex');
const updates: Record<string, string> = {
  WAHA_HMAC_SECRET: secret,
  WAHA_HMAC_ALGO: 'sha512',
};

const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
const lines = content.split(/\r?\n/);
const seen = new Set<string>();
const out = lines.map((line) => {
  const m = line.match(/^([A-Za-z0-9_]+)=/);
  if (m && m[1] && updates[m[1]] !== undefined) {
    seen.add(m[1]);
    return `${m[1]}=${updates[m[1]]}`;
  }
  return line;
});
for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) out.push(`${k}=${v}`);
writeFileSync(path, out.join('\n'));

console.log('✅ wrote WAHA_HMAC_SECRET (32-byte hex) + WAHA_HMAC_ALGO=sha512 to backend/.env');
console.log('\nNext steps:');
console.log('  1. npx tsx scripts/waha-set-webhook.ts <publicBaseUrl>   # configures WAHA to sign');
console.log('  2. restart the backend so it loads WAHA_HMAC_SECRET');
console.log('  3. send yourself a WhatsApp message → confirm it still routes (200, not 401)');
