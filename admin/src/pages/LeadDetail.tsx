/**
 * Lead-detail page (M14.T4 V1).
 *
 * Top: lead header (status, source, score, HubSpot link) + customer block
 * (display name, civility, channel availability flags).
 * Middle: conversation thread, oldest-first, inbound left / outbound right
 * with agent attribution.
 * Right rail: quote attempts + human actions correlated to the lead.
 *
 * Read-only V1 — the queue page is where actions get resolved. Status
 * mutations (manual close-lost, force-dormant) wait for M14 V2 + auth.
 */
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { getLeadDetail, type LeadDetail } from '@/lib/api';

function statusTone(status: string): string {
  if (status === 'new' || status === 'scored') return 'bg-slate-100 text-slate-700';
  if (status === 'qualifying' || status === 'quoting' || status === 'negotiating')
    return 'bg-emerald-100 text-emerald-800';
  if (status === 'closed_won') return 'bg-emerald-200 text-emerald-900';
  if (status === 'closed_lost' || status === 'dormant') return 'bg-rose-100 text-rose-800';
  return 'bg-amber-100 text-amber-800';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

export default function LeadDetailPage(): ReactElement {
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'lead-detail', id],
    queryFn: () => getLeadDetail(id),
    enabled: id.length > 0,
    refetchInterval: 15_000,
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <Link to="/leads" className="text-xs text-sky-700 hover:underline">
            ← Retour aux leads
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Lead {id.slice(0, 8)}…</h1>
        </div>
        <Button onClick={() => void refetch()} disabled={isFetching} variant="default">
          {isFetching ? 'Rafraîchissement…' : 'Rafraîchir'}
        </Button>
      </header>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {(error as Error).message}
        </div>
      )}

      {isLoading && !data && <div className="text-sm text-muted-foreground">Chargement…</div>}

      {data && <LeadDetailView data={data} />}
    </div>
  );
}

function LeadDetailView({ data }: { data: LeadDetail }): ReactElement {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="flex flex-col gap-6 lg:col-span-2">
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Lead
          </h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-500">Statut</dt>
            <dd>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(data.lead.status)}`}
              >
                {data.lead.status}
              </span>
            </dd>
            <dt className="text-slate-500">Source</dt>
            <dd>{data.lead.source}</dd>
            <dt className="text-slate-500">Produit</dt>
            <dd>{data.lead.productLine}</dd>
            <dt className="text-slate-500">Score</dt>
            <dd>{data.lead.score ?? '—'}</dd>
            <dt className="text-slate-500">HubSpot</dt>
            <dd>
              {data.lead.hubspotDealId ? (
                <span className="font-mono text-xs text-emerald-700">
                  {data.lead.hubspotDealId}
                </span>
              ) : (
                <span className="text-slate-400">—</span>
              )}
            </dd>
            <dt className="text-slate-500">Créé</dt>
            <dd>{formatTime(data.lead.createdAt)}</dd>
          </dl>
        </section>

        {data.customer && (
          <section className="rounded-md border border-slate-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Client
            </h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-slate-500">Nom</dt>
              <dd>
                {data.customer.displayName ?? (
                  <span className="text-slate-400">(non déchiffré)</span>
                )}
              </dd>
              <dt className="text-slate-500">Civilité</dt>
              <dd>{data.customer.civility ?? '—'}</dd>
              <dt className="text-slate-500">Téléphone</dt>
              <dd>{data.customer.hasPhone ? '✅' : '—'}</dd>
              <dt className="text-slate-500">Email</dt>
              <dd>{data.customer.hasEmail ? '✅' : '—'}</dd>
            </dl>
          </section>
        )}

        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Conversation ({data.turns.length})
          </h2>
          {data.turns.length === 0 ? (
            <p className="text-sm text-slate-500">Aucun message pour ce lead.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {data.turns.map((t) => (
                <li
                  key={t.id}
                  className={`flex flex-col gap-1 rounded p-3 text-sm ${
                    t.direction === 'inbound'
                      ? 'bg-slate-50 text-slate-900'
                      : 'bg-sky-50 text-slate-900'
                  }`}
                >
                  <div className="flex items-center gap-2 text-[11px] text-slate-500">
                    <span className="font-medium">
                      {t.direction === 'inbound' ? 'Client' : (t.agentRole ?? 'agent')}
                    </span>
                    <span>·</span>
                    <span>{t.channel}</span>
                    <span>·</span>
                    <span>{formatTime(t.occurredAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap">{t.content}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <aside className="flex flex-col gap-6">
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Devis ({data.quotes.length})
          </h2>
          {data.quotes.length === 0 ? (
            <p className="text-sm text-slate-500">Aucun devis demandé.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {data.quotes.map((q) => (
                <li
                  key={q.id}
                  className="rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-800">{q.productVariant}</span>
                    <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                      {q.status}
                    </span>
                  </div>
                  {q.monthlyPremiumEur !== null && (
                    <p className="mt-1 text-slate-700">
                      Mensuel : {q.monthlyPremiumEur.toFixed(2)} €
                    </p>
                  )}
                  {q.maxanceDevisNumber && (
                    <p className="text-slate-500">Réf Maxance : {q.maxanceDevisNumber}</p>
                  )}
                  <p className="mt-1 text-slate-400">{formatTime(q.requestedAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Actions humaines ({data.humanActions.length})
          </h2>
          {data.humanActions.length === 0 ? (
            <p className="text-sm text-slate-500">Aucune escalade pour ce lead.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {data.humanActions.map((a) => (
                <li
                  key={a.id}
                  className="rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-slate-600">{a.intent}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-medium ${
                        a.status === 'pending'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-emerald-100 text-emerald-800'
                      }`}
                    >
                      {a.status}
                    </span>
                  </div>
                  <p className="mt-1 text-slate-700">{a.summary}</p>
                  <p className="mt-1 text-slate-400">
                    {formatTime(a.createdAt)}
                    {a.resolvedAt ? ` → ${formatTime(a.resolvedAt)}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}
