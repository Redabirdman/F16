/**
 * Prompts page (M14.T6).
 *
 * Edit any agent's system prompt from the admin. The list (grouped by agent) is
 * the prompt registry; selecting one opens an editor showing the read-only code
 * default + an editable override. Saving takes effect on the agent's NEXT
 * message; "Réinitialiser" reverts to the code default. Every change is audited.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { listPrompts, savePrompt, resetPrompt, type PromptInfo } from '@/lib/api';

export default function PromptsPage(): ReactElement {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['admin', 'prompts'],
    queryFn: listPrompts,
    refetchInterval: 60_000,
  });

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const prompts = useMemo(() => data?.prompts ?? [], [data]);
  // Derive the effective selection (default to the first) — no setState-in-effect.
  const effectiveKey = selectedKey ?? prompts[0]?.key ?? null;
  const selected = prompts.find((p) => p.key === effectiveKey) ?? null;

  const grouped = useMemo(() => {
    const m = new Map<string, PromptInfo[]>();
    for (const p of prompts) {
      const arr = m.get(p.agentRole) ?? [];
      arr.push(p);
      m.set(p.agentRole, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [prompts]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Prompts des agents</h1>
        <p className="text-sm text-muted-foreground">
          Modifie le prompt système d’un agent — pris en compte dès son prochain message. Audité +
          réversible.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {(error as Error).message}
        </div>
      )}
      {isLoading && !data && <div className="text-sm text-muted-foreground">Chargement…</div>}

      {data && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-[260px_1fr]">
          <nav className="flex flex-col gap-3">
            {grouped.map(([role, items]) => (
              <div key={role}>
                <div className="mb-1 text-xs font-semibold uppercase text-slate-400">{role}</div>
                <ul className="flex flex-col gap-0.5">
                  {items.map((p) => (
                    <li key={p.key}>
                      <button
                        onClick={() => setSelectedKey(p.key)}
                        className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm ${
                          p.key === effectiveKey ? 'bg-sky-100 text-sky-900' : 'hover:bg-slate-100'
                        }`}
                      >
                        <span>{p.label}</span>
                        {p.isOverridden && (
                          <span className="ml-2 rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">
                            modifié
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          {selected ? (
            <PromptEditor
              key={selected.key}
              prompt={selected}
              onChanged={() => void qc.invalidateQueries({ queryKey: ['admin', 'prompts'] })}
            />
          ) : (
            <div className="text-sm text-muted-foreground">Sélectionne un prompt.</div>
          )}
        </div>
      )}
    </div>
  );
}

function PromptEditor({
  prompt,
  onChanged,
}: {
  prompt: PromptInfo;
  onChanged: () => void;
}): ReactElement {
  const [draft, setDraft] = useState(prompt.override ?? prompt.default);

  const save = useMutation({
    mutationFn: () => savePrompt(prompt.key, draft),
    onSuccess: onChanged,
  });
  const reset = useMutation({
    mutationFn: () => resetPrompt(prompt.key),
    onSuccess: onChanged,
  });

  const dirty = draft.trim() !== (prompt.override ?? prompt.default).trim();

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">{prompt.label}</h2>
        <p className="text-xs text-muted-foreground">{prompt.description}</p>
        <p className="mt-1 text-[11px] text-slate-400">
          clé <code>{prompt.key}</code>
          {prompt.isOverridden
            ? ` · modifié${prompt.updatedAt ? ' le ' + new Date(prompt.updatedAt).toLocaleString('fr-FR') : ''}`
            : ' · défaut du code'}
        </p>
      </div>

      <label className="text-xs font-medium text-slate-600">Override (éditable)</label>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="h-80 w-full rounded-md border border-slate-300 p-3 font-mono text-xs leading-relaxed focus:border-sky-400 focus:outline-none"
      />

      <div className="flex items-center gap-2">
        <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
          {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
        </Button>
        <Button
          variant="outline"
          onClick={() => reset.mutate()}
          disabled={!prompt.isOverridden || reset.isPending}
        >
          {reset.isPending ? 'Réinitialisation…' : 'Réinitialiser (défaut)'}
        </Button>
        {(save.error || reset.error) && (
          <span className="text-xs text-rose-700">
            {((save.error ?? reset.error) as Error).message}
          </span>
        )}
      </div>

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-slate-500">
          Voir le défaut du code (lecture seule)
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-[11px]">
          {prompt.default}
        </pre>
      </details>
    </div>
  );
}
