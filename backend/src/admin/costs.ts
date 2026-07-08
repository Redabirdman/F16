/**
 * Admin costs endpoint (admin redesign, 2026-07-08).
 *
 *   GET /v1/admin/costs?months=6
 *     System running costs, monthly buckets, newest month last:
 *       - LLM (Anthropic): from `llm_usage` token counters × the per-model
 *         price map below. Rows exist from 2026-07-08 onward (the sink
 *         shipped with this endpoint) — earlier months read 0.
 *       - Voice (OpenAI Realtime SIP): minutes from `voice.call.ended`
 *         audit rows (meta.durationMs) × per-minute rate.
 *       - Fixed monthly items (WAHA cloud, OVH SIP line, Google Workspace,
 *         …): a static config list, env-overridable via F16_FIXED_COSTS
 *         (JSON array [{label, monthlyEur}]).
 *
 * Prices are applied at QUERY time — `llm_usage` stores raw tokens only, so
 * changing a price here retro-corrects history instead of freezing mistakes.
 *
 * Currency: everything reported in EUR. Anthropic/OpenAI bill in USD; the
 * USD→EUR rate is a config constant (env F16_USD_EUR_RATE, default 0.92) —
 * good enough for a management dashboard, not an accounting system.
 */
import { Hono } from 'hono';
import { sql, and, eq, gte } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { auditLog, llmUsage } from '../db/schema/index.js';

export interface AdminCostsRouterOptions {
  db: Database;
}

/**
 * USD per MILLION tokens, per model id — Anthropic list prices.
 * cacheRead = cache-hit input; cacheWrite = 5-minute cache-write surcharge.
 * Extend when router.ts MODEL_IDS gains a model.
 */
const LLM_PRICES_USD_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-7': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
};
/** Unknown model fallback — priced like Sonnet so it's visible, not free. */
const LLM_PRICE_FALLBACK = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/** OpenAI Realtime voice — blended USD/minute (audio in+out, gpt-realtime). */
const VOICE_USD_PER_MINUTE = Number(process.env.F16_VOICE_USD_PER_MINUTE ?? '0.30');

const USD_EUR_RATE = Number(process.env.F16_USD_EUR_RATE ?? '0.92');

interface FixedCostItem {
  label: string;
  monthlyEur: number;
}

/** Default fixed monthly items — override with F16_FIXED_COSTS (JSON array). */
const DEFAULT_FIXED_COSTS: FixedCostItem[] = [
  { label: 'WAHA cloud (WhatsApp)', monthlyEur: 19 },
  { label: 'OVH ligne SIP', monthlyEur: 5 },
  { label: 'Google Workspace', monthlyEur: 7 },
];

function fixedCosts(): FixedCostItem[] {
  const raw = process.env.F16_FIXED_COSTS;
  if (!raw) return DEFAULT_FIXED_COSTS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_FIXED_COSTS;
    const items: FixedCostItem[] = [];
    for (const it of parsed) {
      if (
        it &&
        typeof it === 'object' &&
        typeof (it as FixedCostItem).label === 'string' &&
        typeof (it as FixedCostItem).monthlyEur === 'number'
      ) {
        items.push({
          label: (it as FixedCostItem).label,
          monthlyEur: (it as FixedCostItem).monthlyEur,
        });
      }
    }
    return items.length > 0 ? items : DEFAULT_FIXED_COSTS;
  } catch {
    return DEFAULT_FIXED_COSTS;
  }
}

