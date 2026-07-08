/**
 * Admin costs endpoint (admin redesign 2026-07-08) — DB-backed integration test.
 *
 * Seeds llm_usage rows + a voice.call.ended audit row and verifies month
 * bucketing, price-map math (tokens → EUR) and the fixed-items defaults.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { llmUsage } from '../../src/db/schema/index.js';
import { appendAudit } from '../../src/db/repositories/audit-log.js';
import { buildAdminCostsRouter, type CostsResponse } from '../../src/admin/costs.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

d('GET /v1/admin/costs', () => {
  let db: Database;
  let app: ReturnType<typeof buildAdminCostsRouter>;

  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE llm_usage RESTART IDENTITY CASCADE`);
    await db.execute(sql`TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE`);
    app = buildAdminCostsRouter({ db });
  });

  it('returns fixed-only months on an empty database', async () => {
    const res = await app.request('/v1/admin/costs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as CostsResponse;
    expect(body.months).toHaveLength(6);
    for (const m of body.months) {
      expect(m.llmEur).toBe(0);
      expect(m.voiceEur).toBe(0);
      expect(m.fixedEur).toBeGreaterThan(0);
      expect(m.totalEur).toBe(m.fixedEur);
    }
    expect(body.currentMonth.llm.byModel).toHaveLength(0);
    expect(body.currentMonth.voice.calls).toBe(0);
    expect(body.currentMonth.fixed.items.length).toBeGreaterThan(0);
  });

  it('prices LLM tokens per model and buckets voice minutes by month', async () => {
    // 1M input tokens on Haiku = $1 → ×0.92 = 0.92 €.
    await db.insert(llmUsage).values({
      model: 'claude-haiku-4-5-20251001',
      tier: 'haiku',
      agentRole: 'sales-agent',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // 100k output tokens on Sonnet = $1.50 → 1.38 €.
    await db.insert(llmUsage).values({
      model: 'claude-sonnet-4-6',
      tier: 'sonnet',
      agentRole: 'sales-agent',
      inputTokens: 0,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // A row 3 months ago must land in an earlier bucket, not the current one.
    const now = new Date();
    await db.insert(llmUsage).values({
      model: 'claude-haiku-4-5-20251001',
      tier: 'haiku',
      inputTokens: 2_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      occurredAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 15)),
    });
    // One 2-minute voice call this month.
    await appendAudit(db, {
      actorType: 'system',
      actorId: 'openai-sip',
      action: 'voice.call.ended',
      meta: { durationMs: 120_000, turns: 4 },
    });

    const res = await app.request('/v1/admin/costs?months=6');
    expect(res.status).toBe(200);
    const body = (await res.json()) as CostsResponse;

    const cur = body.months[body.months.length - 1]!;
    // 0.92 (haiku) + 1.38 (sonnet) = 2.30 €.
    expect(cur.llmEur).toBeCloseTo(2.3, 2);
    // 2 min × $0.30 × 0.92 = 0.552 → 0.55 €.
    expect(cur.voiceEur).toBeCloseTo(0.55, 2);
    expect(cur.totalEur).toBeCloseTo(cur.llmEur + cur.voiceEur + cur.fixedEur, 2);

    // The old row is 3 months back.
    const old = body.months[body.months.length - 4]!;
    expect(old.llmEur).toBeCloseTo(1.84, 2);

    // Current-month detail: models sorted by cost desc, voice minutes present.
    expect(body.currentMonth.llm.byModel[0]!.model).toBe('claude-sonnet-4-6');
    expect(body.currentMonth.llm.byModel[0]!.calls).toBe(1);
    expect(body.currentMonth.voice.minutes).toBeCloseTo(2, 2);
    expect(body.currentMonth.voice.calls).toBe(1);
  });

  it('clamps the months param', async () => {
    const res = await app.request('/v1/admin/costs?months=999');
    expect(res.status).toBe(200);
    const body = (await res.json()) as CostsResponse;
    expect(body.months).toHaveLength(24);
  });
});
