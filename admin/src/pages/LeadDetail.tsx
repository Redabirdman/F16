/**
 * Lead-detail page (redesign 2026-07-08).
 *
 * Full-width version of the shared LeadDetailView (at-a-glance card +
 * unified timeline). Deep-link target from the dashboard activity feed,
 * the callbacks card and small-screen /leads rows.
 */
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { getLeadDetail } from '@/lib/api';
import { LeadDetailView } from '@/components/lead-detail-view';

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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 lg:p-6">
      <header className="flex items-center justify-between">
        <div>
          <Link to="/leads" className="text-xs font-medium text-indigo-700 hover:underline">
            ← Retour aux leads
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
            {data?.customer?.displayName ?? 'Dossier lead'}
          </h1>
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

      {data && <LeadDetailView data={data} />}
    </div>
  );
}
