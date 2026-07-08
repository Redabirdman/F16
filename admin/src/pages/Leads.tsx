/**
 * Leads page (redesign 2026-07-08) — master-detail.
 *
 * Left: searchable, filterable lead list (avatars + stage chips + relative
 * time). Right (xl screens): the selected lead's full at-a-glance view +
 * unified timeline, inline. On smaller screens a row click navigates to
 * the dedicated /leads/:id page instead.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { getLeadDetail, listLeads, type LeadRow } from '@/lib/api';
import { LeadDetailView } from '@/components/lead-detail-view';
import { initialsOf, STAGE_LABEL_FR, statusTone } from '@/lib/lead-format';

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

const FILTERS: Array<{ id: string; label: string; statuses: string[] | null }> = [
  { id: 'all', label: 'Tous', statuses: null },
  {
    id: 'active',
    label: 'En cours',
    statuses: ['new', 'scored', 'qualifying', 'quoting', 'negotiating', 'awaiting_payment'],
  },
  { id: 'won', label: 'Gagnés', statuses: ['closed_won'] },
  { id: 'lost', label: 'Perdus / dormants', statuses: ['closed_lost', 'dormant'] },
];

export default function LeadsPage(): ReactElement {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'leads'],
    queryFn: () => listLeads({ limit: 100 }),
    refetchInterval: 30_000,
  });

  const rows = useMemo(() => {
    let out = data?.rows ?? [];
    const f = FILTERS.find((x) => x.id === filter);
    const statuses = f?.statuses;
    if (statuses) out = out.filter((r) => statuses.includes(r.status));
    const q = search.trim().toLowerCase();
    if (q.length > 0) {
      out = out.filter(
        (r) =>
          (r.customerName ?? '').toLowerCase().includes(q) ||
          r.source.toLowerCase().includes(q) ||
          r.status.toLowerCase().includes(q),
      );
    }
    return out;
  }, [data, filter, search]);

  // Default selection: newest lead (xl split view only).
  const effectiveSelected = selectedId ?? rows[0]?.leadId ?? null;

  const detail = useQuery({
    queryKey: ['admin', 'lead-detail', effectiveSelected],
    queryFn: () => getLeadDetail(effectiveSelected ?? ''),
    enabled: effectiveSelected !== null,
    refetchInterval: 15_000,
  });

  const onRowClick = (r: LeadRow): void => {
    // xl screens keep the split view; smaller screens go to the full page.
    if (globalThis.matchMedia?.('(min-width: 1280px)').matches) {
      setSelectedId(r.leadId);
    } else {
      navigate(`/leads/${r.leadId}`);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 p-4 lg:p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Leads</h1>
          <p className="text-sm text-muted-foreground">
            {rows.length} lead{rows.length > 1 ? 's' : ''} affiché{rows.length > 1 ? 's' : ''} —
            clic pour ouvrir le dossier.
          </p>
        </div>
        <Button onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? 'Rafraîchissement…' : 'Rafraîchir'}
        </Button>
      </header>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          Erreur de chargement : {(error as Error).message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
        {/* Master list */}
        <section className="flex flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher un client…"
              className="w-full rounded-xl border border-border bg-white py-2 pl-9 pr-3 text-sm shadow-sm outline-none ring-ring placeholder:text-slate-400 focus:ring-2"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  filter === f.id
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-white text-slate-600 ring-1 ring-border hover:bg-accent'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {isLoading && !data && <div className="text-sm text-muted-foreground">Chargement…</div>}

          {data && rows.length === 0 && (
            <div className="rounded-xl border border-border bg-white p-6 text-center text-sm text-slate-600">
              Aucun lead ne correspond.
            </div>
          )}

          <ul className="flex max-h-[calc(100vh-260px)] flex-col gap-1.5 overflow-y-auto pr-1">
            {rows.map((r) => {
              const active = r.leadId === effectiveSelected;
              return (
                <li key={r.leadId}>
                  <button
                    onClick={() => onRowClick(r)}
                    className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                      active
                        ? 'border-indigo-200 bg-indigo-50/70 shadow-sm'
                        : 'border-border bg-white hover:bg-accent'
                    }`}
                  >
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {initialsOf(r.customerName)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-900">
                        {r.customerName ?? '(sans nom)'}
                      </span>
                      <span className="block text-[11px] text-slate-500">
                        {r.source} · {relativeTime(r.createdAt)}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(r.status)}`}
                    >
                      {STAGE_LABEL_FR[r.status] ?? r.status}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Detail panel — xl only (smaller screens navigate to /leads/:id). */}
        <section className="hidden xl:block">
          {effectiveSelected === null && (
            <div className="rounded-xl border border-dashed border-border bg-white/60 p-10 text-center text-sm text-muted-foreground">
              Sélectionnez un lead pour voir son dossier.
            </div>
          )}
          {detail.isLoading && effectiveSelected !== null && (
            <div className="text-sm text-muted-foreground">Chargement du dossier…</div>
          )}
          {detail.error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              {(detail.error as Error).message}
            </div>
          )}
          {detail.data && <LeadDetailView data={detail.data} />}
        </section>
      </div>
    </div>
  );
}
