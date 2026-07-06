/**
 * Reporter Agent — English decision-ready group messages (2026-07-05).
 *
 * Two tiers:
 *   - Pure-function tests (no DB): titles, severity badges, error-code
 *     translation, UUID stripping, draft splitting, message layout.
 *   - DB-gated tests (TEST_DATABASE_URL): customer-context resolution via
 *     quote-id and lead-id correlations, incl. the SIMULATION banner.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import { leads, quotes } from '../../../src/db/schema/index.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import {
  buildHumanActionRequestMessage,
  buildHumanActionResolvedMessage,
  explainErrorCode,
  intentTitleEn,
  optionsBlockEn,
  resolveActionContext,
  severityBadgeEn,
  shortRef,
  splitDraft,
  stripUuids,
  HUMAN_ACTION_DRAFT_MARKER,
} from '../../../src/agents/reporter-agent/humanize.js';
import type { HumanAction } from '../../../src/db/schema/agent-runtime.js';

const pgUrl = process.env.TEST_DATABASE_URL;

let savedPiiKey: string | undefined;
beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
});
afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
});

/** A db stub that must never be touched (non-UUID correlations short-circuit). */
const NO_DB = {} as unknown as Database;

function baseAction(overrides: Partial<HumanAction>): HumanAction {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    createdByAgent: 'sales-agent#singleton',
    intent: 'QUOTE_FAILED',
    severity: 2,
    summary: 'placeholder',
    options: [
      { id: 'retry', label: 'Retry the quote', kind: 'approve' },
      { id: 'abandon', label: 'Abandon this lead', kind: 'reject' },
    ],
    correlationId: 'not-a-uuid',
    status: 'pending',
    dueAt: null,
    resolvedBy: null,
    resolvedSource: null,
    resolution: null,
    createdAt: new Date('2026-07-05T08:00:00Z'),
    resolvedAt: null,
    escalatedAt: null,
    ...overrides,
  } as HumanAction;
}

