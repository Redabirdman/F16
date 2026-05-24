/**
 * Agents registry page (M15.T2 frontend).
 *
 * Table of agents_state rows with inline kill + priority controls. Only
 * `inMemory:true` agents can be killed (anyone else is already stopped or
 * was registered in a different process). Priority is an integer 0..9
 * persisted in agents_state.meta.priority.
 *
 * Auto-refresh: 15s. Manual refresh + per-row action errors surface
 * inline.
 */
import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { killAgent, listAgents, setAgentPriority, type AgentStateRow } from '@/lib/api';

function statusTone(status: string): string {
  if (status === 'running') return 'bg-emerald-100 text-emerald-800';
  if (status === 'starting' || status === 'stopping') return 'bg-amber-100 text-amber-800';
  if (status === 'crashed') return 'bg-rose-100 text-rose-800';
  return 'bg-slate-100 text-slate-700'; // stopped
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

export default function AgentsPage(): ReactElement {
  const qc = useQueryClient();
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'agents'],
    queryFn: listAgents,
    refetchInterval: 15_000,
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground">
            Registre runtime — kill + ajustement de priorité. Rafraîchi toutes les 15 s.
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

      {data && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Rôle</th>
                <th className="px-3 py-2">Instance</th>
                <th className="px-3 py-2">Statut</th>
                <th className="px-3 py-2">Modèle</th>
                <th className="px-3 py-2">Queue</th>
                <th className="px-3 py-2">Priorité</th>
                <th className="px-3 py-2">Heartbeat</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((r) => (
                <AgentRow
                  key={`${r.role}#${r.instanceId}`}
                  row={r}
                  onChanged={() => {
                    void qc.invalidateQueries({ queryKey: ['admin', 'agents'] });
                  }}
                />
              ))}
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                    Aucun agent enregistré.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AgentRow(props: { row: AgentStateRow; onChanged: () => void }): ReactElement {
  const { row, onChanged } = props;
  const [priorityInput, setPriorityInput] = useState<string>(
    row.priority === null ? '' : String(row.priority),
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const killMutation = useMutation({
    mutationFn: () => killAgent(row.role, row.instanceId),
    onSuccess: () => {
      setErrorMsg(null);
      onChanged();
    },
    onError: (err: Error) => setErrorMsg(err.message),
  });

  const priorityMutation = useMutation({
    mutationFn: (p: number) => setAgentPriority(row.role, row.instanceId, p),
    onSuccess: () => {
      setErrorMsg(null);
      onChanged();
    },
    onError: (err: Error) => setErrorMsg(err.message),
  });

  return (
    <tr className="hover:bg-slate-50">
      <td className="px-3 py-2 font-medium text-slate-900">{row.role}</td>
      <td className="px-3 py-2 font-mono text-xs text-slate-600">{row.instanceId}</td>
      <td className="px-3 py-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(row.status)}`}>
          {row.status}
        </span>
        {row.inMemory && (
          <span className="ml-1 rounded bg-sky-50 px-1 py-0.5 text-[10px] text-sky-700">live</span>
        )}
      </td>
      <td className="px-3 py-2 text-slate-600">{row.model}</td>
      <td className="px-3 py-2 text-slate-600">{row.queue}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            max={9}
            className="w-12 rounded border border-slate-300 px-1 py-0.5 text-xs"
            value={priorityInput}
            onChange={(e) => setPriorityInput(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={priorityMutation.isPending || !priorityInput}
            onClick={() => {
              const p = Number.parseInt(priorityInput, 10);
              if (Number.isFinite(p)) priorityMutation.mutate(p);
            }}
          >
            ↑
          </Button>
        </div>
      </td>
      <td className="px-3 py-2 text-xs text-slate-500" title={row.lastHeartbeatAt}>
        {relativeTime(row.lastHeartbeatAt)}
      </td>
      <td className="px-3 py-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={!row.inMemory || killMutation.isPending}
          onClick={() => killMutation.mutate()}
        >
          {killMutation.isPending ? 'Stop…' : 'Kill'}
        </Button>
        {errorMsg && (
          <div className="mt-1 rounded border border-rose-200 bg-rose-50 px-1 py-0.5 text-[10px] text-rose-700">
            {errorMsg}
          </div>
        )}
      </td>
    </tr>
  );
}
