/**
 * Dashboard (redesign 2026-07-08) — company-dashboard home.
 *
 * Layout (FINNOVA / DreamsAI references):
 *   1. Hero KPI cards — big number, 7-days-vs-previous-7 trend badge and an
 *      embedded 14-day sparkline.
 *   2. Activity combo chart (messages bars + devis/appels lines) next to the
 *      agents-activity donut.
 *   3. Rappels à venir + Activité récente + pipeline strips.
 *
 * All data comes from the single /v1/admin/dashboard/kpis round-trip so the
 * cards never drift from each other.
 */
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CalendarClock,
  FileCheck2,
  MessageCircle,
  Phone,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { getDashboardKpis, type DashboardKpis } from '@/lib/api';
import { personaFor } from '@/lib/personas';

export default function DashboardPage(): ReactElement {
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: getDashboardKpis,
    refetchInterval: 30_000,
  });

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 lg:p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Tableau de bord</h1>
          <p className="text-sm text-muted-foreground">
            {`L'activité de l'équipe en un coup d'œil — rafraîchi toutes les 30 s.`}
          </p>
        </div>
        <Button onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? 'Rafraîchissement…' : 'Rafraîchir'}
        </Button>
      </header>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {(error as Error).message}
        </div>
      )}

      {isLoading && !data && <div className="text-sm text-muted-foreground">Chargement…</div>}

      {data && <DashboardGrid data={data} />}
    </div>
  );
}

/** Sum a timeseries key over the last / previous 7 days of the 14-day window. */
function weekSplit(
  ts: DashboardKpis['timeseries'],
  pick: (d: DashboardKpis['timeseries'][number]) => number,
): { last7: number; prev7: number } {
  let last7 = 0;
  let prev7 = 0;
  for (const [i, d] of ts.entries()) {
    if (i >= ts.length - 7) last7 += pick(d);
    else prev7 += pick(d);
  }
  return { last7, prev7 };
}