describe('pure helpers', () => {
  it('shortRef takes the first 8 chars with a # prefix', () => {
    expect(shortRef('22222222-2222-4222-8222-222222222222')).toBe('#22222222');
  });

  it('stripUuids replaces embedded UUIDs with short refs', () => {
    const s = stripUuids('quote 1a2b3c4d-1111-4111-8111-999999999999 failed');
    expect(s).toBe('quote #1a2b3c4d failed');
  });

  it('splitDraft splits the ---DRAFT--- payload off the summary', () => {
    const { summary, draft } = splitDraft(`blocked (rule).${HUMAN_ACTION_DRAFT_MARKER}Bonjour !`);
    expect(summary).toBe('blocked (rule).');
    expect(draft).toBe('Bonjour !');
    expect(splitDraft('no draft here').draft).toBeNull();
  });

  it('severityBadgeEn maps 1/2/3 to English badges', () => {
    expect(severityBadgeEn(1)).toEqual({ glyph: '🔴', label: 'CRITICAL' });
    expect(severityBadgeEn(2)).toEqual({ glyph: '🟡', label: 'ACTION NEEDED' });
    expect(severityBadgeEn(3)).toEqual({ glyph: '🟢', label: 'FYI' });
  });

  it('intentTitleEn maps known intents and falls back to the raw code', () => {
    expect(intentTitleEn('QUOTE_FAILED')).toBe('Quote failed');
    expect(intentTitleEn('COMPLIANCE_BLOCKED')).toBe('Message blocked — approval needed');
    expect(intentTitleEn('LEAD_DORMANT')).toBe('Lead gone quiet 7 days');
    expect(intentTitleEn('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('optionsBlockEn numbers labels and returns null when empty', () => {
    const text = optionsBlockEn([
      { id: 'a', label: 'Retry the quote', kind: 'approve' },
      { id: 'b', label: 'Abandon', kind: 'reject' },
    ]);
    expect(text).toContain('Reply with the number:');
    expect(text).toContain('1. Retry the quote');
    expect(text).toContain('2. Abandon');
    expect(optionsBlockEn([])).toBeNull();
  });
});

describe('explainErrorCode', () => {
  it('translates the Maxance no-active-tab login failure', () => {
    expect(explainErrorCode('login_failed:maxance_extension_no_active_tab')).toContain(
      'Maxance portal unreachable',
    );
    expect(explainErrorCode('subscription_login_failed:timeout')).toContain(
      'Maxance portal unreachable',
    );
  });
  it('translates extension-connectivity failures', () => {
    expect(explainErrorCode('maxance_extension_not_connected')).toContain(
      'Chrome extension driving Maxance is not connected',
    );
    expect(explainErrorCode('extension_forward_failed')).toContain(
      'Chrome extension driving Maxance is not connected',
    );
  });
  it('translates garanties-step failures', () => {
    expect(explainErrorCode('maxance_garanties_zone_missing')).toContain('guarantees step');
  });
  it('translates the RIB rejection', () => {
    expect(explainErrorCode('maxance_subscription_rib_rejected')).toContain('bank details (RIB)');
  });
  it('translates the maintenance page (also when wrapped in login_failed)', () => {
    expect(explainErrorCode('maxance_maintenance')).toContain('maintenance page');
    expect(explainErrorCode('login_failed:maxance_maintenance')).toContain(
      'retry automatically when it reopens',
    );
  });
  it('falls back to "technical error (<code>)" keeping the raw code', () => {
    expect(explainErrorCode('weird_new_thing')).toBe('technical error (weird_new_thing)');
  });
});

describe('buildHumanActionRequestMessage (no DB context)', () => {
  it('renders QUOTE_FAILED with a plain-English diagnosis and no raw UUIDs', async () => {
    const action = baseAction({
      summary:
        'Quote 1a2b3c4d-1111-4111-8111-999999999999 failed ' +
        '(login_failed:maxance_extension_no_active_tab). ' +
        'Lead 5e6f7a8b-2222-4222-8222-999999999999. Capture(s) : 1.',
    });
    const text = await buildHumanActionRequestMessage(NO_DB, action);
    expect(text).toContain('🟡 *ACTION NEEDED* — Quote failed');
    expect(text).toContain('Maxance portal unreachable');
    expect(text).toContain('closed nights');
    expect(text).toContain('Reply with the number:');
    expect(text).toContain('1. Retry the quote');
    expect(text).toContain('Ref: #22222222');
    // No raw UUIDs anywhere in the rendered message.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('COMPLIANCE_BLOCKED shows the blocked draft, truncated to ~400 chars', async () => {
    const longDraft = 'Bonjour Karim ! '.repeat(40); // > 400 chars
    const action = baseAction({
      intent: 'COMPLIANCE_BLOCKED',
      summary: `Sales Agent draft bloqué (LLM). Raisons : promesse de prix garanti${HUMAN_ACTION_DRAFT_MARKER}${longDraft}`,
    });
    const text = await buildHumanActionRequestMessage(NO_DB, action);
    expect(text).toContain('Message blocked — approval needed');
    expect(text).toContain('Blocked draft (what the agent wanted to send):');
    expect(text).toContain('Bonjour Karim !');
    expect(text).toContain('…'); // truncation marker
    expect(text).toContain('promesse de prix garanti'); // checker reason surfaced
    // The full draft must NOT be there.
    expect(text).not.toContain(longDraft);
  });

  it('COMPLIANCE_BLOCKED explains the unparseable-LLM glitch in plain English', async () => {
    const action = baseAction({
      intent: 'COMPLIANCE_BLOCKED',
      summary:
        'Sales Agent draft bloqué (LLM). Raisons : compliance LLM response not parseable' +
        `${HUMAN_ACTION_DRAFT_MARKER}Bonjour !`,
    });
    const text = await buildHumanActionRequestMessage(NO_DB, action);
    expect(text).toContain('technical glitch (not a customer problem)');
    expect(text).toContain('withheld to be safe');
  });

  it('unknown intents fall back to the summary with UUIDs shortened', async () => {
    const action = baseAction({
      intent: 'SOMETHING_NEW',
      summary: 'Custom thing about 1a2b3c4d-1111-4111-8111-999999999999.',
    });
    const text = await buildHumanActionRequestMessage(NO_DB, action);
    expect(text).toContain('SOMETHING_NEW');
    expect(text).toContain('Custom thing about #1a2b3c4d.');
  });
});

describe('buildHumanActionResolvedMessage', () => {
  it('renders the English closure with the option label', () => {
    const text = buildHumanActionResolvedMessage({
      intent: 'QUOTE_FAILED',
      optionLabel: 'Retry the quote',
      kind: 'approve',
      source: 'whatsapp',
    });
    expect(text).toBe('✅ Quote failed — resolved via WhatsApp: *Retry the quote*');
  });
  it('uses reject / revise verbs', () => {
    expect(
      buildHumanActionResolvedMessage({
        intent: 'COMPLIANCE_BLOCKED',
        optionLabel: 'Do not send',
        kind: 'reject',
        source: 'admin',
      }),
    ).toBe('✅ Message blocked — approval needed — rejected via the admin: *Do not send*');
    expect(
      buildHumanActionResolvedMessage({
        intent: 'CAMPAIGN_DRAFT',
        optionLabel: 'Ask for a revision',
        kind: 'revise',
        source: 'whatsapp',
      }),
    ).toContain('revision requested via WhatsApp');
  });
});

// ---------------------------------------------------------------------------
// DB-gated: correlationId → quote/lead → customer resolution
// ---------------------------------------------------------------------------

const d = describe.skipIf(!pgUrl);

d('resolveActionContext + customer block (live DB)', () => {
  let db: Database;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
  });

  async function seedWebsiteLead(opts?: { simulation?: boolean }) {
    const customer = await insertCustomer(db, {
      fullName: 'Karim Testeur',
      phone: '+33699000111',
    });
    const [lead] = await db
      .insert(leads)
      .values({
        customerId: customer.id,
        source: 'website',
        productLine: 'scooter',
        status: 'quoting',
        ...(opts?.simulation ? { attribution: { f16_simulation: 'true' } } : {}),
      })
      .returning();
    return { customer, lead: lead! };
  }

  it('resolves quote-id correlations through quote → lead → customer', async () => {
    const { customer, lead } = await seedWebsiteLead();
    const [quote] = await db
      .insert(quotes)
      .values({
        customerId: customer.id,
        leadId: lead.id,
        product: 'scooter',
        productVariant: 'standard',
        sessionId: `sess-${Date.now()}`,
      })
      .returning();

    const ctx = await resolveActionContext(db, { correlationId: quote!.id });
    expect(ctx.customerName).toBe('Karim Testeur');
    expect(ctx.source).toBe('website');
    expect(ctx.productLine).toBe('scooter');
    expect(ctx.simulation).toBeUndefined();

    const text = await buildHumanActionRequestMessage(
      db,
      baseAction({
        correlationId: quote!.id,
        summary: `Quote ${quote!.id} failed (login_failed:maxance_extension_no_active_tab).`,
      }),
    );
    expect(text).toContain('Customer: Karim Testeur — website lead — scooter/trottinette');
    expect(text).toContain('Maxance portal unreachable');
    expect(text).not.toContain(quote!.id);
  });

  it('resolves lead-id correlations directly and flags SIMULATION leads', async () => {
    const { lead } = await seedWebsiteLead({ simulation: true });
    const ctx = await resolveActionContext(db, { correlationId: lead.id });
    expect(ctx.customerName).toBe('Karim Testeur');
    expect(ctx.simulation).toBe(true);

    const text = await buildHumanActionRequestMessage(
      db,
      baseAction({ intent: 'LEAD_DORMANT', correlationId: lead.id, summary: 'dormant.' }),
    );
    expect(text).toContain('⚠️ SIMULATION test lead — not a real customer.');
  });

  it('omits the customer block for unknown correlations (never crashes)', async () => {
    const ctx = await resolveActionContext(db, {
      correlationId: '99999999-9999-4999-8999-999999999999',
    });
    expect(ctx).toEqual({});
  });
});
