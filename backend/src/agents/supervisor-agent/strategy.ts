/**
 * Daily strategy review (M15.T3) — Opus 4.7 reads the last 24h of swarm
 * activity + audit-log observations and proposes config changes
 * (prompt tweaks, model swaps, agents to kill or boost).
 *
 * Each proposal becomes a `HUMAN_ACTION` with intent
 * `CONFIG_CHANGE_PROPOSED` so Ridaa/Achraf approve or reject through the
 * normal queue + WA-group plumbing. The supervisor itself never enacts —
 * humans always sign off.
 *
 * Cadence: setInterval-driven (default once per 24h). First fire is
 * delayed by 6h after boot so a restart doesn't immediately re-summarise.
 * Test seam: `tickOnce()` runs the review synchronously.
 *
 * Env-gated by the caller (supervisor barrel exposes a separate flag
 * default-false in the worker bootstrap) — the Opus call burns real
 * tokens (~$0.10-0.30/day at current 24h volume) and should only run on
 * the dedicated PC, not on every dev box.
 *
 * Resilience: a failed Opus call (network, rate limit, JSON parse error)
 * logs + skips the day's review. We'd rather miss a day than spam human
 * actions with garbage proposals.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/index.js';
import { conversationTurns, humanActions, leads, quotes } from '../../db/schema/index.js';
import { auditLog } from '../../db/schema/index.js';
import { callClaude } from '../../llm/claude.js';
import { createAction } from '../../db/repositories/human-actions.js';
import { appendAudit } from '../../db/repositories/audit-log.js';
import { logger } from '../../logger.js';

const DEFAULT_INTERVAL_MS = 24 * 3600_000;
const DEFAULT_FIRST_DELAY_MS = 6 * 3600_000;
const OPUS_MAX_TOKENS = 1200;
const MAX_PROPOSALS_PER_REVIEW = 5;

export interface StrategyReviewOptions {
  db: Database;
  /** Override the tick cadence (ms). Default 24h. Tests pass small values. */
  intervalMs?: number;
  /** Override the initial-tick delay (ms). Default 6h. Tests pass 0. */
  firstDelayMs?: number;
}

export interface StrategyReviewHandle {
  scheduler: NodeJS.Timeout;
  stop(): void;
  /** Test seam: run one review synchronously. Returns proposal count. */
  tickOnce(): Promise<StrategyReviewResult>;
}

export interface StrategyReviewResult {
  ok: boolean;
  proposalCount: number;
  digest: StrategyDigest;
  error?: string;
}

/** Aggregated 24h snapshot the LLM gets as input. Capped at safe sizes. */
export interface StrategyDigest {
  windowStart: string;
  windowEnd: string;
  leads: { total: number; byStatus: Record<string, number> };
  quotes: { total: number; byStatus: Record<string, number> };
  conversation: { inbound: number; outbound: number };
  humanActions: { created: number; resolved: number; byIntent: Record<string, number> };
  supervisorObservations: Record<string, number>;
}

const ProposalSchema = z.object({
  kind: z.enum(['prompt_tweak', 'model_swap', 'kill_agent', 'boost_priority', 'other']),
  target: z.string(),
  rationale: z.string(),
});
const ProposalsSchema = z.object({
  proposals: z.array(ProposalSchema).max(MAX_PROPOSALS_PER_REVIEW),
});

