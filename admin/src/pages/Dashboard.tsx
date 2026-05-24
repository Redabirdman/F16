/**
 * Dashboard page (M14.T3).
 *
 * Three rows of KPI cards backed by /v1/admin/dashboard/kpis.
 * The endpoint runs every aggregate in one round-trip so the cards
 * always show consistent numbers (no cross-card drift from staggered
 * refetches).
 */
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { getDashboardKpis, type DashboardKpis } from '@/lib/api';

export default function DashboardPage(): ReactElement {
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: getDashboardKpis,
    refetchInterval: 30_000,
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tableau de bord</h1>
          <p className="text-sm text-muted-foreground">
            Vue d&apos;ensemble — rafraîchi toutes les 30 s.
          </p>
        </div>
        <Button onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? 'Rafraîchissement…' : 'Rafraîchir'}
        </Button>
      </header>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {(error as Error).message}
        </div>
      )}

      {isLoading && !data && <div className="text-sm text-muted-foreground">Chargement…</div>}

      {data && <DashboardGrid data={data} />}
    </div>
  );
}

function DashboardGrid({ data }: { data: DashboardKpis }): ReactElement {
  const { leads, humanActions, conversation, quotes } = data;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <KpiCard
          label="Leads dernières 24 h"
          value={leads.totalLast24h}
          tone={leads.totalLast24h > 0 ? 'good' : 'neutral'}
        />
        <KpiCard
          label="Actions humaines en attente"
          value={humanActions.pendingTotal}
          tone={
            humanActions.pendingBySeverity.critical > 0
              ? 'bad'
              : humanActions.pendingTotal > 0
                ? 'warn'
                : 'good'
          }
          sublabel={`🔴 ${humanActions.pendingBySeverity.critical} · 🟡 ${humanActions.pendingBySeverity.standard} · 🟢 ${humanActions.pendingBySeverity.info}`}
        />
        <KpiCard
          label="Devis 24 h"
          value={quotes.totalLast24h}
          tone={quotes.totalLast24h > 0 ? 'good' : 'neutral'}
        />
        <KpiCard
          label="Messages 24 h"
          value={conversation.inboundLast24h + conversation.outboundLast24h}
          tone="neutral"
          sublabel={`↓ ${conversation.inboundLast24h} entrants · ↑ ${conversation.outboundLast24h} sortants`}
        />
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Pipeline leads (cumul)
        </h2>
        <PipelineBar counts={leads.byStatusAllTime} />
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Devis par statut (cumul)
        </h2>
        <PipelineBar counts={quotes.byStatusAllTime} />
      </section>

      <p className="text-xs text-slate-500">
        Généré à {new Date(data.generatedAt).toLocaleString('fr-FR')}.
      </p>
    </div>
  );
}

function KpiCard(props: {
  label: string;
  value: number;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  sublabel?: string;
}): ReactElement {
  const tones = {
    good: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    warn: 'bg-amber-50 border-amber-200 text-amber-900',
    bad: 'bg-rose-50 border-rose-200 text-rose-900',
    neutral: 'bg-white border-slate-200 text-slate-900',
  } as const;
  return (
    <div className={`flex flex-col gap-1 rounded-md border p-4 shadow-sm ${tones[props.tone]}`}>
      <span className="text-xs font-medium uppercase tracking-wide opacity-70">{props.label}</span>
      <span className="text-3xl font-bold tabular-nums">{props.value}</span>
      {props.sublabel && <span className="text-xs opacity-80">{props.sublabel}</span>}
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  new: 'bg-slate-400',
  scored: 'bg-slate-500',
  qualifying: 'bg-sky-500',
  quoting: 'bg-emerald-500',
  negotiating: 'bg-emerald-600',
  awaiting_payment: 'bg-amber-500',
  closed_won: 'bg-emerald-700',
  closed_lost: 'bg-rose-500',
  dormant: 'bg-rose-400',
  // Quote statuses (overlap is fine — same palette intent: forward-only is greener).
  draft: 'bg-slate-300',
  requested: 'bg-slate-400',
  in_progress: 'bg-sky-500',
  ready: 'bg-emerald-500',
  sent: 'bg-emerald-600',
  accepted: 'bg-emerald-700',
  rejected: 'bg-rose-500',
  expired: 'bg-amber-500',
};

function PipelineBar({ counts }: { counts: Record<string, number> }): ReactElement {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) {
    return <p className="text-sm text-slate-500">Aucune donnée pour l&apos;instant.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
        {entries.map(([status, n]) => (
          <div
            key={status}
            title={`${status}: ${n}`}
            className={STATUS_COLOR[status] ?? 'bg-slate-300'}
            style={{ width: `${(n / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
        {entries.map(([status, n]) => (
          <span key={status} className="flex items-center gap-1.5">
            <span
              className={`inline-block h-2 w-2 rounded-full ${STATUS_COLOR[status] ?? 'bg-slate-300'}`}
            />
            <span className="font-mono">{status}</span>
            <span className="text-slate-500">({n})</span>
          </span>
        ))}
      </div>
    </div>
  );
}
