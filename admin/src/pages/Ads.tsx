/**
 * Ads page (M14 V2.5).
 *
 * Surfaces the M12 ads pipeline for Ridaa/Achraf:
 *   - Campagnes  — Meta campaigns mirrored locally (status, budget, counts).
 *   - Créatifs   — the Assuryal-side creative asset registry (angle, format,
 *                  copy, preview).
 *   - Apprentissages — `creative_learnings`: the durable, reusable guidance the
 *                  system DISTILLED from Ridaa's feedback and injects into every
 *                  future creative prompt (the "learn, don't hardcode" mandate
 *                  made visible).
 *
 * Read-only. Auto-refreshes every 60s; manual refresh available.
 */
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import {
  getAds,
  type AdminCampaign,
  type AdminCreative,
  type AdminCreativeLearning,
} from '@/lib/api';

function formatBudget(cents: number | null, currency: string): string {
  if (cents === null) return '—';
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function statusTone(status: string | null): string {
  const s = (status ?? '').toUpperCase();
  if (s === 'ACTIVE') return 'bg-emerald-50 border-emerald-200 text-emerald-900';
  if (s === 'PAUSED') return 'bg-amber-50 border-amber-200 text-amber-900';
  if (s === 'DELETED' || s === 'ARCHIVED') return 'bg-slate-100 border-slate-200 text-slate-500';
  return 'bg-slate-50 border-slate-200 text-slate-700';
}

export default function AdsPage(): ReactElement {
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'ads'],
    queryFn: getAds,
    refetchInterval: 60_000,
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Publicités</h1>
          <p className="text-sm text-muted-foreground">
            Campagnes Meta, créatifs et apprentissages — rafraîchi toutes les 60 s.
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
        <>
          <CampaignsSection campaigns={data.campaigns} />
          <CreativesSection creatives={data.creatives} />
          <LearningsSection learnings={data.learnings} />
          <p className="text-xs text-slate-500">
            Généré à {new Date(data.generatedAt).toLocaleString('fr-FR')}.
          </p>
        </>
      )}
    </div>
  );
}

function SectionTitle({ title, count }: { title: string; count: number }): ReactElement {
  return (
    <h2 className="text-lg font-semibold tracking-tight">
      {title} <span className="text-sm font-normal text-slate-500">({count})</span>
    </h2>
  );
}

function CampaignsSection({ campaigns }: { campaigns: AdminCampaign[] }): ReactElement {
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle title="Campagnes" count={campaigns.length} />
      {campaigns.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune campagne pour le moment.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Nom</th>
                <th className="px-3 py-2">Statut</th>
                <th className="px-3 py-2">Objectif</th>
                <th className="px-3 py-2">Produit</th>
                <th className="px-3 py-2">Budget/j</th>
                <th className="px-3 py-2">Ad sets</th>
                <th className="px-3 py-2">Annonces</th>
                <th className="px-3 py-2">Créée</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((cp) => (
                <tr key={cp.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{cp.name}</div>
                    <div className="text-[11px] text-slate-400">{cp.metaCampaignId}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${statusTone(cp.status)}`}
                    >
                      {cp.status ?? '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{cp.objective ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-600">{cp.productLine ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {formatBudget(cp.dailyBudgetCents, cp.currency)}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{cp.adsetCount}</td>
                  <td className="px-3 py-2 text-slate-600">{cp.adCount}</td>
                  <td className="px-3 py-2 text-slate-500">
                    {new Date(cp.createdAt).toLocaleDateString('fr-FR')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CreativesSection({ creatives }: { creatives: AdminCreative[] }): ReactElement {
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle title="Créatifs" count={creatives.length} />
      {creatives.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun créatif généré pour le moment.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {creatives.map((cr) => (
            <div
              key={cr.id}
              className="flex flex-col gap-2 rounded-md border border-slate-200 p-4 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-900">{cr.name}</span>
                <span className="text-[11px] text-slate-400">{cr.format}</span>
              </div>
              <div className="flex flex-wrap gap-1 text-[11px]">
                <span className="rounded bg-sky-50 px-1.5 py-0.5 text-sky-700">{cr.angle}</span>
                {cr.productLine && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                    {cr.productLine}
                  </span>
                )}
                {cr.generatedBy && (
                  <span className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-700">
                    {cr.generatedBy}
                  </span>
                )}
              </div>
              {cr.headline && <p className="text-sm font-medium text-slate-800">{cr.headline}</p>}
              {cr.subCopy && <p className="text-xs text-slate-600">{cr.subCopy}</p>}
              {cr.ctaText && (
                <p className="text-[11px] uppercase text-slate-500">CTA : {cr.ctaText}</p>
              )}
              <a
                href={cr.fileUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-auto truncate text-[11px] text-sky-700 hover:underline"
                title={cr.fileUrl}
              >
                {cr.fileUrl}
              </a>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function LearningsSection({ learnings }: { learnings: AdminCreativeLearning[] }): ReactElement {
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle title="Apprentissages créatifs" count={learnings.length} />
      <p className="-mt-2 text-xs text-muted-foreground">
        Consignes distillées des retours de Ridaa et injectées dans chaque futur prompt créatif.
      </p>
      {learnings.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucun apprentissage enregistré pour le moment.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {learnings.map((l) => (
            <div key={l.id} className="rounded-md border border-indigo-100 bg-indigo-50/40 p-4">
              <div className="mb-1 flex items-center gap-2">
                <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[11px] font-medium text-indigo-800">
                  {l.angle ?? 'global'}
                </span>
                <span className="text-[11px] text-slate-400">
                  {new Date(l.createdAt).toLocaleDateString('fr-FR')}
                  {l.createdByAgent ? ` · ${l.createdByAgent}` : ''}
                </span>
              </div>
              <p className="text-sm text-slate-900">{l.guidance}</p>
              {l.sourceFeedback && (
                <p className="mt-1 text-xs italic text-slate-500">« {l.sourceFeedback} »</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
