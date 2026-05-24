/**
 * Human-action queue page (M14.T5).
 *
 * Lists every pending human_action (severity-first, oldest-first) with
 * inline approve/reject/revise/whatever-options buttons. Calls the
 * idempotent admin resolve endpoint (which also emits HUMAN_ACTION.RESOLVED
 * so the Reporter Agent posts the closure in the WhatsApp group).
 *
 * Auto-refreshes every 10s — when Ridaa/Achraf resolve from the WA group
 * the row disappears from the list within the next tick. Manual refresh
 * button is also available.
 */
import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import {
  listPendingHumanActions,
  resolveHumanAction,
  type HumanActionOption,
  type HumanActionRow,
} from '@/lib/api';

const SEVERITY_LABEL: Record<number, { glyph: string; tone: string; label: string }> = {
  1: { glyph: '🔴', tone: 'bg-rose-100 text-rose-800', label: 'CRITIQUE' },
  2: { glyph: '🟡', tone: 'bg-amber-100 text-amber-800', label: 'STANDARD' },
  3: { glyph: '🟢', tone: 'bg-emerald-100 text-emerald-800', label: 'INFO' },
};

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

export default function HumanActionsPage(): ReactElement {
  const qc = useQueryClient();
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'human-actions'],
    queryFn: () => listPendingHumanActions({ limit: 100 }),
    refetchInterval: 10_000,
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">File des actions humaines</h1>
          <p className="text-sm text-muted-foreground">
            Actions en attente — rafraîchi toutes les 10 s. Résoudre ici envoie aussi la fermeture
            dans le groupe WhatsApp.
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
          Aucune action en attente. Bien joué.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {data?.rows.map((row) => (
          <ActionCard
            key={row.id}
            row={row}
            onResolved={() => {
              void qc.invalidateQueries({ queryKey: ['admin', 'human-actions'] });
            }}
          />
        ))}
      </div>
    </div>
  );
}

const SEVERITY_DEFAULT = { glyph: '🟡', tone: 'bg-amber-100 text-amber-800', label: 'STANDARD' };

function ActionCard(props: { row: HumanActionRow; onResolved: () => void }): ReactElement {
  const { row, onResolved } = props;
  const severity = SEVERITY_LABEL[row.severity] ?? SEVERITY_DEFAULT;
  const [pendingOptionId, setPendingOptionId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (option: HumanActionOption) =>
      resolveHumanAction(row.id, { chosenOptionId: option.id, by: 'admin-ui' }),
    onMutate: (option) => {
      setPendingOptionId(option.id);
      setErrorMsg(null);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message);
      setPendingOptionId(null);
    },
    onSuccess: () => {
      setPendingOptionId(null);
      onResolved();
    },
  });

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-xs">
            <span className={`rounded-full px-2 py-0.5 font-medium ${severity.tone}`}>
              {severity.glyph} {severity.label}
            </span>
            <span className="font-mono text-slate-500">{row.intent}</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-500">{row.createdByAgent}</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-500">{relativeTime(row.createdAt)}</span>
          </div>
          <p className="text-sm text-slate-800">{row.summary}</p>
          {row.correlationId && (
            <p className="text-xs text-slate-500">Lead/quote : {row.correlationId}</p>
          )}
        </div>
        <span className="shrink-0 font-mono text-[10px] text-slate-400">{row.id.slice(0, 8)}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {row.options.map((opt) => (
          <Button
            key={opt.id}
            variant={opt.kind === 'reject' ? 'destructive' : 'default'}
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(opt)}
          >
            {pendingOptionId === opt.id ? 'Envoi…' : opt.label}
          </Button>
        ))}
      </div>
      {errorMsg && (
        <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700">
          {errorMsg}
        </div>
      )}
    </div>
  );
}
