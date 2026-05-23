/**
 * Leads board page (option D).
 *
 * Read-only V0: lists the latest 50 leads newest-first with status,
 * source, product line, score, and the matched customer name (decrypted
 * server-side). Refreshes every 30s via React Query's default staleTime;
 * a manual "Refresh" button forces an immediate refetch.
 *
 * Mutations + filtering + search land in V1 of D. The point of V0 is
 * that the operator (Ridaa) can see at a glance what's in the funnel
 * without SSHing into the dev PC to `psql` the leads table.
 */
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { listLeads, type LeadRow } from '@/lib/api';

function statusTone(status: string): string {
  // Tailwind classes — green for live conversations, amber for paused,
  // red for terminal-lost, grey for fresh-but-untouched.
  if (status === 'new' || status === 'scored') return 'bg-slate-100 text-slate-700';
  if (status === 'qualifying' || status === 'quoting' || status === 'negotiating') {
    return 'bg-emerald-100 text-emerald-800';
  }
  if (status === 'closed_won') return 'bg-emerald-200 text-emerald-900';
  if (status === 'closed_lost' || status === 'dormant') return 'bg-rose-100 text-rose-800';
  return 'bg-amber-100 text-amber-800';
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}

export default function LeadsPage(): ReactElement {
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'leads'],
    queryFn: () => listLeads({ limit: 50 }),
    refetchInterval: 30_000,
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">
            Les 50 leads les plus récents — rafraîchi toutes les 30 s.
          </p>
        </div>
        <Button onClick={() => void refetch()} disabled={isFetching} variant="default">
          {isFetching ? 'Rafraîchissement…' : 'Rafraîchir'}
        </Button>
      </header>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          Erreur de chargement : {(error as Error).message}
        </div>
      )}

      {isLoading && !data && <div className="text-sm text-muted-foreground">Chargement…</div>}

      {data && data.rows.length === 0 && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-700">
          Aucun lead pour le moment. Les soumissions du formulaire web et les inbounds WhatsApp
          apparaîtront ici.
        </div>
      )}

      {data && data.rows.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Produit</th>
                <th className="px-3 py-2">Statut</th>
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">HubSpot</th>
                <th className="px-3 py-2">Créé</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((r: LeadRow) => (
                <tr key={r.leadId} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-900">
                    {r.customerName ?? <span className="text-slate-400">(sans nom)</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{r.source}</td>
                  <td className="px-3 py-2 text-slate-600">{r.productLine}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(r.status)}`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {r.score ?? <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {r.hubspotDealId ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                        sync
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500" title={r.createdAt}>
                    {relativeTime(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
