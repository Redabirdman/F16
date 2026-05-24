/**
 * Strategy review (M15.T3) — DB-backed integration with a stubbed Opus.
 *
 * Verifies the digest aggregation + the JSON-parse + the
 * CONFIG_CHANGE_PROPOSED human-action emission path.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../../src/db/index.js';
import { conversationTurns, humanActions, leads } from '../../../src/db/schema/index.js';
import { insertCustomer } from '../../../src/db/repositories/customers.js';
import { __setClaudeClientForTests } from '../../../src/llm/claude.js';
import {
  buildDigest,
  proposeConfigChanges,
  startStrategyReview,
} from '../../../src/agents/supervisor-agent/strategy.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

let savedPiiKey: string | undefined;

beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY) {
    process.env.PII_ENCRYPTION_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  }
});

afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
});

class StubAnthropic {
  public nextText = JSON.stringify({
    proposals: [
      {
        kind: 'prompt_tweak',
        target: 'sales-agent',
        rationale: 'Trop de compliance blocks ce jour.',
      },
    ],
  });
  public calls: Array<{ model: string }> = [];
  public messages = {
    create: async (req: { model: string }) => {
      this.calls.push({ model: req.model });
      return {
        content: [{ type: 'text' as const, text: this.nextText }],
        stop_reason: 'end_turn' as const,
        usage: { input_tokens: 100, output_tokens: 80 },
      };
    },
  };
}

d('strategy review', () => {
  let db: Database;
  let stub: StubAnthropic;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE conversation_turns RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE quotes RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE human_actions RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
    stub = new StubAnthropic();
    __setClaudeClientForTests(stub);
  });

  afterEach(() => {
    __setClaudeClientForTests(null);
  });

  async function seedActivity(): Promise<void> {
    const cust = await insertCustomer(db, { fullName: 'Marie', phone: '+33611111111' });
    await db.insert(leads).values({
      customerId: cust.id,
      source: 'website',
      productLine: 'scooter',
      status: 'qualifying',
      score: 80,
    });
    await db.insert(conversationTurns).values({
      customerId: cust.id,
      channel: 'whatsapp',
      direction: 'outbound',
      agentRole: 'sales-agent',
      content: 'bonjour',
    });
  }

  it('buildDigest returns the expected aggregate shape', async () => {
    await seedActivity();
    const digest = await buildDigest(db);
    expect(digest.leads.total).toBe(1);
    expect(digest.leads.byStatus.qualifying).toBe(1);
    expect(digest.conversation.outbound).toBe(1);
    expect(digest.conversation.inbound).toBe(0);
  });

  it('proposeConfigChanges short-circuits on zero activity without calling Opus', async () => {
    const digest = await buildDigest(db); // empty db
    const proposals = await proposeConfigChanges(digest);
    expect(proposals).toEqual([]);
    expect(stub.calls).toHaveLength(0);
  });

  it('proposeConfigChanges parses Opus JSON and returns proposals', async () => {
    await seedActivity();
    const digest = await buildDigest(db);
    const proposals = await proposeConfigChanges(digest);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.model).toMatch(/opus/);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.kind).toBe('prompt_tweak');
    expect(proposals[0]?.target).toBe('sales-agent');
  });

  it('returns an empty proposals list when Opus returns malformed JSON', async () => {
    await seedActivity();
    stub.nextText = 'not json at all';
    const digest = await buildDigest(db);
    const proposals = await proposeConfigChanges(digest);
    expect(proposals).toEqual([]);
  });

  it('tickOnce creates CONFIG_CHANGE_PROPOSED human actions for each proposal', async () => {
    await seedActivity();
    const handle = startStrategyReview({
      db,
      intervalMs: 3_600_000,
      firstDelayMs: 3_600_000, // don't auto-fire
    });
    try {
      const result = await handle.tickOnce();
      expect(result.ok).toBe(true);
      expect(result.proposalCount).toBe(1);
      const actions = await db.select().from(humanActions);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.intent).toBe('CONFIG_CHANGE_PROPOSED');
      expect(actions[0]?.severity).toBe(3); // info — not critical
    } finally {
      handle.stop();
    }
  });
});
