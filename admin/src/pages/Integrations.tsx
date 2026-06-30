/**
 * Integrations health page (M14.T7).
 *
 * Tile per integration: name, status badge, optional probe duration,
 * optional error detail. Auto-refreshes every 30s; manual refresh available.
 *
 * "Unconfigured" tiles (no env var set) are de-emphasised — they don't
 * imply a problem, just "not in use." Operators care about anything
 * `required: true` going red.
 */
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { getIntegrationsHealth, type IntegrationHealth, type IntegrationStatus } from '@/lib/api';

const STATUS_PRESENTATION: Record<
  IntegrationStatus,
  { tone: string; glyph: string; label: string }
> = {
  ok: { tone: 'bg-emerald-50 border-emerald-200 text-emerald-900', glyph: '✅', label: 'OK' },
  degraded: {
    tone: 'bg-amber-50 border-amber-200 text-amber-900',
    glyph: '⚠️',
    label: 'Dégradé',
  },
  unreachable: { tone: 'bg-rose-50 border-rose-200 text-rose-900', glyph: '🔴', label: 'KO' },
  unconfigured: {
    tone: 'bg-slate-50 border-slate-200 text-slate-600',
    glyph: '○',
    label: 'Non configuré',
  },
};

const INTEGRATION_LABELS: Record<string, string> = {
  waha: 'WhatsApp',
  hubspot: 'HubSpot CRM',
  openai_sip: 'Voix IA (OpenAI SIP)',
  voice: 'Voix (OVH / Asterisk)',
  maxance: 'Maxance (broker)',
  anthropic: 'Anthropic API',
  openrouter: 'OpenRouter',
  email: 'Email',
};

export default function IntegrationsPage(): ReactElement {
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'integrations'],
    queryFn: getIntegrationsHealth,
    refetchInterval: 30_000,
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Intégrations</h1>
          <p className="text-sm text-muted-foreground">
            État des services externes — rafraîchi toutes les 30 s.
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
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {data.integrations.map((i) => (
              <IntegrationTile key={i.name} integration={i} />
            ))}
          </div>
          <p className="text-xs text-slate-500">
            Généré à {new Date(data.generatedAt).toLocaleString('fr-FR')}.
          </p>
        </>
      )}
    </div>
  );
}

function IntegrationTile({ integration }: { integration: IntegrationHealth }): ReactElement {
  const p = STATUS_PRESENTATION[integration.status];
  const displayName = INTEGRATION_LABELS[integration.name] ?? integration.name;
  return (
    <div className={`flex flex-col gap-2 rounded-md border p-4 shadow-sm ${p.tone}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{displayName}</span>
        <span className="text-xs font-medium">
          {p.glyph} {p.label}
        </span>
      </div>
      {integration.detail && <p className="text-xs opacity-80">{integration.detail}</p>}
      <div className="flex items-center justify-between text-[11px] opacity-70">
        <span>{integration.required ? 'requis' : 'optionnel'}</span>
        {integration.durationMs !== undefined && <span>{integration.durationMs} ms</span>}
      </div>
    </div>
  );
}
