/**
 * M10 live-call test harness (manual, local-only).
 *
 * Places ONE outbound verification call through the SAME production path the
 * voice-operator uses: putSession(sessionId → {leadId,customerId}) into the
 * shared Redis singleton (so Pipecat's session-lookup resolves it), then a
 * DIRECT ARI POST to context `f16-audiosocket` / exten `s` (NOT the production
 * asterisk-client, which targets f16-dial/exten=<number> and would re-Dial the
 * already-answered callee). The destination number lives in pipecat/.env
 * (TEST_DIAL_NUMBER) and is loaded here so it never hits the command line.
 *
 * Usage (run from backend/):
 *   npx tsx scripts/place-test-call.ts            # random plumbing lead → brain says "Pardon…"
 *   npx tsx scripts/place-test-call.ts reda       # dial AS the real "Reda" lead (full Sales Agent brain)
 *   npx tsx scripts/place-test-call.ts achraf     # dial AS the real "Achraf" lead
 *   npx tsx scripts/place-test-call.ts seed        # register both real leads, do NOT dial
 *
 * Real leads (Reda + Achraf) are seeded idempotently (lookup by phone hash);
 * an existing lead for the customer is REUSED so conversation history
 * accumulates across calls. The dialed number (TEST_DIAL_NUMBER) is the same
 * for both per Ridaa — only the lead identity the brain sees differs.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal .env loader — does NOT override values already in process.env. */
function loadEnv(path: string): void {
  let txt: string;
  try {
    txt = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

// backend/.env first (ARI + Redis + Postgres config), then pipecat/.env (dial #).
loadEnv(resolve(here, '..', '.env'));
loadEnv(resolve(here, '..', '..', 'pipecat', '.env'));

// Import AFTER env is populated so env-reading modules see the values.
const { createDb } = await import('../src/db/index.js');
const { insertCustomer, getCustomerByPhone } = await import('../src/db/repositories/customers.js');
const { putSession } = await import('../src/voice/session-store.js');
const { leads } = await import('../src/db/schema/leads.js');
const { eq, desc } = await import('drizzle-orm');

type Db = ReturnType<typeof createDb>;

/** Real testers Ridaa authorised as leads (2026-06-04). Same dial number. */
const REAL_LEADS: Record<string, { fullName: string; phone: string }> = {
  reda: { fullName: 'Reda Lefriyekh', phone: '212650012403' },
  achraf: { fullName: 'Achraf Mortady', phone: '212603576574' },
};

/** Ensure a customer + lead exist for a named tester; return their ids. */
async function ensureLead(db: Db, key: string): Promise<{ leadId: string; customerId: string }> {
  const info = REAL_LEADS[key];
  if (!info) throw new Error(`ensureLead: unknown lead "${key}"`);

  let customer = await getCustomerByPhone(db, info.phone);
  if (!customer) {
    customer = await insertCustomer(db, {
      fullName: info.fullName,
      phone: info.phone,
      civility: 'M.',
    });
    console.log(`seeded customer ${key} id=${customer.id}`);
  }

  // Reuse the customer's most recent lead so history accumulates across calls.
  const existing = await db
    .select()
    .from(leads)
    .where(eq(leads.customerId, customer.id))
    .orderBy(desc(leads.createdAt))
    .limit(1);
  let lead = existing[0];
  if (!lead) {
    const [ins] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'referral',
        productLine: 'scooter',
        status: 'new',
        score: null,
        rawPayload: { seededBy: 'place-test-call', tester: info.fullName },
      })
      .returning();
    lead = ins;
    console.log(`seeded lead ${key} id=${lead.id}`);
  }
  return { leadId: lead.id, customerId: customer.id };
}

