/* eslint-disable no-console -- standalone infra setup. */
/**
 * M17 — stable Cloudflare named tunnel (infra-as-code).
 *
 * Creates (or reuses) a remotely-managed `f16` tunnel, points
 * hooks.assuryalconseil.fr → http://localhost:3001, creates the proxied
 * CNAME, and writes the run-token + stable URL back to .env / .tools so the
 * launcher can `cloudflared tunnel run --token <token>` forever — no more
 * random TryCloudflare URLs.
 *
 * Idempotent: re-running reuses the tunnel, re-applies the ingress config, and
 * upserts the DNS record. Reads CLOUDFLARE_API_TOKEN/ZONE_ID/ACCOUNT_ID from
 * backend/.env (a scoped token: Account:Cloudflare Tunnel:Edit + Zone:DNS:Edit
 * + Zone:Zone:Read).
 *
 *   npx tsx scripts/cf-tunnel-setup.ts
 */
import 'dotenv/config';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';
const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID ?? '';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const TUNNEL_NAME = process.env.CLOUDFLARE_TUNNEL_NAME ?? 'f16';
const HOSTNAME = process.env.F16_PUBLIC_HOSTNAME ?? 'hooks.assuryalconseil.fr';
const SERVICE = 'http://localhost:3001';
// Admin UI host (gated by Cloudflare Access). The admin app is served as static
// on :5173; its API (/v1/admin) + realtime (/ws) go straight to the backend.
const ADMIN_HOSTNAME = process.env.F16_ADMIN_HOSTNAME ?? 'admin.assuryalconseil.fr';
const ADMIN_APP_SERVICE = 'http://localhost:5173';

if (!TOKEN || !ZONE_ID || !ACCOUNT_ID) {
  console.error(
    'missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID / CLOUDFLARE_ACCOUNT_ID in .env',
  );
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
  if (!json.success) {
    throw new Error(`CF ${method} ${path} -> ${res.status}: ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

/** Set/append a key in backend/.env in place (mirrors update-env.ts). */
function setEnv(updates: Record<string, string>): void {
  const path = '.env';
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
}

async function main(): Promise<void> {
  // 1. Find or create the tunnel (remotely-managed → config_src=cloudflare).
  const existing = await cf<Array<{ id: string; name: string }>>(
    'GET',
    `/accounts/${ACCOUNT_ID}/cfd_tunnel?name=${encodeURIComponent(TUNNEL_NAME)}&is_deleted=false`,
  );
  let tunnelId: string;
  if (existing.length > 0 && existing[0]) {
    tunnelId = existing[0].id;
    console.log(`reusing tunnel ${TUNNEL_NAME} (${tunnelId})`);
  } else {
    const created = await cf<{ id: string }>('POST', `/accounts/${ACCOUNT_ID}/cfd_tunnel`, {
      name: TUNNEL_NAME,
      config_src: 'cloudflare',
    });
    tunnelId = created.id;
    console.log(`created tunnel ${TUNNEL_NAME} (${tunnelId})`);
  }

  // 2. Run-token (what `cloudflared tunnel run --token` consumes).
  const runToken = await cf<string>('GET', `/accounts/${ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`);

  // 3. Ingress config — path-ordered. Admin host: /v1/admin + /ws → backend,
  //    everything else → the static admin app. Hooks host → backend. Else 404.
  await cf('PUT', `/accounts/${ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`, {
    config: {
      ingress: [
        { hostname: ADMIN_HOSTNAME, path: '^/(v1/admin|ws)(/|$)', service: SERVICE },
        { hostname: ADMIN_HOSTNAME, service: ADMIN_APP_SERVICE },
        { hostname: HOSTNAME, service: SERVICE },
        { service: 'http_status:404' },
      ],
    },
  });
  console.log(`ingress set: ${HOSTNAME} -> ${SERVICE}; ${ADMIN_HOSTNAME} -> app+api`);

  // 4. DNS CNAMEs (proxied) → <tunnelId>.cfargotunnel.com. Upsert each host.
  const cname = `${tunnelId}.cfargotunnel.com`;
  async function upsertCname(hostname: string): Promise<void> {
    const records = await cf<Array<{ id: string; name: string }>>(
      'GET',
      `/zones/${ZONE_ID}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    );
    const recBody = { type: 'CNAME', name: hostname, content: cname, proxied: true, ttl: 1 };
    if (records.length > 0 && records[0]) {
      await cf('PUT', `/zones/${ZONE_ID}/dns_records/${records[0].id}`, recBody);
      console.log(`updated CNAME ${hostname} -> ${cname}`);
    } else {
      await cf('POST', `/zones/${ZONE_ID}/dns_records`, recBody);
      console.log(`created CNAME ${hostname} -> ${cname}`);
    }
  }
  await upsertCname(HOSTNAME);
  await upsertCname(ADMIN_HOSTNAME);

  // 5. Persist the run-token + stable URL.
  const publicUrl = `https://${HOSTNAME}`;
  setEnv({ CLOUDFLARE_TUNNEL_TOKEN: runToken, CLOUDFLARE_TUNNEL_ID: tunnelId });
  const urlFile = '../.tools/tunnel-url.txt';
  if (!existsSync(dirname(urlFile))) mkdirSync(dirname(urlFile), { recursive: true });
  writeFileSync(urlFile, publicUrl);

  console.log('\n✅ tunnel ready');
  console.log(`   public URL: ${publicUrl}`);
  console.log('   wrote CLOUDFLARE_TUNNEL_TOKEN + CLOUDFLARE_TUNNEL_ID to backend/.env');
  console.log(`   wrote ${publicUrl} to .tools/tunnel-url.txt`);
  console.log('\nRun the tunnel:  cloudflared tunnel run --token $CLOUDFLARE_TUNNEL_TOKEN');
}

main().then(
  () => setTimeout(() => process.exit(0), 50),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    setTimeout(() => process.exit(1), 50);
  },
);
