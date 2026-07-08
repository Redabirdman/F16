/**
 * LeadDetailView (redesign 2026-07-08) — the lead-centric "Khalid view".
 *
 * Ridaa's requirement: for any lead I must see AT A GLANCE — stage, what's
 * been done, calls programmed/completed, devis sent, closed or not.
 *
 * Layout:
 *   1. Header card — avatar + name + stage stepper + quick-stat chips
 *      (devis envoyés, appels, rappel programmé, source, score).
 *   2. Unified chronological timeline — conversation turns as chat bubbles,
 *      system events / devis milestones / escalations as inline chips.
 *
 * Shared by the /leads master-detail right panel AND the /leads/:id page.
 */
import type { ReactElement } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  FileCheck2,
  FileClock,
  Phone,
  Sparkles,
} from 'lucide-react';

import type { LeadDetail } from '@/lib/api';
import { personaFor } from '@/lib/personas';
import { initialsOf, STAGE_LABEL_FR } from '@/lib/lead-format';

const STAGES = [
  'new',
  'scored',
  'qualifying',
  'quoting',
  'negotiating',
  'awaiting_payment',
  'closed_won',
] as const;

const SOURCE_LABEL_FR: Record<string, string> = {
  website: 'Site web',
  meta: 'Publicité Facebook',
  whatsapp: 'WhatsApp entrant',
  simulation: 'Simulation',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

// ---------------------------------------------------------------------------
// Header — at-a-glance card
// ---------------------------------------------------------------------------

function StageStepper({ status }: { status: string }): ReactElement {
  const terminalBad = status === 'closed_lost' || status === 'dormant';
  const idx = STAGES.indexOf(status as (typeof STAGES)[number]);
  return (
    <div className="flex items-center gap-1">
      {STAGES.map((s, i) => {
        const reached = idx >= 0 && i <= idx;
        return (
          <div
            key={s}
            className="flex flex-1 flex-col items-center gap-1"
            title={STAGE_LABEL_FR[s]}
          >
            <div
              className={`h-1.5 w-full rounded-full ${
                terminalBad
                  ? 'bg-rose-200'
                  : reached
                    ? 'bg-gradient-to-r from-indigo-500 to-violet-500'
                    : 'bg-slate-200'
              }`}
            />
            <span
              className={`hidden text-[9px] leading-none sm:block ${
                reached && !terminalBad ? 'font-semibold text-indigo-700' : 'text-slate-400'
              }`}
            >
              {STAGE_LABEL_FR[s]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function StatChip(props: {
  icon: ReactElement;
  label: string;
  tone?: string | undefined;
}): ReactElement {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        props.tone ?? 'bg-slate-100 text-slate-700'
      } [&>svg]:h-3.5 [&>svg]:w-3.5`}
    >
      {props.icon}
      {props.label}
    </span>
  );
}

export function LeadGlanceCard({ data }: { data: LeadDetail }): ReactElement {
  const name = data.customer?.displayName ?? '(sans nom)';
  const devisSent = data.quotes.filter((q) => q.maxanceDevisNumber !== null);
  const callsDone = data.events.filter(
    (e) => e.action === 'voice.call.originated' || e.action === 'voice.call.ended',
  );
  const callsPlaced = data.events.filter((e) => e.action === 'voice.call.originated').length;
  const closed = data.lead.status === 'closed_won' || data.lead.status === 'closed_lost';
  const callbackDueAt = data.lead.callbackState === 'pending' ? data.lead.callbackDueAt : null;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Saturated indigo header — the FINNOVA detail-panel accent. */}
      <div className="bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-4 text-white">
        <div className="flex items-center gap-3.5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/20 text-base font-bold">
            {initialsOf(data.customer?.displayName ?? null)}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold leading-tight">
              {data.customer?.civility ? `${data.customer.civility} ` : ''}
              {name}
            </h2>
            <p className="text-xs text-indigo-100">
              {SOURCE_LABEL_FR[data.lead.source] ?? data.lead.source} · arrivé le{' '}
              {new Date(data.lead.createdAt).toLocaleDateString('fr-FR', {
                day: 'numeric',
                month: 'long',
              })}
              {data.lead.score !== null ? ` · score ${data.lead.score}` : ''}
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              closed
                ? data.lead.status === 'closed_won'
                  ? 'bg-emerald-400 text-emerald-950'
                  : 'bg-rose-400 text-rose-950'
                : 'bg-white/20 text-white'
            }`}
          >
            {STAGE_LABEL_FR[data.lead.status] ?? data.lead.status}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        <StageStepper status={data.lead.status} />

        <div className="flex flex-wrap gap-2">
          <StatChip
            icon={<FileCheck2 />}
            label={
              devisSent.length > 0
                ? `${devisSent.length} devis envoyé${devisSent.length > 1 ? 's' : ''} (${devisSent
                    .map((q) => q.maxanceDevisNumber)
                    .join(', ')})`
                : 'Aucun devis envoyé'
            }
            tone={devisSent.length > 0 ? 'bg-emerald-100 text-emerald-800' : undefined}
          />
          <StatChip
            icon={<Phone />}
            label={
              callsPlaced > 0
                ? `${callsPlaced} appel${callsPlaced > 1 ? 's' : ''} passé${callsPlaced > 1 ? 's' : ''}`
                : callsDone.length > 0
                  ? `${callsDone.length} appel(s)`
                  : 'Aucun appel'
            }
            tone={callsPlaced > 0 ? 'bg-violet-100 text-violet-800' : undefined}
          />
          {callbackDueAt !== null && (
            <StatChip
              icon={<CalendarClock />}
              label={`Rappel prévu ${new Date(callbackDueAt).toLocaleString('fr-FR', {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}`}
              tone="bg-amber-100 text-amber-800"
            />
          )}
          {data.humanActions.some((a) => a.status === 'pending') && (
            <StatChip
              icon={<AlertTriangle />}
              label="Escalade en attente"
              tone="bg-rose-100 text-rose-800"
            />
          )}
          {data.lead.hubspotDealId && (
            <StatChip icon={<CheckCircle2 />} label="Synchronisé HubSpot" />
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Unified timeline
// ---------------------------------------------------------------------------

type TimelineItem =
  | { kind: 'turn'; at: string; turn: LeadDetail['turns'][number] }
  | {
      kind: 'quote';
      at: string;
      label: string;
      tone: 'progress' | 'done';
    }
  | { kind: 'event'; at: string; label: string }
  | { kind: 'action'; at: string; label: string; pending: boolean };

function buildTimeline(data: LeadDetail): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const t of data.turns) items.push({ kind: 'turn', at: t.occurredAt, turn: t });
  for (const q of data.quotes) {
    const variant = q.productVariant === 'trottinette' ? 'trottinette' : q.productVariant;
    items.push({
      kind: 'quote',
      at: q.requestedAt,
      label: `Tarification lancée (${variant})`,
      tone: 'progress',
    });
    if (q.maxanceDevisNumber) {
      items.push({
        kind: 'quote',
        at: q.deliveredAt ?? q.readyAt ?? q.requestedAt,
        label: `Devis ${q.maxanceDevisNumber}${
          q.monthlyPremiumEur !== null ? ` — ${q.monthlyPremiumEur.toFixed(2)} €/mois` : ''
        }${q.deliveredAt ? ' · livré au client' : ''}`,
        tone: 'done',
      });
    }
  }
  for (const e of data.events) items.push({ kind: 'event', at: e.at, label: e.label });
  for (const a of data.humanActions) {
    items.push({
      kind: 'action',
      at: a.createdAt,
      label: a.summary,
      pending: a.status === 'pending',
    });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

function SystemChip({
  icon,
  label,
  tone,
  at,
}: {
  icon: ReactElement;
  label: string;
  tone: string;
  at: string;
}): ReactElement {
  return (
    <div className="flex justify-center py-0.5">
      <span
        className={`inline-flex max-w-[85%] items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium ${tone} [&>svg]:h-3 [&>svg]:w-3`}
        title={formatTime(at)}
      >
        {icon}
        <span className="truncate">{label}</span>
        <span className="opacity-60">· {formatTime(at)}</span>
      </span>
    </div>
  );
}

export function LeadTimeline({ data }: { data: LeadDetail }): ReactElement {
  const items = buildTimeline(data);
  if (items.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Aucune activité pour ce lead pour l&apos;instant.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {items.map((item, i) => {
        if (item.kind === 'turn') {
          const t = item.turn;
          const inbound = t.direction === 'inbound';
          const persona = t.agentRole ? personaFor(t.agentRole) : null;
          return (
            <li key={`t-${i}`} className={`flex ${inbound ? 'justify-start' : 'justify-end'}`}>
              <div
                className={`max-w-[82%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
                  inbound
                    ? 'rounded-bl-sm bg-white text-slate-900 ring-1 ring-slate-200'
                    : 'rounded-br-sm bg-indigo-600 text-white'
                }`}
              >
                <div
                  className={`mb-0.5 flex items-center gap-1.5 text-[10px] ${
                    inbound ? 'text-slate-400' : 'text-indigo-200'
                  }`}
                >
                  <span className="font-semibold">
                    {inbound ? 'Client' : (persona?.name ?? t.agentRole ?? 'Agent')}
                  </span>
                  <span>· {t.channel === 'whatsapp' ? 'WhatsApp' : t.channel}</span>
                  <span>· {formatTime(t.occurredAt)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words">{t.content}</p>
              </div>
            </li>
          );
        }
        if (item.kind === 'quote') {
          return (
            <li key={`q-${i}`}>
              <SystemChip
                icon={item.tone === 'done' ? <FileCheck2 /> : <FileClock />}
                label={item.label}
                tone={
                  item.tone === 'done'
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-indigo-50 text-indigo-700'
                }
                at={item.at}
              />
            </li>
          );
        }
        if (item.kind === 'action') {
          return (
            <li key={`a-${i}`}>
              <SystemChip
                icon={<AlertTriangle />}
                label={item.label}
                tone={item.pending ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-600'}
                at={item.at}
              />
            </li>
          );
        }
        return (
          <li key={`e-${i}`}>
            <SystemChip
              icon={<Sparkles />}
              label={item.label}
              tone="bg-violet-50 text-violet-700"
              at={item.at}
            />
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Full view — glance card + timeline + facts rail
// ---------------------------------------------------------------------------

export function LeadDetailView({ data }: { data: LeadDetail }): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <LeadGlanceCard data={data} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="rounded-xl border border-border bg-slate-50/60 p-4 xl:col-span-2">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Historique complet
          </h3>
          <LeadTimeline data={data} />
        </section>

        <aside className="flex flex-col gap-4">
          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Devis ({data.quotes.length})
            </h3>
            {data.quotes.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun devis demandé.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {data.quotes.map((q) => (
                  <li
                    key={q.id}
                    className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-800">
                        {q.maxanceDevisNumber ?? q.productVariant}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          q.maxanceDevisNumber
                            ? 'bg-emerald-100 text-emerald-800'
                            : q.status === 'expired'
                              ? 'bg-rose-100 text-rose-700'
                              : 'bg-indigo-100 text-indigo-700'
                        }`}
                      >
                        {q.maxanceDevisNumber ? 'envoyé' : q.status}
                      </span>
                    </div>
                    {q.monthlyPremiumEur !== null && (
                      <p className="mt-1 font-medium text-slate-700">
                        {q.monthlyPremiumEur.toFixed(2)} €/mois
                        {q.comptantDueEur !== null
                          ? ` · 1er paiement ${q.comptantDueEur.toFixed(2)} €`
                          : ''}
                      </p>
                    )}
                    <p className="mt-0.5 text-slate-400">{formatTime(q.requestedAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.customer && (
            <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Client
              </h3>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-slate-500">Nom</dt>
                <dd className="text-slate-800">{data.customer.displayName ?? '—'}</dd>
                <dt className="text-slate-500">Civilité</dt>
                <dd className="text-slate-800">{data.customer.civility ?? '—'}</dd>
                <dt className="text-slate-500">Téléphone</dt>
                <dd>{data.customer.hasPhone ? '✅' : '—'}</dd>
                <dt className="text-slate-500">Email</dt>
                <dd>{data.customer.hasEmail ? '✅' : '—'}</dd>
              </dl>
            </section>
          )}

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Escalades ({data.humanActions.length})
            </h3>
            {data.humanActions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune escalade pour ce lead.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {data.humanActions.map((a) => (
                  <li
                    key={a.id}
                    className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-slate-700">{a.intent}</span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 font-medium ${
                          a.status === 'pending'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-emerald-100 text-emerald-800'
                        }`}
                      >
                        {a.status === 'pending' ? 'en attente' : 'résolue'}
                      </span>
                    </div>
                    <p className="mt-1 text-slate-600">{a.summary}</p>
                    <p className="mt-1 text-slate-400">{formatTime(a.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
