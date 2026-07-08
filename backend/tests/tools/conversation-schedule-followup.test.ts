/**
 * `conversation.schedule_followup` tool tests (2026-07-08 — the « reparlez-
 * moi dans 10 minutes » gap). Live-DB: the tool writes leads.followup_* and
 * an audit row.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { auditLog, leads } from '../../src/db/schema/index.js';
import { insertCustomer } from '../../src/db/repositories/customers.js';
import { getTool, type ToolContext } from '../../src/tools/registry.js';
import { conversationScheduleFollowupToolName } from '../../src/tools/builtins/conversation-schedule-followup.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

let savedPiiKey: string | undefined;
beforeAll(() => {
  savedPiiKey = process.env.PII_ENCRYPTION_KEY;
  if (!process.env.PII_ENCRYPTION_KEY)
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});
afterAll(() => {
  if (savedPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedPiiKey;
});

d('conversation.schedule_followup', () => {
  let db: Database;
  let customerId: string;
  let leadId: string;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE customers RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE leads RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
    const customer = await insertCustomer(db, { fullName: 'Achraf Test', phone: '+33611111111' });
    customerId = customer.id;
    const [lead] = await db
      .insert(leads)
      .values({ customerId, source: 'meta', productLine: 'scooter', status: 'qualifying' })
      .returning();
    leadId = lead!.id;
  });

  function ctx(): ToolContext {
    return {
      db,
      agentRole: 'sales-agent',
      agentInstance: 'sales-agent#test',
      correlationId: leadId,
    };
  }

  it('books a pending follow-up on the lead + writes the audit row', async () => {
    const tool = getTool(conversationScheduleFollowupToolName);
    expect(tool).toBeDefined();
    const resumeAt = new Date(Date.now() + 10 * 60_000);
    const out = (await tool!.handler(ctx(), {
      customerId,
      resumeAt: resumeAt.toISOString(),
      topic: 'client occupé, reprendre la qualification trottinette',
    })) as { booked: true; resumesAt: string };
    expect(out.booked).toBe(true);
    expect(out.resumesAt).toMatch(/^\d{2}:\d{2}$/);

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead!.followupState).toBe('pending');
    expect(Math.abs(lead!.followupDueAt!.getTime() - resumeAt.getTime())).toBeLessThan(1500);
    expect(lead!.followupTopic).toContain('qualification');

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'conversation.followup.booked'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.targetId).toBe(leadId);
  });

  it('clamps a past/near-now resumeAt to ~1 minute out instead of rejecting', async () => {
    const tool = getTool(conversationScheduleFollowupToolName);
    await tool!.handler(ctx(), {
      customerId,
      resumeAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    const ahead = lead!.followupDueAt!.getTime() - Date.now();
    expect(ahead).toBeGreaterThan(30_000);
    expect(ahead).toBeLessThan(120_000);
  });

  it('rejects a resumeAt more than 7 days out (LLM date-mistake guard)', async () => {
    const tool = getTool(conversationScheduleFollowupToolName);
    await expect(
      tool!.handler(ctx(), {
        customerId,
        resumeAt: new Date(Date.now() + 9 * 24 * 3600_000).toISOString(),
      }),
    ).rejects.toThrow(/7 jours/);
  });
});
