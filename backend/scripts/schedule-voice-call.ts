/**
 * Emit a VOICE.CALL_SCHEDULED intent — the autonomous outbound entrypoint.
 *
 * This is the real production trigger (the Engagement Agent / a "call me"
 * request emits the same intent): the running backend's voice-operator consumes
 * it from the `voice` queue and originates the call via the OpenAI native-SIP
 * bridge (F16_VOICE_NATIVE_SIP default on). Use it to drive an end-to-end
 * autonomous test without the manual ARI script.
 *
 * Usage (run from backend/, with the backend + workers already running):
 *   npx tsx scripts/schedule-voice-call.ts voicetest   # dial the dedicated VOICE test line (+33757818787) — use this for voice tests
 *   npx tsx scripts/schedule-voice-call.ts test         # dial TEST_DIAL_NUMBER, falling back to the voice test line
 *   npx tsx scripts/schedule-voice-call.ts reda         # dial the real Reda lead's DB phone (212… = WhatsApp; NOT a voice line)
 *
 * NOTE: the voice-operator dials the CUSTOMER'S DB phone (production-correct).
 * `voicetest`/`test` use a customer whose phone is the voice test handset so it
 * rings the right device; `reda`/`achraf` dial their real 212… numbers, which
 * are WhatsApp-only and NOT reachable for voice — the script warns if you do.
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

loadEnv(resolve(here, '..', '.env'));
loadEnv(resolve(here, '..', '..', 'pipecat', '.env'));

const { createDb } = await import('../src/db/index.js');
const { insertCustomer, getCustomerByPhone } = await import('../src/db/repositories/customers.js');
const { sendMessage } = await import('../src/messaging/dispatcher.js');
const { leads } = await import('../src/db/schema/leads.js');
const { eq, desc } = await import('drizzle-orm');

type Db = ReturnType<typeof createDb>;

/**
 * The dedicated VOICE test line — +33 7 57 81 87 87, in OVH 00-international
 * form. This is the number to call for voice tests. The 212… numbers below are
 * WhatsApp-only and are NOT reachable over the voice trunk.
 */
const VOICE_TEST_NUMBER = '0033757818787';

const NAMED_TARGETS: Record<string, { fullName: string; phone: string }> = {
  reda: { fullName: 'Reda Lefriyekh', phone: '212650012403' },
  achraf: { fullName: 'Achraf Mortady', phone: '212603576574' },
  // Explicit, env-independent voice-test target → always dials the real voice
  // line, regardless of whether TEST_DIAL_NUMBER is set in the environment.
  voicetest: { fullName: 'Voice Test', phone: VOICE_TEST_NUMBER },
};

async function ensure(
  db: Db,
  fullName: string,
  phone: string,
): Promise<{ leadId: string; customerId: string }> {
  let customer = await getCustomerByPhone(db, phone);
  if (!customer) {
    customer = await insertCustomer(db, { fullName, phone, civility: 'M.' });
  }
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
        rawPayload: { seededBy: 'schedule-voice-call' },
      })
      .returning();
    lead = ins;
  }
  return { leadId: lead.id, customerId: customer.id };
}

async function main(): Promise<void> {
  const arg = (process.argv[2] ?? 'test').toLowerCase();
  const db = createDb(process.env.DATABASE_URL ?? '');

  let ids: { leadId: string; customerId: string };
  let toNumber: string;
  if (arg in NAMED_TARGETS) {
    const info = NAMED_TARGETS[arg];
    ids = await ensure(db, info.fullName, info.phone);
    toNumber = info.phone;
  } else {
    // `test` → a dedicated customer whose phone is the test handset. Prefer
    // TEST_DIAL_NUMBER from the env, but fall back to the canonical voice test
    // line so a missing env var doesn't block a voice test.
    const testPhone = process.env.TEST_DIAL_NUMBER ?? VOICE_TEST_NUMBER;
    ids = await ensure(db, 'Voice Test', testPhone);
    toNumber = testPhone;
  }

  // Guardrail: 212… numbers are WhatsApp-only on this stack and will not ring
  // over the voice trunk. Warn loudly rather than silently placing a dead call.
  if (toNumber.replace(/[^\d]/g, '').startsWith('212')) {
    console.warn(
      `⚠️  ${toNumber} is a 212 (WhatsApp-only) number — it is NOT reachable for voice. ` +
        `Use 'voicetest' (dials ${VOICE_TEST_NUMBER}) for a real voice test.`,
    );
  }

  const callId = randomUUID();
  await sendMessage(
    { db },
    {
      fromRole: 'cli',
      toRole: 'voice-operator',
      intent: 'VOICE.CALL_SCHEDULED',
      payload: {
        callId,
        customerId: ids.customerId,
        toNumber,
        scheduledAt: new Date().toISOString(),
      },
      correlationId: ids.leadId,
    },
  );

  console.log(JSON.stringify({ ok: true, scheduled: arg, callId, ...ids }));
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('schedule-voice-call: failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