export interface CostsResponse {
  generatedAt: string;
  usdEurRate: number;
  /** Oldest first; the last entry is the current (partial) month. */
  months: Array<{
    /** 'YYYY-MM' */
    month: string;
    llmEur: number;
    voiceEur: number;
    fixedEur: number;
    totalEur: number;
  }>;
  /** Current-month detail. */
  currentMonth: {
    month: string;
    llm: {
      totalEur: number;
      byModel: Array<{
        model: string;
        tier: string;
        calls: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        costEur: number;
      }>;
    };
    voice: { totalEur: number; calls: number; minutes: number };
    fixed: { totalEur: number; items: FixedCostItem[] };
    totalEur: number;
  };
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function llmCostUsd(
  model: string,
  t: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const p = LLM_PRICES_USD_PER_MTOK[model] ?? LLM_PRICE_FALLBACK;
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheRead * p.cacheRead +
      t.cacheWrite * p.cacheWrite) /
    1_000_000
  );
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function buildAdminCostsRouter(opts: AdminCostsRouterOptions): Hono {
  const app = new Hono();

  app.get('/v1/admin/costs', async (c) => {
    const monthsParam = Number(c.req.query('months') ?? '6');
    const monthsBack = Number.isFinite(monthsParam) ? Math.min(Math.max(monthsParam, 1), 24) : 6;

    const now = new Date();
    const windowStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthsBack - 1), 1),
    );

    // Month bucket list, oldest → current.
    const monthKeys: string[] = [];
    for (let i = monthsBack - 1; i >= 0; i--) {
      monthKeys.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
    }

    const [llmRows, voiceRows] = await Promise.all([
      // Per month × model token sums — cost applied in JS via the price map.
      opts.db
        .select({
          month: sql<string>`to_char(${llmUsage.occurredAt} at time zone 'UTC', 'YYYY-MM')`,
          model: llmUsage.model,
          tier: llmUsage.tier,
          calls: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)::bigint`,
          outputTokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)::bigint`,
          cacheReadTokens: sql<number>`coalesce(sum(${llmUsage.cacheReadTokens}), 0)::bigint`,
          cacheCreationTokens: sql<number>`coalesce(sum(${llmUsage.cacheCreationTokens}), 0)::bigint`,
        })
        .from(llmUsage)
        .where(gte(llmUsage.occurredAt, windowStart))
        .groupBy(
          sql`to_char(${llmUsage.occurredAt} at time zone 'UTC', 'YYYY-MM')`,
          llmUsage.model,
          llmUsage.tier,
        ),
      // Voice call durations from the audit trail.
      opts.db
        .select({
          month: sql<string>`to_char(${auditLog.occurredAt} at time zone 'UTC', 'YYYY-MM')`,
          calls: sql<number>`count(*)::int`,
          totalMs: sql<number>`coalesce(sum((${auditLog.meta} ->> 'durationMs')::bigint), 0)::bigint`,
        })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'voice.call.ended'), gte(auditLog.occurredAt, windowStart)))
        .groupBy(sql`to_char(${auditLog.occurredAt} at time zone 'UTC', 'YYYY-MM')`),
    ]);

    const fixed = fixedCosts();
    const fixedTotal = round2(fixed.reduce((s, f) => s + f.monthlyEur, 0));

    const llmEurByMonth = new Map<string, number>();
    for (const r of llmRows) {
      const usd = llmCostUsd(r.model, {
        input: Number(r.inputTokens),
        output: Number(r.outputTokens),
        cacheRead: Number(r.cacheReadTokens),
        cacheWrite: Number(r.cacheCreationTokens),
      });
      llmEurByMonth.set(r.month, (llmEurByMonth.get(r.month) ?? 0) + usd * USD_EUR_RATE);
    }

    const voiceByMonth = new Map<string, { calls: number; minutes: number }>();
    for (const r of voiceRows) {
      voiceByMonth.set(r.month, {
        calls: r.calls,
        minutes: Number(r.totalMs) / 60_000,
      });
    }

    const months = monthKeys.map((m) => {
      const llmEur = round2(llmEurByMonth.get(m) ?? 0);
      const v = voiceByMonth.get(m);
      const voiceEur = round2((v?.minutes ?? 0) * VOICE_USD_PER_MINUTE * USD_EUR_RATE);
      return {
        month: m,
        llmEur,
        voiceEur,
        fixedEur: fixedTotal,
        totalEur: round2(llmEur + voiceEur + fixedTotal),
      };
    });

    // Current-month detail. monthKeys is never empty (monthsBack >= 1).
    const cur = monthKeys[monthKeys.length - 1] ?? monthKey(now);
    const curLlmRows = llmRows
      .filter((r) => r.month === cur)
      .map((r) => ({
        model: r.model,
        tier: r.tier,
        calls: r.calls,
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
        cacheReadTokens: Number(r.cacheReadTokens),
        cacheCreationTokens: Number(r.cacheCreationTokens),
        costEur: round2(
          llmCostUsd(r.model, {
            input: Number(r.inputTokens),
            output: Number(r.outputTokens),
            cacheRead: Number(r.cacheReadTokens),
            cacheWrite: Number(r.cacheCreationTokens),
          }) * USD_EUR_RATE,
        ),
      }))
      .sort((a, b) => b.costEur - a.costEur);
    const curVoice = voiceByMonth.get(cur);
    const curLlmTotal = round2(curLlmRows.reduce((s, r) => s + r.costEur, 0));
    const curVoiceTotal = round2((curVoice?.minutes ?? 0) * VOICE_USD_PER_MINUTE * USD_EUR_RATE);

    const body: CostsResponse = {
      generatedAt: new Date().toISOString(),
      usdEurRate: USD_EUR_RATE,
      months,
      currentMonth: {
        month: cur,
        llm: { totalEur: curLlmTotal, byModel: curLlmRows },
        voice: {
          totalEur: curVoiceTotal,
          calls: curVoice?.calls ?? 0,
          minutes: round2(curVoice?.minutes ?? 0),
        },
        fixed: { totalEur: fixedTotal, items: fixed },
        totalEur: round2(curLlmTotal + curVoiceTotal + fixedTotal),
      },
    };
    return c.json(body, 200);
  });

  return app;
}