/** Direct ARI originate into f16-audiosocket/s (the known-working entry). */
async function originate(sessionId: string): Promise<string> {
  const dial = process.env.TEST_DIAL_NUMBER;
  const ariUrl = (process.env.ASTERISK_ARI_URL ?? 'http://localhost:8088/ari').replace(/\/+$/, '');
  const ariUser = process.env.ASTERISK_ARI_USER ?? 'f16';
  const ariPassword = process.env.ASTERISK_ARI_PASSWORD;
  const trunk = process.env.ASTERISK_OVH_TRUNK ?? 'ovh-trunk';
  const callerId = process.env.VOICE_CALLER_ID ?? '+33184162750';
  const pipecatHost = process.env.AUDIOSOCKET_HOST ?? '127.0.0.1';
  const pipecatPort = process.env.AUDIOSOCKET_PORT ?? '9092';

  if (!dial) throw new Error('TEST_DIAL_NUMBER not set (pipecat/.env)');
  if (!ariPassword) throw new Error('ASTERISK_ARI_PASSWORD not set (backend/.env)');

  const body = {
    endpoint: `PJSIP/${dial}@${trunk}`,
    context: 'f16-audiosocket',
    extension: 's',
    priority: 1,
    callerId,
    timeout: 40,
    variables: {
      AS_UUID: sessionId,
      PIPECAT_HOST: pipecatHost,
      PIPECAT_PORT: pipecatPort,
    },
  };
  const auth = 'Basic ' + Buffer.from(`${ariUser}:${ariPassword}`).toString('base64');
  const res = await fetch(`${ariUrl}/channels`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ARI originate failed status=${res.status} body=${text}`);
  return (JSON.parse(text) as { id?: string }).id ?? '(unknown)';
}

/**
 * OpenAI Realtime NATIVE SIP path (M10 V2). Calls the customer via OVH and
 * bridges the answered leg to OpenAI's SIP endpoint (context f16-openai-bridge).
 * OpenAI handles ALL media; our backend webhook resolves this call's lead via
 * the X-F16-Session SIP header, which the dialplan stamps from the Asterisk
 * GLOBAL `F16SESSION`. We set that global over ARI right before originating.
 *
 * NOTE: the global is process-wide → safe for ONE call at a time (our test
 * cadence). Concurrent calls need a per-call header (follow-up); see the ruflo
 * native-SIP handoff.
 */
async function originateOpenai(sessionId: string): Promise<string> {
  const dial = process.env.TEST_DIAL_NUMBER;
  const ariUrl = (process.env.ASTERISK_ARI_URL ?? 'http://localhost:8088/ari').replace(/\/+$/, '');
  const ariUser = process.env.ASTERISK_ARI_USER ?? 'f16';
  const ariPassword = process.env.ASTERISK_ARI_PASSWORD;
  const trunk = process.env.ASTERISK_OVH_TRUNK ?? 'ovh-trunk';
  const callerId = process.env.VOICE_CALLER_ID ?? '+33184162750';

  if (!dial) throw new Error('TEST_DIAL_NUMBER not set (pipecat/.env)');
  if (!ariPassword) throw new Error('ASTERISK_ARI_PASSWORD not set (backend/.env)');
  const auth = 'Basic ' + Buffer.from(`${ariUser}:${ariPassword}`).toString('base64');

  // 1. Set the global the dialplan stamps onto the OpenAI INVITE header.
  const gv = await fetch(
    `${ariUrl}/asterisk/variable?variable=F16SESSION&value=${encodeURIComponent(sessionId)}`,
    { method: 'POST', headers: { authorization: auth } },
  );
  if (!gv.ok) throw new Error(`ARI set global failed status=${gv.status}`);

  // 2. Originate to the customer; the bridge context dials OpenAI on answer.
  const body = {
    endpoint: `PJSIP/${dial}@${trunk}`,
    context: 'f16-openai-bridge',
    extension: 's',
    priority: 1,
    callerId,
    timeout: 90,
    variables: { AS_UUID: sessionId },
  };
  const res = await fetch(`${ariUrl}/channels`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ARI originate failed status=${res.status} body=${text}`);
  return (JSON.parse(text) as { id?: string }).id ?? '(unknown)';
}

async function main(): Promise<void> {
  // Args: `openai [reda|achraf]` → native-SIP path; else `[reda|achraf|seed]`
  // → cascade path (legacy). The OpenAI path is the V1 voice channel.
  const rawArgs = process.argv.slice(2).map((s) => s.toLowerCase());
  const useOpenai = rawArgs[0] === 'openai';
  const arg = (useOpenai ? rawArgs[1] : rawArgs[0]) ?? '';
  const db = createDb(process.env.DATABASE_URL ?? '');

  // Register-only mode: seed both real leads, no call.
  if (arg === 'seed') {
    const r = await ensureLead(db, 'reda');
    const a = await ensureLead(db, 'achraf');
    console.log(JSON.stringify({ ok: true, seeded: { reda: r, achraf: a } }));
    return;
  }

  // Resolve the identity the brain will see.
  let ids: { leadId: string; customerId: string };
  if (arg in REAL_LEADS) {
    ids = await ensureLead(db, arg);
  } else {
    // Plumbing test: random ids → brain returns "Pardon, pouvez-vous répéter ?"
    ids = { leadId: randomUUID(), customerId: randomUUID() };
  }

  const sessionId = randomUUID();
  await putSession(sessionId, ids);
  const channelId = useOpenai ? await originateOpenai(sessionId) : await originate(sessionId);

  // No PII (the dialed number) is printed.
  console.log(
    JSON.stringify({
      ok: true,
      path: useOpenai ? 'openai-native-sip' : 'cascade',
      lead: arg || 'random',
      sessionId,
      channelId,
      ...ids,
    }),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('place-test-call: failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
