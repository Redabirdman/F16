/**
 * Team-chat page (M14.T10).
 *
 * The operator conversation: human-action requests, their resolutions, and
 * messages sent to the WhatsApp operator group — newest first — plus a compose
 * box to post to the group from the admin.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { getTeamChat, sendTeamChat, type TeamChatEntry } from '@/lib/api';

export default function TeamChatPage(): ReactElement {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['admin', 'team-chat'],
    queryFn: () => getTeamChat(50),
    refetchInterval: 15_000,
  });

  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () => sendTeamChat(text.trim()),
    onSuccess: () => {
      setText('');
      void qc.invalidateQueries({ queryKey: ['admin', 'team-chat'] });
    },
  });

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    if (text.trim()) send.mutate();
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Équipe</h1>
        <p className="text-sm text-muted-foreground">
          Demandes de validation, résolutions, et messages au groupe WhatsApp — rafraîchi toutes les
          15 s.
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Écrire un message au groupe WhatsApp (Ridaa + Achraf)…"
          className="h-20 w-full rounded-md border border-slate-300 p-3 text-sm focus:border-sky-400 focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!text.trim() || send.isPending}>
            {send.isPending ? 'Envoi…' : 'Envoyer au groupe'}
          </Button>
          {send.error && (
            <span className="text-xs text-rose-700">{(send.error as Error).message}</span>
          )}
        </div>
      </form>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {(error as Error).message}
        </div>
      )}
      {isLoading && !data && <div className="text-sm text-muted-foreground">Chargement…</div>}

      {data && (
        <ul className="flex flex-col gap-2">
          {data.entries.map((e, i) => (
            <li key={`${e.kind}-${'id' in e ? e.id : i}-${e.at}`}>
              <TimelineEntry entry={e} />
            </li>
          ))}
          {data.entries.length === 0 && (
            <li className="text-sm text-muted-foreground">Aucune activité pour le moment.</li>
          )}
        </ul>
      )}
    </div>
  );
}

const INTENT_LABELS: Record<string, string> = {
  LEAD_DORMANT: 'Lead en sommeil',
  CAMPAIGN_LAUNCH_FAILED: 'Lancement de campagne échoué',
  CAMPAIGN_DRAFT: 'Brouillon de campagne',
  CAMPAIGN_FATIGUE: 'Fatigue créative',
  COMPLIANCE_BLOCKED: 'Message bloqué (conformité)',
  QUOTE_FAILED: 'Échec du devis',
  CONFIG_CHANGE_PROPOSED: 'Changement de config proposé',
  AGENT_LOOP_DETECTED: 'Boucle d’agents détectée',
};

function TimelineEntry({ entry }: { entry: TeamChatEntry }): ReactElement {
  const when = new Date(entry.at).toLocaleString('fr-FR');
  if (entry.kind === 'request') {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-amber-900">
            🟡 À valider — {INTENT_LABELS[entry.intent] ?? entry.intent}
          </span>
          <span className="text-[11px] text-slate-400">{when}</span>
        </div>
        <p className="mt-1 text-sm text-slate-800">{entry.summary}</p>
      </div>
    );
  }
  if (entry.kind === 'resolved') {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-emerald-900">
            ✅ Résolu
            {entry.source ? ` via ${entry.source === 'admin' ? "l'admin" : 'WhatsApp'}` : ''}
            {entry.choice ? ` — ${entry.choice}` : ''}
          </span>
          <span className="text-[11px] text-slate-400">{when}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-sky-200 bg-sky-50 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-sky-900">📤 Envoyé au groupe</span>
        <span className="text-[11px] text-slate-400">{when}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{entry.text}</p>
    </div>
  );
}
