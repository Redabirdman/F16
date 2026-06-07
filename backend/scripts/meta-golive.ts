/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- standalone go-live ops script. */
/**
 * M12 go-live ops for the Assuryal Meta integration. Reads all values from
 * backend/.env. Discrete subcommands so each outward change is run + inspected
 * individually:
 *
 *   register <tunnelUrl>   POST /{app-id}/subscriptions  (object=page, leadgen)
 *   subscribe              POST /{page}/subscribed_apps   (subscribed_fields=leadgen)
 *   form                   POST /{page}/leadgen_forms     (test instant form, 5 fields)
 *   testlead <formId>      POST /{form}/test_leads        (generate a test lead)
 *   deliver <tunnel> <leadgenId>   sign + POST a leadgen webhook to our endpoint
 *
 * Prints Graph responses; never prints the token/secret.
 */
import 'dotenv/config';
import { createHmac } from 'node:crypto';

const env = process.env;
const API = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION || 'v21.0'}`;
const token = env.META_SYSTEM_USER_TOKEN || '';
const appId = env.META_APP_ID || '';
const appSecret = env.META_APP_SECRET || '';
const pageId = env.META_PAGE_ID || '';
const verifyToken = env.META_LEADGEN_VERIFY_TOKEN || '';

const proofFor = (t: string): string => createHmac('sha256', appSecret).update(t).digest('hex');

async function graph(
  method: string,
  path: string,
  params: Record<string, string> = {},
  tok: string = token,
): Promise<{ status: number; j: any }> {
  const u = new URL(API + path);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (method === 'GET') u.searchParams.set(k, v);
    else body.set(k, v);
  }
  u.searchParams.set('access_token', tok);
  u.searchParams.set('appsecret_proof', proofFor(tok));
  const init: any = { method };
  if (method !== 'GET') init.body = body;
  const r = await fetch(u, init);
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

async function pageToken(): Promise<string> {
  const r = await graph('GET', `/${pageId}`, { fields: 'access_token' });
  if (!r.j?.access_token) throw new Error(`no page token: ${JSON.stringify(r.j)}`);
  return r.j.access_token;
}

async function register(tunnel: string): Promise<void> {
  const callback = `${tunnel.replace(/\/+$/, '')}/v1/meta/leadgen-webhook`;
  const u = new URL(API + `/${appId}/subscriptions`);
  const body = new URLSearchParams({
    object: 'page',
    callback_url: callback,
    verify_token: verifyToken,
    fields: 'leadgen',
    include_values: 'true',
    access_token: `${appId}|${appSecret}`,
  });
  const r = await fetch(u, { method: 'POST', body });
  console.log('[register]', r.status, await r.text(), '\n  callback:', callback);
}

async function subscribe(): Promise<void> {
  const pt = await pageToken();
  const r = await graph('POST', `/${pageId}/subscribed_apps`, { subscribed_fields: 'leadgen' }, pt);
  console.log('[subscribe]', r.status, JSON.stringify(r.j));
}

async function form(): Promise<void> {
  const pt = await pageToken();
  const questions = JSON.stringify([
    { type: 'FULL_NAME' },
    { type: 'EMAIL' },
    { type: 'PHONE' },
    {
      type: 'CUSTOM',
      key: 'preferred_channel',
      label: 'Comment préférez-vous être contacté ?',
      options: [
        { key: 'whatsapp', value: 'Par WhatsApp' },
        { key: 'call', value: 'Par appel téléphonique' },
      ],
    },
    {
      type: 'CUSTOM',
      key: 'preferred_time',
      label: 'Quel moment vous convient ?',
      options: [
        { key: 'maintenant', value: 'Contactez-moi maintenant' },
        { key: 'matin', value: 'Le matin' },
        { key: 'apres_midi', value: "L'après-midi" },
        { key: 'soir', value: 'En soirée' },
      ],
    },
  ]);
  const r = await graph(
    'POST',
    `/${pageId}/leadgen_forms`,
    {
      name: 'F16 TEST trottinette (delete me)',
      questions,
      privacy_policy: JSON.stringify({
        url: 'https://assuryalconseil.fr',
        link_text: 'Politique de confidentialité',
      }),
      locale: 'fr_FR',
      follow_up_action_url: 'https://assuryalconseil.fr',
    },
    pt,
  );
  console.log('[form]', r.status, JSON.stringify(r.j));
}

async function testlead(formId: string): Promise<void> {
  const r = await graph('POST', `/${formId}/test_leads`, {});
  console.log('[testlead]', r.status, JSON.stringify(r.j));
}

async function deliver(tunnel: string, leadgenId: string): Promise<void> {
  const url = `${tunnel.replace(/\/+$/, '')}/v1/meta/leadgen-webhook`;
  const payload = JSON.stringify({
    object: 'page',
    entry: [
      {
        id: pageId,
        time: 0,
        changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: pageId } }],
      },
    ],
  });
  const sig = 'sha256=' + createHmac('sha256', appSecret).update(payload).digest('hex');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    body: payload,
  });
  console.log('[deliver]', r.status, await r.text());
}

async function delform(formId: string): Promise<void> {
  const pt = await pageToken();
  const u = new URL(API + `/${formId}`);
  u.searchParams.set('access_token', pt);
  u.searchParams.set('appsecret_proof', proofFor(pt));
  const r = await fetch(u, { method: 'DELETE' });
  console.log('[delform]', r.status, await r.text());
}

const [cmd, a, b] = process.argv.slice(2);
(async () => {
  if (cmd === 'register') await register(a!);
  else if (cmd === 'subscribe') await subscribe();
  else if (cmd === 'form') await form();
  else if (cmd === 'testlead') await testlead(a!);
  else if (cmd === 'deliver') await deliver(a!, b!);
  else if (cmd === 'delform') await delform(a!);
  else
    console.log(
      'usage: register <tunnel> | subscribe | form | testlead <formId> | deliver <tunnel> <leadgenId> | delform <formId>',
    );
})().catch((e) => {
  console.error('go-live step failed:', e);
  process.exit(1);
});
