/* eslint-disable no-console -- standalone infra setup. */
/**
 * Cloudflare Access — create the Google identity provider and confirm the
 * `admin.assuryalconseil.fr` app will offer it (replaces the flaky one-time-PIN
 * email login). Idempotent: re-running updates the existing Google IdP.
 *
 * Reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from backend/.env (the
 * token needs Account: Access: Identity Providers: Edit + Apps and Policies:
 * Edit). Google OAuth client id/secret come from GOOGLE_OAUTH_CLIENT_ID /
 * GOOGLE_OAUTH_CLIENT_SECRET (env). Secrets are never printed.
 *
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
 *     npx tsx scripts/cf-access-google-idp.ts
 */
import 'dotenv/config';

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';
// The Access org lives in the account this token is scoped to — resolve it
// from /accounts rather than CLOUDFLARE_ACCOUNT_ID (which targets a different
// account used for the tunnel/zone).
let ACCOUNT_ID = process.env.CF_ACCESS_ACCOUNT_ID ?? '';
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';
const ADMIN_DOMAIN = process.env.F16_ADMIN_HOSTNAME ?? 'admin.assuryalconseil.fr';

if (!TOKEN) {
  console.error('missing CLOUDFLARE_API_TOKEN in .env');
  process.exit(1);
}
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in env');
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

interface Idp {
  id: string;
  name: string;
  type: string;
}
interface AccessApp {
  id?: string;
  uid?: string;
  name: string;
  domain?: string;
  self_hosted_domains?: string[];
  allowed_idps?: string[] | null;
  auto_redirect_to_identity?: boolean;
}

async function main(): Promise<void> {
  // 0. Resolve the account the token is scoped to (where the Access org lives).
  if (!ACCOUNT_ID) {
    const accts = await cf<Array<{ id: string; name: string }>>('GET', '/accounts');
    const acct = accts[0];
    if (accts.length !== 1 || !acct) {
      console.error(
        `expected exactly 1 accessible account, got ${accts.length}; set CF_ACCESS_ACCOUNT_ID`,
      );
      process.exit(1);
      return;
    }
    ACCOUNT_ID = acct.id;
    console.log(`using account ${ACCOUNT_ID} ("${acct.name}")`);
  }
  // Verify the token has Access scope by listing IdPs.
  const idps = await cf<Idp[]>('GET', `/accounts/${ACCOUNT_ID}/access/identity_providers`);
  console.log(
    `token OK — ${idps.length} existing identity provider(s): ${idps.map((i) => `${i.name}(${i.type})`).join(', ') || '(none)'}`,
  );

  // 1. Create or update the Google IdP.
  const existing = idps.find((i) => i.type === 'google');
  const idpBody = {
    name: 'Google',
    type: 'google',
    config: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
  };
  let googleIdp: Idp;
  if (existing) {
    googleIdp = await cf<Idp>(
      'PUT',
      `/accounts/${ACCOUNT_ID}/access/identity_providers/${existing.id}`,
      idpBody,
    );
    console.log(`updated existing Google IdP: ${googleIdp.id}`);
  } else {
    googleIdp = await cf<Idp>('POST', `/accounts/${ACCOUNT_ID}/access/identity_providers`, idpBody);
    console.log(`created Google IdP: ${googleIdp.id}`);
  }

  // 2. Find the admin Access app + report whether it will offer Google.
  const apps = await cf<AccessApp[]>('GET', `/accounts/${ACCOUNT_ID}/access/apps`);
  const adminApp = apps.find(
    (a) => a.domain === ADMIN_DOMAIN || (a.self_hosted_domains ?? []).includes(ADMIN_DOMAIN),
  );
  if (!adminApp) {
    console.log(
      `WARN: no Access app found for ${ADMIN_DOMAIN}; Google IdP is created but unattached.`,
    );
    return;
  }
  const uid = adminApp.uid ?? adminApp.id ?? '';
  const allowed = adminApp.allowed_idps;
  console.log(
    `admin app "${adminApp.name}" uid=${uid} allowed_idps=${JSON.stringify(allowed)} auto_redirect=${adminApp.auto_redirect_to_identity}`,
  );

  if (allowed && allowed.length === 1 && allowed[0] === googleIdp.id) {
    console.log('admin app already uses only the Google IdP. Done.');
  } else {
    // Force Google as the single login method (OTP email is unreliable) and
    // keep auto_redirect so opening the URL goes straight to Google. Preserve
    // everything else incl. policies by round-tripping the full app object.
    const full = await cf<AccessApp & Record<string, unknown>>(
      'GET',
      `/accounts/${ACCOUNT_ID}/access/apps/${uid}`,
    );
    const body = { ...full, allowed_idps: [googleIdp.id], auto_redirect_to_identity: true };
    delete (body as Record<string, unknown>).uid;
    delete (body as Record<string, unknown>).id;
    delete (body as Record<string, unknown>).aud;
    delete (body as Record<string, unknown>).created_at;
    delete (body as Record<string, unknown>).updated_at;
    await cf('PUT', `/accounts/${ACCOUNT_ID}/access/apps/${uid}`, body);
    console.log(
      'admin app now uses Google as its single login method (auto-redirect on; policies preserved).',
    );
  }
  // 3. Ensure an Allow policy restricts the app to the two operator emails.
  const ALLOWED_EMAILS = (
    process.env.ADMIN_ALLOWED_EMAILS ?? 'ridaa.birdman@gmail.com,Achraf.mortady@gmail.com'
  )
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const policies = await cf<Array<{ id: string; name: string; decision: string }>>(
    'GET',
    `/accounts/${ACCOUNT_ID}/access/apps/${uid}/policies`,
  );
  if (policies.some((p) => p.decision === 'allow')) {
    console.log(`admin app already has ${policies.length} policy(ies); leaving as-is.`);
  } else {
    await cf('POST', `/accounts/${ACCOUNT_ID}/access/apps/${uid}/policies`, {
      name: 'Admins',
      decision: 'allow',
      include: ALLOWED_EMAILS.map((email) => ({ email: { email } })),
    });
    console.log(`created Allow policy for: ${ALLOWED_EMAILS.join(', ')}`);
  }
  console.log('\nDONE. Open https://' + ADMIN_DOMAIN + ' → "Sign in with Google".');
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
