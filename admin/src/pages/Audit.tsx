/**
 * Audit-log page (M13).
 *
 * Filter strip + paginated table + ACPR forensic export button. The
 * export opens the streaming NDJSON endpoint as a browser download,
 * which is suitable for both quick spot-checks (small filter window)
 * and full-year regulator dumps (unconstrained filter — the backend
 * iterator is bounded-memory).
 *
 * "Redact PII on export" toggle defaults to ON: even though we control
 * what gets written to audit rows, the export boundary applies
 * defense-in-depth before anything leaves the building.
 */
import { useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { buildAuditExportUrl, listAudit, type AuditRow, type ListAuditOptions } from '@/lib/api';

function isoOrNull(s: string): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

export default function AuditPage(): ReactElement {
  const [actionPrefix, setActionPrefix] = useState('');
  const [actorId, setActorId] = useState('');
  const [targetType, setTargetType] = useState('');
  const [targetId, setTargetId] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [redactPii, setRedactPii] = useState(true);
  const [offset, setOffset] = useState(0);
  const limit = 100;

  const filters: ListAuditOptions = {
    limit,
    offset,
  };
  if (actionPrefix) filters.actionPrefix = actionPrefix;
  if (actorId) filters.actorId = actorId;
  if (targetType) filters.targetType = targetType;
  if (targetId) filters.targetId = targetId;
  const sinceIso = isoOrNull(since);
  const untilIso = isoOrNull(until);
  if (sinceIso) filters.since = sinceIso;
  if (untilIso) filters.until = untilIso;

  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'audit', filters],
    queryFn: () => listAudit(filters),
    refetchInterval: 60_000,
  });

  // Drop limit + offset from the export — the streaming endpoint walks the
  // full filter window in chunks, paging is a UI-only concept.
  const { limit: _limit, offset: _offset, ...exportFilters } = filters;
  void _limit;
  void _offset;
  const exportUrl = buildAuditExportUrl({ ...exportFilters, redactPii });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
          <p className="text-sm text-muted-foreground">
            Journal des actions agent + humain. Export NDJSON conforme ACPR.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? 'Rafraîchissement…' : 'Rafraîchir'}
          </Button>
          <a href={exportUrl}>
            <Button variant="default">Exporter NDJSON</Button>
          </a>
        </div>
      </header>

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-4">
          <Input
            label="Action préfixe"
            value={actionPrefix}
            onChange={setActionPrefix}
            placeholder="lead.status."
          />
          <Input
            label="Acteur ID"
            value={actorId}
            onChange={setActorId}
            placeholder="sales-agent#lead-..."
          />
          <Input
            label="Type cible"
            value={targetType}
            onChange={setTargetType}
            placeholder="lead"
          />
          <Input label="ID cible" value={targetId} onChange={setTargetId} placeholder="uuid" />
          <Input
            label="Depuis (UTC, ISO ou date)"
            value={since}
            onChange={setSince}
            placeholder="2026-05-01"
          />
          <Input
            label="Jusqu'à (UTC, ISO ou date)"
            value={until}
            onChange={setUntil}
            placeholder="2026-05-31"
          />
          <label className="col-span-1 flex items-center gap-2 self-end text-sm text-slate-700">
            <input
              type="checkbox"
              checked={redactPii}
              onChange={(e) => setRedactPii(e.target.checked)}
            />
            Rédacter PII à l&apos;export
          </label>
          <div className="col-span-1 flex items-end justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setActionPrefix('');
                setActorId('');
                setTargetType('');
                setTargetId('');
                setSince('');
                setUntil('');
                setOffset(0);
              }}
            >
              Réinitialiser
            </Button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          Erreur de chargement : {(error as Error).message}
        </div>
      )}

      {isLoading && !data && <div className="text-sm text-muted-foreground">Chargement…</div>}

      {data && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Quand</th>
                <th className="px-3 py-2">Acteur</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Cible</th>
                <th className="px-3 py-2">Avant → Après</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((r) => (
                <AuditRowView key={r.id} r={r} />
              ))}
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                    Aucune entrée pour ces filtres.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span>
              {data.pagination.returned} rangée(s) — offset {data.pagination.offset}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                Précédent
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={data.pagination.returned < limit}
                onClick={() => setOffset(offset + limit)}
              >
                Suivant
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Input(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-700">
      <span className="font-medium uppercase tracking-wide text-slate-500">{props.label}</span>
      <input
        className="rounded border border-slate-200 px-2 py-1 text-sm shadow-sm focus:border-sky-500 focus:outline-none"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder ?? ''}
      />
    </label>
  );
}

function AuditRowView({ r }: { r: AuditRow }): ReactElement {
  return (
    <tr className="hover:bg-slate-50">
      <td className="whitespace-nowrap px-3 py-2 text-slate-600">{formatTime(r.occurredAt)}</td>
      <td className="px-3 py-2">
        <span className="font-medium text-slate-800">{r.actorType}</span>{' '}
        <span className="text-slate-500">{r.actorId}</span>
      </td>
      <td className="px-3 py-2 font-mono text-slate-700">{r.action}</td>
      <td className="px-3 py-2 text-slate-600">
        {r.targetType ? (
          <>
            {r.targetType}
            {r.targetId ? (
              <>
                {' '}
                · <span className="font-mono">{r.targetId.slice(0, 8)}</span>
              </>
            ) : null}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="px-3 py-2">
        <details className="text-slate-700">
          <summary className="cursor-pointer text-sky-700">Voir</summary>
          <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-[11px]">
            {JSON.stringify({ before: r.before, after: r.after, meta: r.meta }, null, 2)}
          </pre>
        </details>
      </td>
    </tr>
  );
}
