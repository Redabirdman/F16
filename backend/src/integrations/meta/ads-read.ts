/**
 * Meta Graph — ads read layer (M12 Phase 2).
 *
 * Read-only helpers over the Marketing API that fetch the campaign→adset→ad
 * structure plus per-ad insights, normalized into shapes the ads repository
 * upserts directly. Kept separate from `client.ts` (transport) to stay under
 * the file-size limit and to isolate the Marketing-API field knowledge.
 *
 * Paging: Graph returns `{ data, paging.cursors.after }`. `getAllData` follows
 * the cursor up to a guard cap (25 pages × 200 = 5000 rows — far above
 * Assuryal's V1 scale) and accumulates `data[]`.
 *
 * Budgets: Meta returns `daily_budget` / `lifetime_budget` as minor-unit
 * (cents) STRINGS in the account currency. We parse to bigint cents.
 *
 * No PII: campaign/ad metadata + spend only.
 */
import type { MetaGraphClient } from './client.js';

const PAGE_LIMIT = 200;
const MAX_PAGES = 25;

interface Paged<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

async function getAllData<T>(
  client: MetaGraphClient,
  path: string,
  params: Record<string, string>,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const p: Record<string, string> = { ...params, limit: String(PAGE_LIMIT) };
    if (after) p.after = after;
    const res = await client.get<Paged<T>>(path, p);
    if (Array.isArray(res.data)) out.push(...res.data);
    after = res.paging?.next ? res.paging?.cursors?.after : undefined;
    pages += 1;
  } while (after && pages < MAX_PAGES);
  return out;
}

function toCents(v: unknown): bigint | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? v : String(v);
  if (!/^\d+$/.test(n)) return null;
  try {
    return BigInt(n);
  } catch {
    return null;
  }
}

function toDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export interface MetaCampaignRow {
  metaCampaignId: string;
  name: string;
  objective: string | null;
  status: string | null;
  dailyBudgetCents: bigint | null;
  lifetimeBudgetCents: bigint | null;
  startedAt: Date | null;
  endedAt: Date | null;
  raw: Record<string, unknown>;
}

export async function listCampaigns(
  client: MetaGraphClient,
  adAccountId: string,
): Promise<MetaCampaignRow[]> {
  const rows = await getAllData<Record<string, unknown>>(client, `/act_${adAccountId}/campaigns`, {
    fields: 'id,name,objective,status,daily_budget,lifetime_budget,start_time,stop_time',
  });
  return rows.map((r) => ({
    metaCampaignId: String(r.id),
    name: typeof r.name === 'string' ? r.name : '',
    objective: typeof r.objective === 'string' ? r.objective : null,
    status: typeof r.status === 'string' ? r.status : null,
    dailyBudgetCents: toCents(r.daily_budget),
    lifetimeBudgetCents: toCents(r.lifetime_budget),
    startedAt: toDate(r.start_time),
    endedAt: toDate(r.stop_time),
    raw: r,
  }));
}

export interface MetaAdsetRow {
  metaAdsetId: string;
  metaCampaignId: string | null;
  name: string;
  status: string | null;
  targeting: Record<string, unknown> | null;
  dailyBudgetCents: bigint | null;
  lifetimeBudgetCents: bigint | null;
  optimizationGoal: string | null;
  billingEvent: string | null;
  raw: Record<string, unknown>;
}

export async function listAdsets(
  client: MetaGraphClient,
  adAccountId: string,
): Promise<MetaAdsetRow[]> {
  const rows = await getAllData<Record<string, unknown>>(client, `/act_${adAccountId}/adsets`, {
    fields:
      'id,name,status,campaign_id,targeting,daily_budget,lifetime_budget,optimization_goal,billing_event',
  });
  return rows.map((r) => ({
    metaAdsetId: String(r.id),
    metaCampaignId: typeof r.campaign_id === 'string' ? r.campaign_id : null,
    name: typeof r.name === 'string' ? r.name : '',
    status: typeof r.status === 'string' ? r.status : null,
    targeting: (r.targeting as Record<string, unknown>) ?? null,
    dailyBudgetCents: toCents(r.daily_budget),
    lifetimeBudgetCents: toCents(r.lifetime_budget),
    optimizationGoal: typeof r.optimization_goal === 'string' ? r.optimization_goal : null,
    billingEvent: typeof r.billing_event === 'string' ? r.billing_event : null,
    raw: r,
  }));
}

export interface MetaAdRow {
  metaAdId: string;
  metaAdsetId: string | null;
  name: string;
  status: string | null;
  raw: Record<string, unknown>;
}

export async function listAds(client: MetaGraphClient, adAccountId: string): Promise<MetaAdRow[]> {
  const rows = await getAllData<Record<string, unknown>>(client, `/act_${adAccountId}/ads`, {
    fields: 'id,name,status,adset_id',
  });
  return rows.map((r) => ({
    metaAdId: String(r.id),
    metaAdsetId: typeof r.adset_id === 'string' ? r.adset_id : null,
    name: typeof r.name === 'string' ? r.name : '',
    status: typeof r.status === 'string' ? r.status : null,
    raw: r,
  }));
}

// ---------------------------------------------------------------------------
// Insights (per-ad metrics)
// ---------------------------------------------------------------------------

export interface MetaAdInsight {
  metaAdId: string;
  impressions: number;
  clicks: number;
  ctr: number | null;
  spendCents: bigint;
  reach: number | null;
  frequency: number | null;
  /** Lead-form submits, when present in `actions`. */
  conversions: number;
  raw: Record<string, unknown>;
}

const LEAD_ACTION_TYPES = new Set([
  'lead',
  'leadgen.other',
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
]);

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Sum lead-type actions from an insights row's `actions[]`. */
function leadConversions(actions: unknown): number {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions) {
    const entry = a as { action_type?: string; value?: unknown };
    if (entry.action_type && LEAD_ACTION_TYPES.has(entry.action_type)) total += num(entry.value);
  }
  return total;
}

/** Spend is a decimal STRING in account currency (e.g. "12.34") → cents. */
function spendToCents(v: unknown): bigint {
  const s = typeof v === 'string' ? v : String(v ?? '0');
  const m = s.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return 0n;
  const whole = m[1] ?? '0';
  const frac = (m[2] ?? '').padEnd(2, '0').slice(0, 2);
  try {
    return BigInt(whole) * 100n + BigInt(frac || '0');
  } catch {
    return 0n;
  }
}

export interface GetAdInsightsOptions {
  /** e.g. 'today' | 'yesterday' | 'last_7d'. Default 'today'. */
  datePreset?: string;
}

/**
 * Per-ad insights for the account over the window. Returns one row per ad
 * that served in the period. `actions` is requested for lead conversions.
 */
export async function getAdInsights(
  client: MetaGraphClient,
  adAccountId: string,
  opts: GetAdInsightsOptions = {},
): Promise<MetaAdInsight[]> {
  const rows = await getAllData<Record<string, unknown>>(client, `/act_${adAccountId}/insights`, {
    level: 'ad',
    date_preset: opts.datePreset ?? 'today',
    fields: 'ad_id,impressions,clicks,ctr,spend,reach,frequency,actions',
  });
  return rows.map((r) => ({
    metaAdId: String(r.ad_id),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    ctr: r.ctr !== undefined && r.ctr !== null ? num(r.ctr) / 100 : null, // Meta CTR is a %.
    spendCents: spendToCents(r.spend),
    reach: r.reach !== undefined ? num(r.reach) : null,
    frequency: r.frequency !== undefined ? num(r.frequency) : null,
    conversions: leadConversions(r.actions),
    raw: r,
  }));
}
