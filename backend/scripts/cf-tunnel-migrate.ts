/* eslint-disable no-console -- standalone infra migration. */
/**
 * Migrate the F16 tunnel onto the SAME account as the zone + Access.
 *
 * The original `f16` tunnel lives on a different Cloudflare account than the
 * assuryalconseil.fr zone (which was moved to the Access account), so the
 * admin/hooks CNAMEs → <tunnel>.cfargotunnel.com were cross-account and gave
 * Error 1033. This creates (or reuses) a remotely-managed tunnel on the zone's
 * account, sets the ingress, repoints admin + hooks DNS at it, and writes the
 * new run-token/ids into backend/.env. Idempotent.
 *
 *   npx tsx scripts/cf-tunnel-migrate.ts   # then restart cloudflared
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';
const ZONE_NAME = 'assuryalconseil.fr';
const TUNNEL_NAME = 'f16-admin';
const ADMIN = 'admin.assuryalconseil.fr';
const HOOKS = 'hooks.assuryalconseil.fr';
const SVC_BACKEND = 'http://localhost:3001';
const SVC_ADMIN = 'http://localhost:5173';

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

/** Persist keys to .env via the blessed scripts/update-env.ts (no direct write). */
function setEnv(updates: Record<string, string>): void {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(updates)) env[`SETENV_${k}`] = v;
  const r = spawnSync('npx', ['tsx', 'scripts/update-env.ts'], {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error('update-env.ts failed');
}

interface Tunnel {
  id: string;
  name: string;
}
interface DnsRecord {
  id: string;
}

async function upsertDns(zoneId: string, sub: string, target: string): Promise<void> {
  const name = `${sub}.${ZONE_NAME}`;
  const existing = await cf<DnsRecord[]>('GET', `/zones/${zoneId}/dns_records?name=${name}`);
  const body = { type: 'CNAME', name: sub, content: target, proxied: true, ttl: 1 };
  if (existing[0]) {
    await cf('PUT', `/zones/${zoneId}/dns_records/${existing[0].id}`, body);
    console.log(`DNS ${name} -> ${target} (updated)`);
  } else {
    await cf('POST', `/zones/${zoneId}/dns_records`, body);
    console.log(`DNS ${name} -> ${target} (created)`);
  }
}

async function main(): Promise<void> {
  const accts = await cf<Array<{ id: string; name: string }>>('GET', '/accounts');
  const acct = accts[0];
  if (!acct) {
    console.error('no accessible account');
    process.exit(1);
    return;
  }
  const ACCOUNT_ID = acct.id;
  console.log(`account ${ACCOUNT_ID} ("${acct.name}")`);

  const zones = await cf<Array<{ id: string; name: string }>>('GET', `/zones?name=${ZONE_NAME}`);
  const zone = zones[0];
  if (!zone) {
    console.error(`zone ${ZONE_NAME} not on this account`);
    process.exit(1);
    return;
  }
  console.log(`zone ${ZONE_NAME} id=${zone.id}`);

  // Create or reuse a remotely-managed tunnel.
  const found = await cf<Tunnel[]>(
    'GET',
    `/accounts/${ACCOUNT_ID}/cfd_tunnel?name=${TUNNEL_NAME}&is_deleted=false`,
  );
  let tunnel = found[0];
  if (tunnel) {
    console.log(`reusing tunnel ${TUNNEL_NAME} (${tunnel.id})`);
  } else {
    tunnel = await cf<Tunnel>('POST', `/accounts/${ACCOUNT_ID}/cfd_tunnel`, {
      name: TUNNEL_NAME,
      config_src: 'cloudflare',
    });
    console.log(`created tunnel ${TUNNEL_NAME} (${tunnel.id})`);
  }
  const token = await cf<string>('GET', `/accounts/${ACCOUNT_ID}/cfd_tunnel/${tunnel.id}/token`);
  const target = `${tunnel.id}.cfargotunnel.com`;

  // Ingress: admin app + its API/WS + the voice webhook host.
  await cf('PUT', `/accounts/${ACCOUNT_ID}/cfd_tunnel/${tunnel.id}/configurations`, {
    config: {
      ingress: [
        { hostname: ADMIN, path: '^/(v1/admin|ws)(/|$)', service: SVC_BACKEND },
        { hostname: ADMIN, service: SVC_ADMIN },
        { hostname: HOOKS, service: SVC_BACKEND },
        { service: 'http_status:404' },
      ],
    },
  });
  console.log('ingress set: admin (app+api/ws) + hooks');

  await upsertDns(zone.id, 'admin', target);
  await upsertDns(zone.id, 'hooks', target);

  setEnv({
    CLOUDFLARE_TUNNEL_TOKEN: token,
    CLOUDFLARE_TUNNEL_ID: tunnel.id,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CLOUDFLARE_ZONE_ID: zone.id,
  });
  console.log('wrote CLOUDFLARE_TUNNEL_TOKEN / _ID / ACCOUNT_ID / ZONE_ID to .env');
  console.log('\nDONE. Restart cloudflared so it runs the new tunnel token.');
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
