/* eslint-disable no-console, @typescript-eslint/no-explicit-any -- standalone ops/verify script: console output is the point, and Graph responses are untyped. */
/**
 * Verify the Meta System User token + asset access (M12).
 *
 * Loads .env the same way the backend runtime does (dotenv, first-occurrence
 * wins) so it surfaces any duplicate-key shadowing. Prints token scopes +
 * /me + ad-account + page access. Pass `--subscribe` to subscribe the
 * Assuryal Page to the `leadgen` webhook field.
 *
 * Run: npx tsx scripts/verify-meta-access.ts [--subscribe]
 *
 * Prints only value LENGTHS + short prefixes for secrets — never the full token.
 */
import 'dotenv/config';
import { createHmac } from 'node:crypto';

const env = process.env;
const API = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION || 'v21.0'}`;
const token = env.META_SYSTEM_USER_TOKEN || '';
const appId = env.META_APP_ID || '';
const appSecret = env.META_APP_SECRET || '';

function proofFor(t: string): string {
  return appSecret ? createHmac('sha256', appSecret).update(t).digest('hex') : '';
}

async function g(
  path: string,
  params: Record<string, string> = {},
  tok: string = token,
): Promise<{ status: number; j: any }> {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', tok);
  const p = proofFor(tok);
  if (p) u.searchParams.set('appsecret_proof', p);
  const r = await fetch(u);
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

async function main(): Promise<void> {
  console.log('--- effective META_* env (first-wins, prefixes only) ---');
  for (const k of Object.keys(env)
    .filter((k) => k.startsWith('META_'))
    .sort()) {
    const v = env[k] ?? '';
    console.log(`${k}  len=${v.length}  prefix=${v.slice(0, 8)}`);
  }

  // 1. Token scopes via /debug_token (uses the app token).
  const dbgUrl = new URL(API + '/debug_token');
  dbgUrl.searchParams.set('input_token', token);
  dbgUrl.searchParams.set('access_token', `${appId}|${appSecret}`);
  const dbg = await (await fetch(dbgUrl)).json().catch(() => ({}));
  const data = (dbg as any).data ?? {};
  console.log('\n--- debug_token ---');
  console.log('valid:', data.is_valid, '| type:', data.type, '| app_id:', data.app_id);
  console.log('expires_at:', data.expires_at, '(0 = never)');
  console.log('scopes:', (data.scopes ?? []).join(', '));

  // 2. /me
  const me = await g('/me', { fields: 'id,name' });
  console.log('\n--- /me ---', me.status, JSON.stringify(me.j));

  // 3. Ad account
  const acct = await g(`/act_${env.META_AD_ACCOUNT_ID}`, {
    fields: 'name,currency,account_status,amount_spent',
  });
  console.log('--- ad account ---', acct.status, JSON.stringify(acct.j));

  // 4. Page access — presence of a page access_token proves manage access.
  const page = await g(`/${env.META_PAGE_ID}`, { fields: 'name,access_token' });
  const pageToken: string | undefined = page.j?.access_token;
  console.log('--- page ---', page.status, 'name:', page.j?.name, 'pageToken:', Boolean(pageToken));

  // 5. Optional: subscribe the page to leadgen.
  if (process.argv.includes('--subscribe')) {
    if (!pageToken) {
      console.log('\n[subscribe] SKIPPED — no page access token (check page assignment + scopes)');
      return;
    }
    const u = new URL(API + `/${env.META_PAGE_ID}/subscribed_apps`);
    u.searchParams.set('subscribed_fields', 'leadgen');
    u.searchParams.set('access_token', pageToken);
    const p = proofFor(pageToken);
    if (p) u.searchParams.set('appsecret_proof', p);
    const r = await fetch(u, { method: 'POST' });
    console.log('\n[subscribe leadgen]', r.status, await r.text());

    // Confirm the subscription.
    const check = await g(`/${env.META_PAGE_ID}/subscribed_apps`, {}, pageToken);
    console.log('[subscribed_apps]', check.status, JSON.stringify(check.j));
  }
}

main().catch((e) => {
  console.error('verify failed:', e);
  process.exit(1);
});