export function startStrategyReview(opts: StrategyReviewOptions): StrategyReviewHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const firstDelayMs = opts.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS;

  const tick = async (): Promise<StrategyReviewResult> => {
    try {
      const digest = await buildDigest(opts.db);
      const proposals = await proposeConfigChanges(digest);
      for (const p of proposals) {
        await emitProposalAsHumanAction(opts.db, p, digest);
      }
      try {
        await appendAudit(opts.db, {
          actorType: 'agent',
          actorId: 'supervisor-agent#singleton',
          action: 'supervisor.strategy.review',
          targetType: 'window',
          targetId: digest.windowEnd,
          meta: {
            proposalCount: proposals.length,
            leadsTotal: digest.leads.total,
            humanActionsCreated: digest.humanActions.created,
          },
        });
      } catch {
        // non-blocking
      }
      logger.info(
        { proposalCount: proposals.length, leadsTotal: digest.leads.total },
        'supervisor: strategy review complete',
      );
      return { ok: true, proposalCount: proposals.length, digest };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'supervisor: strategy review failed');
      return {
        ok: false,
        proposalCount: 0,
        digest: {
          windowStart: '',
          windowEnd: '',
          leads: { total: 0, byStatus: {} },
          quotes: { total: 0, byStatus: {} },
          conversation: { inbound: 0, outbound: 0 },
          humanActions: { created: 0, resolved: 0, byIntent: {} },
          supervisorObservations: {},
        },
        error: msg,
      };
    }
  };

  // First tick after `firstDelayMs`, then every `intervalMs`. We use a
  // setTimeout → setInterval chain rather than firing immediately because
  // the strategy review burns Opus tokens; a restart loop shouldn't
  // hammer the budget.
  const firstTimer = setTimeout(() => {
    void tick();
  }, firstDelayMs);
  const scheduler = setInterval(() => {
    void tick();
  }, intervalMs);

  let stopped = false;
  return {
    scheduler,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimeout(firstTimer);
      clearInterval(scheduler);
    },
    tickOnce: tick,
  };
}

/**
 * Build the 24h digest from a handful of GROUP BY aggregates. Bounded
 * memory — every result is a count, no per-row joins.
 */
export async function buildDigest(db: Database): Promise<StrategyDigest> {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 3600_000);

  const [
    leadsRow,
    leadsByStatus,
    quotesRow,
    quotesByStatus,
    inboundRow,
    outboundRow,
    actionsCreatedRow,
    actionsResolvedRow,
    actionsByIntent,
    observationsByAction,
  ] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(leads)
      .where(gte(leads.createdAt, start)),
    db
      .select({ status: leads.status, n: sql<number>`count(*)::int` })
      .from(leads)
      .where(gte(leads.createdAt, start))
      .groupBy(leads.status),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(quotes)
      .where(gte(quotes.requestedAt, start)),
    db
      .select({ status: quotes.status, n: sql<number>`count(*)::int` })
      .from(quotes)
      .where(gte(quotes.requestedAt, start))
      .groupBy(quotes.status),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversationTurns)
      .where(
        and(eq(conversationTurns.direction, 'inbound'), gte(conversationTurns.occurredAt, start)),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversationTurns)
      .where(
        and(eq(conversationTurns.direction, 'outbound'), gte(conversationTurns.occurredAt, start)),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(humanActions)
      .where(gte(humanActions.createdAt, start)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(humanActions)
      .where(and(gte(humanActions.createdAt, start), eq(humanActions.status, 'resolved'))),
    db
      .select({ intent: humanActions.intent, n: sql<number>`count(*)::int` })
      .from(humanActions)
      .where(gte(humanActions.createdAt, start))
      .groupBy(humanActions.intent),
    db
      .select({ action: auditLog.action, n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(gte(auditLog.occurredAt, start), sql`${auditLog.action} like 'supervisor.observed.%'`),
      )
      .groupBy(auditLog.action),
  ]);

  const byStatusLeads: Record<string, number> = {};
  for (const r of leadsByStatus) byStatusLeads[r.status] = r.n;
  const byStatusQuotes: Record<string, number> = {};
  for (const r of quotesByStatus) byStatusQuotes[r.status] = r.n;
  const byIntent: Record<string, number> = {};
  for (const r of actionsByIntent) byIntent[r.intent] = r.n;
  const obsByAction: Record<string, number> = {};
  for (const r of observationsByAction) obsByAction[r.action] = r.n;

  return {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    leads: { total: leadsRow[0]?.n ?? 0, byStatus: byStatusLeads },
    quotes: { total: quotesRow[0]?.n ?? 0, byStatus: byStatusQuotes },
    conversation: { inbound: inboundRow[0]?.n ?? 0, outbound: outboundRow[0]?.n ?? 0 },
    humanActions: {
      created: actionsCreatedRow[0]?.n ?? 0,
      resolved: actionsResolvedRow[0]?.n ?? 0,
      byIntent,
    },
    supervisorObservations: obsByAction,
  };
}