function DashboardGrid({ data }: { data: DashboardKpis }): ReactElement {
  const { leads, humanActions, conversation, quotes, calls, timeseries } = data;

  const messages = weekSplit(timeseries, (d) => d.inbound + d.outbound);
  const devis = weekSplit(timeseries, (d) => d.devisDelivered);
  const calls7 = weekSplit(timeseries, (d) => d.callsPlaced);
  const quotes7 = weekSplit(timeseries, (d) => d.quotesRequested);

  return (
    <div className="flex flex-col gap-5">
      {/* Hero KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <HeroCard
          icon={<MessageCircle />}
          iconBg="bg-indigo-100 text-indigo-600"
          label="Messages (24 h)"
          value={conversation.inboundLast24h + conversation.outboundLast24h}
          sub={`↓ ${conversation.inboundLast24h} reçus · ↑ ${conversation.outboundLast24h} envoyés`}
          trend={messages}
          spark={timeseries.map((d) => ({ day: d.day, v: d.inbound + d.outbound }))}
          sparkColor="#6366f1"
        />
        <HeroCard
          icon={<FileCheck2 />}
          iconBg="bg-emerald-100 text-emerald-600"
          label="Devis envoyés (24 h)"
          value={quotes.devisDeliveredLast24h}
          sub={`${quotes.totalLast24h} tarifications lancées`}
          trend={devis}
          spark={timeseries.map((d) => ({ day: d.day, v: d.devisDelivered }))}
          sparkColor="#10b981"
        />
        <HeroCard
          icon={<Phone />}
          iconBg="bg-violet-100 text-violet-600"
          label="Appels passés (24 h)"
          value={calls.placedLast24h}
          sub={`${calls.scheduledUpcoming} rappel${calls.scheduledUpcoming > 1 ? 's' : ''} programmé${calls.scheduledUpcoming > 1 ? 's' : ''}`}
          trend={calls7}
          spark={timeseries.map((d) => ({ day: d.day, v: d.callsPlaced }))}
          sparkColor="#8b5cf6"
        />
        <HeroCard
          icon={<Users />}
          iconBg="bg-amber-100 text-amber-600"
          label="Leads (24 h)"
          value={leads.totalLast24h}
          sub={`${quotes7.last7} tarifications sur 7 j`}
          trend={quotes7}
          spark={timeseries.map((d) => ({ day: d.day, v: d.quotesRequested }))}
          sparkColor="#f59e0b"
        />
      </div>

      {/* Pending actions strip — only when something needs the team. */}
      {humanActions.pendingTotal > 0 && (
        <a
          href="/queue"
          className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 transition-colors hover:bg-amber-100"
        >
          <span className="font-medium">
            ⚠️ {humanActions.pendingTotal} action{humanActions.pendingTotal > 1 ? 's' : ''} en
            attente de votre décision
          </span>
          <span className="text-xs">
            🔴 {humanActions.pendingBySeverity.critical} · 🟡{' '}
            {humanActions.pendingBySeverity.standard} · 🟢 {humanActions.pendingBySeverity.info}
          </span>
        </a>
      )}

      {/* Charts row */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm xl:col-span-2">
          <h2 className="mb-1 text-sm font-semibold text-slate-900">
            Activité des 14 derniers jours
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Messages échangés, devis livrés et appels passés par jour.
          </p>
          <ActivityChart ts={data.timeseries} />
        </section>
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="mb-1 text-sm font-semibold text-slate-900">Agents actifs (7 j)</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Part des messages sortants par agent.
          </p>
          <AgentsDonut activity={data.agentActivity} />
        </section>
      </div>

      {/* Callbacks + activity + pipelines */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="flex flex-col gap-4">
          {data.upcomingCallbacks.length > 0 && (
            <section className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 shadow-sm">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-900">
                <CalendarClock className="h-4 w-4" /> Rappels téléphoniques à venir
              </h2>
              <ul className="flex flex-col gap-2">
                {data.upcomingCallbacks.map((cb) => (
                  <li key={cb.leadId} className="flex items-center justify-between text-sm">
                    <a
                      className="font-medium text-indigo-700 hover:underline"
                      href={`/leads/${cb.leadId}`}
                    >
                      {cb.customerName}
                    </a>
                    <span className="tabular-nums text-amber-900">
                      {new Date(cb.dueAt).toLocaleString('fr-FR', {
                        weekday: 'long',
                        day: 'numeric',
                        month: 'long',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Pipeline leads</h2>
            <PipelineBar counts={leads.byStatusAllTime} />
            <h2 className="mb-3 mt-5 text-sm font-semibold text-slate-900">Devis par statut</h2>
            <PipelineBar counts={quotes.byStatusAllTime} />
          </section>
        </div>

        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Activité récente</h2>
          {data.recentActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">Rien pour l&apos;instant.</p>
          ) : (
            <ul className="flex max-h-[420px] flex-col gap-1 overflow-y-auto">
              {data.recentActivity.map((ev, i) => (
                <li
                  key={i}
                  className="flex items-start justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-accent"
                >
                  {ev.leadId ? (
                    <a
                      className="text-slate-800 hover:text-indigo-700"
                      href={`/leads/${ev.leadId}`}
                    >
                      {ev.label}
                    </a>
                  ) : (
                    <span className="text-slate-800">{ev.label}</span>
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-slate-400">
                    {new Date(ev.at).toLocaleTimeString('fr-FR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <p className="text-xs text-slate-400">
        Généré à {new Date(data.generatedAt).toLocaleString('fr-FR')}.
      </p>
    </div>
  );
}

function TrendBadge({ last7, prev7 }: { last7: number; prev7: number }): ReactElement {
  if (prev7 === 0 && last7 === 0) {
    return <span className="text-xs font-medium text-slate-400">—</span>;
  }
  const pct = prev7 === 0 ? 100 : Math.round(((last7 - prev7) / prev7) * 100);
  const up = pct >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
        up ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
      }`}
      title="7 derniers jours vs 7 précédents"
    >
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? '+' : ''}
      {pct}%
    </span>
  );
}

function HeroCard(props: {
  icon: ReactElement;
  iconBg: string;
  label: string;
  value: number;
  sub: string;
  trend: { last7: number; prev7: number };
  spark: Array<{ day: string; v: number }>;
  sparkColor: string;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span
          className={`flex h-9 w-9 items-center justify-center rounded-lg ${props.iconBg} [&>svg]:h-5 [&>svg]:w-5`}
        >
          {props.icon}
        </span>
        <TrendBadge last7={props.trend.last7} prev7={props.trend.prev7} />
      </div>
      <div>
        <div className="text-3xl font-bold tabular-nums text-slate-900">{props.value}</div>
        <div className="text-xs font-medium text-slate-500">{props.label}</div>
      </div>
      <div className="h-10">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={props.spark} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <Bar dataKey="v" fill={props.sparkColor} opacity={0.7} radius={[2, 2, 0, 0]} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[11px] text-muted-foreground">{props.sub}</div>
    </div>
  );
}

function dayTick(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function ActivityChart({ ts }: { ts: DashboardKpis['timeseries'] }): ReactElement {
  const rows = ts.map((d) => ({
    day: dayTick(d.day),
    Reçus: d.inbound,
    Envoyés: d.outbound,
    Devis: d.devisDelivered,
    Appels: d.callsPlaced,
  }));
  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
          <XAxis
            dataKey="day"
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              borderRadius: 12,
              border: '1px solid #e2e8f0',
              fontSize: 12,
              boxShadow: '0 4px 12px rgba(15,23,42,0.08)',
            }}
          />
          <Bar dataKey="Reçus" stackId="m" fill="#c7d2fe" radius={[0, 0, 0, 0]} />
          <Bar dataKey="Envoyés" stackId="m" fill="#6366f1" radius={[4, 4, 0, 0]} />
          <Line type="monotone" dataKey="Devis" stroke="#10b981" strokeWidth={2.5} dot={false} />
          <Line
            type="monotone"
            dataKey="Appels"
            stroke="#8b5cf6"
            strokeWidth={2}
            dot={false}
            strokeDasharray="4 3"
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <LegendDot color="#c7d2fe" label="Messages reçus" />
        <LegendDot color="#6366f1" label="Messages envoyés" />
        <LegendDot color="#10b981" label="Devis livrés" />
        <LegendDot color="#8b5cf6" label="Appels" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }): ReactElement {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function AgentsDonut({ activity }: { activity: DashboardKpis['agentActivity'] }): ReactElement {
  if (activity.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucune activité agent sur 7 jours.</p>;
  }
  const total = activity.reduce((s, a) => s + a.count, 0);
  const rows = activity.map((a) => {
    const p = personaFor(a.role);
    return { name: `${p.name} (${p.title})`, short: p.name, value: a.count, color: p.color };
  });
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey="value"
              nameKey="name"
              innerRadius={55}
              outerRadius={80}
              paddingAngle={3}
              strokeWidth={0}
            >
              {rows.map((r, i) => (
                <Cell key={i} fill={r.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                borderRadius: 12,
                border: '1px solid #e2e8f0',
                fontSize: 12,
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold tabular-nums text-slate-900">{total}</span>
          <span className="text-[11px] text-slate-500">messages</span>
        </div>
      </div>
      <ul className="flex w-full flex-col gap-1">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-slate-600">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: r.color }}
              />
              {r.name}
            </span>
            <span className="font-medium tabular-nums text-slate-800">
              {Math.round((r.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  new: 'bg-slate-400',
  scored: 'bg-slate-500',
  qualifying: 'bg-sky-500',
  quoting: 'bg-indigo-500',
  negotiating: 'bg-violet-500',
  awaiting_payment: 'bg-amber-500',
  closed_won: 'bg-emerald-600',
  closed_lost: 'bg-rose-500',
  dormant: 'bg-rose-400',
  draft: 'bg-slate-300',
  requested: 'bg-slate-400',
  in_progress: 'bg-sky-500',
  ready: 'bg-emerald-500',
  sent: 'bg-emerald-600',
  accepted: 'bg-emerald-700',
  rejected: 'bg-rose-500',
  expired: 'bg-amber-500',
};

const STATUS_LABEL_FR: Record<string, string> = {
  new: 'nouveau',
  scored: 'scoré',
  qualifying: 'qualification',
  quoting: 'tarification',
  negotiating: 'négociation',
  awaiting_payment: 'attente paiement',
  closed_won: 'gagné',
  closed_lost: 'perdu',
  dormant: 'dormant',
  draft: 'brouillon',
  requested: 'demandé',
  in_progress: 'en cours',
  ready: 'prêt',
  sent: 'envoyé',
  accepted: 'accepté',
  rejected: 'refusé',
  expired: 'expiré',
};

function PipelineBar({ counts }: { counts: Record<string, number> }): ReactElement {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) {
    return <p className="text-sm text-muted-foreground">Aucune donnée pour l&apos;instant.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
        {entries.map(([status, n]) => (
          <div
            key={status}
            title={`${STATUS_LABEL_FR[status] ?? status}: ${n}`}
            className={STATUS_COLOR[status] ?? 'bg-slate-300'}
            style={{ width: `${(n / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        {entries.map(([status, n]) => (
          <span key={status} className="flex items-center gap-1.5">
            <span
              className={`inline-block h-2 w-2 rounded-full ${STATUS_COLOR[status] ?? 'bg-slate-300'}`}
            />
            {STATUS_LABEL_FR[status] ?? status}
            <span className="text-slate-400">({n})</span>
          </span>
        ))}
      </div>
    </div>
  );
}
