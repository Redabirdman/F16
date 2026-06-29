/* eslint-disable no-console -- standalone infra fix. */
/**
 * Restore the hooks.assuryalconseil.fr DNS record (the voice/OpenAI webhook
 * host) — it went missing (NXDOMAIN) while admin.assuryalconseil.fr resolves.
 * Reads the admin record's CNAME target (the tunnel) and upserts hooks with the
 * same proxied target, in the zone the token can actually edit.
 *
 *   npx tsx scripts/cf-restore-hooks-dns.ts
 */
import 'dotenv/config';

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';
const ZONE_NAME = 'assuryalconseil.fr';
const HOOKS = 'hooks.assuryalconseil.fr';
const ADMIN = 'admin.assuryalconseil.fr';

if (!TOKEN) {
  console.error('missing CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

interface CfResp<T> {
  success: boolean;
  errors: unknown[];
  result: T;
}
async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as CfResp<T>;
  if (!json.success)
    throw new Error(`CF ${method} ${path} -> ${res.status}: ${JSON.stringify(json.errors)}`);
  return json.result;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

async function main(): Promise<void> {
  const zones = await cf<Array<{ id: string; name: string }>>('GET', `/zones?name=${ZONE_NAME}`);
  const zone = zones[0];
  if (!zone) {
    console.error(`zone ${ZONE_NAME} not found for this token`);
    process.exit(1);
    return;
  }
  console.log(`zone ${ZONE_NAME} id=${zone.id}`);

  const adminRec = (await cf<DnsRecord[]>('GET', `/zones/${zone.id}/dns_records?name=${ADMIN}`))[0];
  if (!adminRec) {
    console.error(`no DNS record for ${ADMIN} to copy the tunnel target from`);
    process.exit(1);
    return;
  }
  console.log(
    `admin record: type=${adminRec.type} content=${adminRec.content} proxied=${adminRec.proxied}`,
  );
  const target = adminRec.content; // <tunnel-id>.cfargotunnel.com

  const existing = await cf<DnsRecord[]>('GET', `/zones/${zone.id}/dns_records?name=${HOOKS}`);
  const body = { type: 'CNAME', name: 'hooks', content: target, proxied: true, ttl: 1 };
  if (existing[0]) {
    await cf('PUT', `/zones/${zone.id}/dns_records/${existing[0].id}`, body);
    console.log(`updated existing hooks record -> ${target} (proxied)`);
  } else {
    await cf('POST', `/zones/${zone.id}/dns_records`, body);
    console.log(`created hooks CNAME -> ${target} (proxied)`);
  }
  console.log('DONE — hooks.assuryalconseil.fr restored (voice webhook).');
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
