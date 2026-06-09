/**
 * Knowledge search page (M14.T8).
 *
 * A search bar over the RAG corpus (`knowledge_chunks`) — the Maxance product
 * catalog, Assuryal KB, FAQ, pricing rules. Runs the SAME embed→kNN retrieval
 * the Sales Agent's `knowledge.search` tool uses, so Ridaa/Achraf see exactly
 * what the agents would surface for a question. Read-only.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { searchKnowledge, type KnowledgeSearchHit } from '@/lib/api';

export default function KnowledgePage(): ReactElement {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');

  const { data, error, isFetching } = useQuery({
    queryKey: ['admin', 'knowledge', query],
    queryFn: () => searchKnowledge(query, 10),
    enabled: query.trim().length >= 2,
  });

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    setQuery(input.trim());
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Base de connaissances</h1>
        <p className="text-sm text-muted-foreground">
          Recherche sémantique sur ce que les agents savent (catalogue Maxance, FAQ, tarifs).
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="ex. tarif trottinette, garantie vol, devis moto 125…"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
        />
        <Button type="submit" disabled={input.trim().length < 2 || isFetching}>
          {isFetching ? 'Recherche…' : 'Rechercher'}
        </Button>
      </form>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {(error as Error).message}
        </div>
      )}

      {data && (
        <>
          <p className="text-xs text-slate-500">
            {data.results.length} résultat{data.results.length === 1 ? '' : 's'} pour « {data.query}{' '}
            ».
          </p>
          <div className="flex flex-col gap-3">
            {data.results.map((h) => (
              <ResultCard key={h.id} hit={h} />
            ))}
            {data.results.length === 0 && (
              <p className="text-sm text-muted-foreground">Aucun chunk pertinent trouvé.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ResultCard({ hit }: { hit: KnowledgeSearchHit }): ReactElement {
  const pct = Math.round(hit.similarity * 100);
  // Green when clearly relevant, amber mid, slate low — quick visual scan.
  const tone =
    hit.similarity >= 0.75
      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
      : hit.similarity >= 0.55
        ? 'bg-amber-50 border-amber-200 text-amber-800'
        : 'bg-slate-100 border-slate-200 text-slate-600';
  return (
    <div className="rounded-md border border-slate-200 p-4 shadow-sm">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500">
          {hit.source}
          {hit.sourcePath ? ` · ${hit.sourcePath}` : ''}
        </span>
        <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>
          {pct}%
        </span>
      </div>
      <p className="whitespace-pre-wrap text-sm text-slate-800">{hit.chunkText}</p>
      {hit.sourceUrl && (
        <a
          href={hit.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block truncate text-[11px] text-sky-700 hover:underline"
        >
          {hit.sourceUrl}
        </a>
      )}
    </div>
  );
}