/**
 * Call Opus with the digest, expect JSON `{proposals: [...]}`. Returns
 * an empty array on:
 *   - the Opus call throwing (network / rate limit) — caller already logs.
 *   - malformed JSON — caller logs + emits no proposals.
 *   - zero-activity window (the digest carries nothing actionable) —
 *     we short-circuit to skip the Opus call entirely.
 */
export async function proposeConfigChanges(
  digest: StrategyDigest,
): Promise<z.infer<typeof ProposalSchema>[]> {
  // Skip entirely on zero-activity windows — saves the Opus token spend.
  if (digest.leads.total === 0 && digest.humanActions.created === 0) {
    logger.info('supervisor: zero-activity window, skipping Opus call');
    return [];
  }

  const systemPrompt = [
    "Tu es le superviseur stratégique de l'organisation F16 (Assuryal).",
    'À partir du résumé 24h des KPIs et des observations, propose 0 à 5',
    'ajustements de configuration. Si tout va bien, propose une liste vide.',
    '',
    'Catégories de propositions :',
    "- prompt_tweak  : ajuster le prompt système d'un agent",
    "- model_swap    : changer le tier de modèle d'un agent",
    "- kill_agent    : arrêter une instance qui boucle ou s'égare",
    "- boost_priority: hausser la priorité d'un agent saturé",
    '- other         : autre suggestion (décrire dans rationale)',
    '',
    'Réponds STRICTEMENT en JSON, sans markdown, sans préambule :',
    '{"proposals": [{"kind": "...", "target": "agent ou autre", "rationale": "..."}]}',
    '',
    'Sois conservateur — propose une action seulement si les données la justifient.',
  ].join('\n');

  const userPrompt = JSON.stringify(digest, null, 2);

  let raw: string;
  try {
    const out = await callClaude({
      tier: 'opus',
      systemPrompt,
      userPrompt,
      maxTokens: OPUS_MAX_TOKENS,
      logContext: { agent: 'supervisor-agent', op: 'strategy_review' },
    });
    raw = typeof out === 'string' ? out : out.text;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'supervisor: Opus call failed, no proposals',
    );
    return [];
  }

  const parsed = safeParseProposals(raw);
  if (!parsed) {
    logger.warn({ rawSnippet: raw.slice(0, 200) }, 'supervisor: malformed Opus response');
    return [];
  }
  return parsed.proposals;
}

function safeParseProposals(raw: string): z.infer<typeof ProposalsSchema> | null {
  // Strip code fences if Opus wrapped despite the instruction.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const json = JSON.parse(cleaned);
    const result = ProposalsSchema.safeParse(json);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Persist a single Opus proposal as a HUMAN_ACTION. Severity 3 = info —
 * proposals are nudges, not emergencies, so they don't ping the WA
 * group's audible-mention path.
 */
async function emitProposalAsHumanAction(
  db: Database,
  proposal: z.infer<typeof ProposalSchema>,
  digest: StrategyDigest,
): Promise<void> {
  await createAction(db, {
    createdByAgent: 'supervisor-agent#singleton',
    correlationId: `strategy:${digest.windowEnd}`,
    intent: 'CONFIG_CHANGE_PROPOSED',
    severity: 3,
    summary: `Proposition stratégique (${proposal.kind}) sur ${proposal.target} : ${proposal.rationale}`,
    options: [
      { id: 'approve', label: 'Appliquer', kind: 'approve' },
      { id: 'reject', label: 'Ignorer', kind: 'reject' },
      { id: 'defer', label: 'Plus tard', kind: 'approve' },
    ],
  });
}
