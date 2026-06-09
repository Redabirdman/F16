/* eslint-disable no-console -- standalone infra setup. */
/**
 * M17 — Cloudflare WAF skip rule for the webhook subdomain (infra-as-code).
 *
 * The `hooks.assuryalconseil.fr` subdomain serves ONLY machine-to-machine
 * webhooks (OpenAI realtime.call.incoming, Meta leadgen, WAHA) — no browsers.
 * Cloudflare's "Block AI bots" managed rule was 403-ing OpenAI's webhook (it
 * comes from OpenAI infra → flagged as an AI bot), which silently broke voice.
 *
 * This creates/updates a custom firewall rule that SKIPS bot + managed + legacy
 * security for that hostname only — the apex/www marketing site keeps full
 * protection. Idempotent (keyed by description). Reads CLOUDFLARE_API_TOKEN +
 * CLOUDFLARE_ZONE_ID from backend/.env.
 *
 *   npx tsx scripts/cf-webhook-skip-rule.ts
 */
import 'dotenv/config';

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';
const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID ?? '';
const HOSTNAME = process.env.F16_PUBLIC_HOSTNAME ?? 'hooks.assuryalconseil.fr';
const DESC = 'F16 webhooks — skip security (machine-to-machine; OpenAI/Meta/WAHA)';

if (!TOKEN || !ZONE_ID) {
  console.error('missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID in .env');
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
  if (!json.success) throw new Error(`CF ${method} ${path} -> ${JSON.stringify(json.errors)}`);
  return json.result;
}

const skipRule = {
  action: 'skip',
  action_parameters: {
    ruleset: 'current',
    phases: ['http_request_sbfm', 'http_request_firewall_managed'],
    products: ['bic', 'hot', 'securityLevel', 'rateLimit', 'uaBlock', 'zoneLockdown', 'waf'],
  },
  expression: `(http.host eq "${HOSTNAME}")`,
  description: DESC,
  enabled: true,
};

interface Ruleset {
  id: string;
  rules?: Array<{ description?: string }>;
}

async function main(): Promise<void> {
  const phasePath = `/zones/${ZONE_ID}/rulesets/phases/http_request_firewall_custom/entrypoint`;
  let existing: Ruleset | null = null;
  try {
    existing = await cf<Ruleset>('GET', phasePath);
  } catch {
    existing = null; // no custom ruleset yet
  }

  const others = (existing?.rules ?? []).filter((r) => r.description !== DESC);
  // Skip rule FIRST so it short-circuits before any block rule.
  const rules = [skipRule, ...others];
  await cf('PUT', phasePath, { rules });
  console.log(`✅ WAF skip rule applied for ${HOSTNAME} (${rules.length} custom rule(s) total)`);
  console.log('   OpenAI/Meta/WAHA webhooks to this subdomain now bypass bot+managed security.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
