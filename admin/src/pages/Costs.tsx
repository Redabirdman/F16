/**
 * Coûts page (redesign 2026-07-08) — what the system costs to run.
 *
 * Top: 3 summary cards (total month, IA Claude, voix) like the DreamsAI
 * "Cost Analytics" reference. Middle: monthly stacked bar chart. Bottom:
 * category breakdown with progress bars + per-model LLM table + fixed items.
 *
 * The LLM history starts 2026-07-08 (the day the token sink shipped) —
 * earlier months legitimately read 0 €.
 */
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BrainCircuit, Phone, ReceiptText, Wallet } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { getCosts, type CostsResponse } from '@/lib/api';

const eur = (n: number): string =>
  n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });

function monthLabel(m: string): string {
  const d = new Date(`${m}-01T00:00:00Z`);
  return d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
}

export default function CostsPage(): ReactElement {
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'costs'],
    queryFn: () => getCosts(6),
    refetchInterval: 5 * 60_000,
  });

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 lg:p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Coûts système</h1>
          <p className="text-sm text-muted-foreground">
            IA Claude (tokens mesurés), appels vocaux et abonnements fixes.
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

      {data && <CostsView data={data} />}
    </div>
  );
}

function CostsView({ data }: { data: CostsResponse }): ReactElement {
  const cm = data.currentMonth;
  const monthName = new Date(`${cm.month}-01T00:00:00Z`).toLocaleDateString('fr-FR', {
    month: 'long',
    year: 'numeric',
  });

  const breakdown = [
    { label: 'IA — Claude (Anthropic)', value: cm.llm.totalEur, color: '#6366f1' },
    { label: 'Voix — OpenAI Realtime', value: cm.voice.totalEur, color: '#8b5cf6' },
    { label: 'Abonnements fixes', value: cm.fixed.totalEur, color: '#94a3b8' },
  ];
  const maxPart = Math.max(...breakdown.map((b) => b.value), 0.01);

  const chartRows = data.months.map((m) => ({
    mois: monthLabel(m.month),
    'IA Claude': m.llmEur,
    Voix: m.voiceEur,
    Fixes: m.fixedEur,
  }));

  return (
    <div className="flex flex-col gap-5">
      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard
          icon={<Wallet />}
          iconBg="bg-indigo-100 text-indigo-600"
          label={`Total ${monthName}`}
          value={eur(cm.totalEur)}
          sub="mois en cours (partiel)"
        />
        <SummaryCard
          icon={<BrainCircuit />}
          iconBg="bg-violet-100 text-violet-600"
          label="IA — Claude"
          value={eur(cm.llm.totalEur)}
          sub={`${cm.llm.byModel.reduce((s, m) => s + m.calls, 0)} appels modèle ce mois`}
        />
        <SummaryCard
          icon={<Phone />}
          iconBg="bg-emerald-100 text-emerald-600"
          label="Voix — appels IA"
          value={eur(cm.voice.totalEur)}
          sub={`${cm.voice.calls} appel${cm.voice.calls > 1 ? 's' : ''} · ${cm.voice.minutes.toFixed(1)} min`}
        />
      </div>

      {/* Monthly chart + breakdown */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm xl:col-span-2">
          <h2 className="mb-1 text-sm font-semibold text-slate-900">Coût mensuel</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Empilé par catégorie — le suivi des tokens Claude démarre le 8 juillet 2026.
          </p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartRows} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                <XAxis
                  dataKey="mois"
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${v} €`}
                />
                <Tooltip
                  formatter={(v: number | string) => eur(Number(v))}
                  contentStyle={{
                    borderRadius: 12,
                    border: '1px solid #e2e8f0',
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="Fixes" stackId="c" fill="#cbd5e1" />
                <Bar dataKey="Voix" stackId="c" fill="#8b5cf6" />
                <Bar dataKey="IA Claude" stackId="c" fill="#6366f1" radius={[4, 4, 0, 0]} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Répartition — {monthName}</h2>
          <ul className="flex flex-col gap-3">
            {breakdown.map((b) => (
              <li key={b.label} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-600">{b.label}</span>
                  <span className="font-semibold tabular-nums text-slate-900">{eur(b.value)}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(2, (b.value / maxPart) * 100)}%`,
                      backgroundColor: b.color,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[11px] text-muted-foreground">
            Taux USD→EUR appliqué : {data.usdEurRate}. Tarifs par modèle appliqués à la volée — les
            tokens sont stockés bruts.
          </p>
        </section>
      </div>

      {/* LLM per-model table + fixed items */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm xl:col-span-2">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <BrainCircuit className="h-4 w-4 text-indigo-500" /> Détail IA — {monthName}
          </h2>
          {cm.llm.byModel.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun appel modèle enregistré ce mois-ci (le suivi vient d&apos;être activé — les
              données apparaissent dès le premier message traité).
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="py-2 pr-3">Modèle</th>
                    <th className="py-2 pr-3">Appels</th>
                    <th className="py-2 pr-3">Tokens entrée</th>
                    <th className="py-2 pr-3">Tokens sortie</th>
                    <th className="py-2 pr-3">Cache lu</th>
                    <th className="py-2 text-right">Coût</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {cm.llm.byModel.map((m) => (
                    <tr key={m.model}>
                      <td className="py-2 pr-3">
                        <span className="font-medium text-slate-800">{modelDisplay(m.model)}</span>{' '}
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">
                          {m.tier}
                        </span>
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-slate-600">{m.calls}</td>
                      <td className="py-2 pr-3 tabular-nums text-slate-600">
                        {fmtTokens(m.inputTokens)}
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-slate-600">
                        {fmtTokens(m.outputTokens)}
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-slate-600">
                        {fmtTokens(m.cacheReadTokens)}
                      </td>
                      <td className="py-2 text-right font-semibold tabular-nums text-slate-900">
                        {eur(m.costEur)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <ReceiptText className="h-4 w-4 text-slate-500" /> Abonnements fixes
          </h2>
          <ul className="flex flex-col divide-y divide-slate-100">
            {cm.fixed.items.map((f) => (
              <li key={f.label} className="flex items-center justify-between py-2 text-sm">
                <span className="text-slate-600">{f.label}</span>
                <span className="font-medium tabular-nums text-slate-900">
                  {eur(f.monthlyEur)}/mois
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Montants ajustables via la variable d&apos;environnement F16_FIXED_COSTS.
          </p>
        </section>
      </div>
    </div>
  );
}

function SummaryCard(props: {
  icon: ReactElement;
  iconBg: string;
  label: string;
  value: string;
  sub: string;
}): ReactElement {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-sm">
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${props.iconBg} [&>svg]:h-5 [&>svg]:w-5`}
      >
        {props.icon}
      </span>
      <div className="flex flex-col">
        <span className="text-xl font-bold tabular-nums text-slate-900">{props.value}</span>
        <span className="text-xs font-medium text-slate-500">{props.label}</span>
        <span className="text-[11px] text-muted-foreground">{props.sub}</span>
      </div>
    </div>
  );
}

function modelDisplay(model: string): string {
  if (model.includes('haiku')) return 'Claude Haiku 4.5';
  if (model.includes('sonnet')) return 'Claude Sonnet 4.6';
  if (model.includes('opus')) return 'Claude Opus 4.7';
  return model;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} k`;
  return String(n);
}
