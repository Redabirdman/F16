/**
 * Simulation page (M8-sim).
 *
 * Lets a remote tester (Achraf) inject a fake Facebook-ad lead through the REAL
 * intake pipeline — engaging him on his actual WhatsApp/phone — then reset
 * (purge) his contact to re-test as a brand-new lead. The status panel shows
 * channel liveness (the agent can only message back when the backend runs in
 * live mode) and the current identity (new vs returning).
 *
 * Injection is source='meta' + attribution.f16_simulation server-side, so the
 * agents treat it identically to a paid lead. The in-conversation devis still
 * needs the Chrome extension active (Maxance driver).
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import {
  injectSimulatedLead,
  resetSimulatedContact,
  getSimStatus,
  type SimInjectBody,
  type SimInjectResult,
} from '@/lib/api';

const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none';
const labelClass = 'flex flex-col gap-1 text-sm font-medium text-slate-700';

type FieldDef = {
  key: string;
  label: string;
  placeholder: string;
  type?: string;
  required?: boolean;
};

/** Core identity inputs (name/phone/email), rendered from config to stay compact. */
const TEXT_FIELDS: FieldDef[] = [
  { key: 'fullName', label: 'Nom complet', placeholder: 'Achraf B.', required: true },
  { key: 'phone', label: 'Téléphone', placeholder: '+33 6 12 34 56 78', required: true },
  { key: 'email', label: 'Email (optionnel)', placeholder: 'achraf@example.com', type: 'email' },
];

/** Optional quote-prefill inputs, rendered from this config to stay compact. */
const QUOTE_FIELDS: FieldDef[] = [
  { key: 'purchasePriceEur', label: 'Prix d’achat (€)', placeholder: '900', type: 'number' },
  { key: 'purchaseDate', label: 'Date d’achat', placeholder: '2026-05-01' },
  { key: 'postalCode', label: 'Code postal', placeholder: '75011' },
  { key: 'stationnement', label: 'Stationnement', placeholder: 'Box fermé' },
  { key: 'dateOfBirth', label: 'Date de naissance', placeholder: '1990-03-15' },
  { key: 'city', label: 'Ville (optionnel)', placeholder: 'Paris' },
];

export default function SimulationPage(): ReactElement {
  const [form, setForm] = useState<Record<string, string>>({ fullName: '', phone: '', email: '' });
  const fullName = form.fullName ?? '';
  const phone = form.phone ?? '';
  const email = form.email ?? '';
  const [preferredChannel, setPreferredChannel] = useState<'whatsapp' | 'call'>('whatsapp');
  const [preferredTime, setPreferredTime] = useState('maintenant');

  const [showQuote, setShowQuote] = useState(false); // optional quote prefill (QUOTE_FIELDS)
  const [quote, setQuote] = useState<Record<string, string>>({});
  const setQuoteField = (k: string, v: string): void => setQuote((q) => ({ ...q, [k]: v }));
  const [lastResult, setLastResult] = useState<SimInjectResult | null>(null);

  const status = useQuery({
    queryKey: ['sim-status', phone],
    queryFn: () => getSimStatus(phone || undefined),
    refetchInterval: 15_000,
  });

  const inject = useMutation({
    mutationFn: (body: SimInjectBody) => injectSimulatedLead(body),
    onSuccess: (res) => {
      setLastResult(res);
      void status.refetch();
    },
  });

  const reset = useMutation({
    mutationFn: () => resetSimulatedContact({ phone, ...(email ? { email } : {}) }),
    onSuccess: () => {
      setLastResult(null);
      void status.refetch();
    },
  });

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    const q =
      showQuote && quote.purchasePriceEur
        ? {
            purchasePriceEur: Number(quote.purchasePriceEur),
            purchaseDate: quote.purchaseDate ?? '',
            postalCode: quote.postalCode ?? '',
            stationnement: quote.stationnement ?? '',
            dateOfBirth: quote.dateOfBirth ?? '',
            ...(quote.city ? { city: quote.city } : {}),
          }
        : undefined;
    inject.mutate({
      fullName,
      phone,
      ...(email ? { email } : {}),
      preferredChannel,
      preferredTime,
      productLine: 'scooter',
      ...(q ? { quote: q } : {}),
    });
  }

  function onReset(): void {
    const ok = globalThis.confirm(
      `Réinitialiser le contact ${phone} ?\n\n` +
        `Cela supprimera DÉFINITIVEMENT toutes ses données F16 (client, leads, ` +
        `devis, conversations) ET archivera son contact HubSpot. Action irréversible.`,
    );
    if (ok) reset.mutate();
  }

  const channels = status.data?.channels;
  const contact = status.data?.contact;
  const live = channels?.whatsapp === true;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Simulation</h1>
        <p className="text-sm text-muted-foreground">
          Injecte un faux lead Facebook dans la vraie chaîne d’intake — l’agent engage le numéro sur
          son vrai WhatsApp/téléphone. Réinitialise pour re-tester comme nouveau lead.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Le devis en conversation nécessite l’extension Chrome active.
        </p>
      </header>

      {/* Live / offline banner */}
      {status.data &&
        (live ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            Mode live — l’agent peut envoyer des messages
            {channels?.voice ? ' (WhatsApp + voix)' : ''}.
          </div>
        ) : (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Mode hors-ligne — le backend n’est pas en mode live, l’agent ne pourra pas envoyer de
            message.
          </div>
        ))}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_280px]">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {TEXT_FIELDS.map((f) => (
            <label key={f.key} className={labelClass}>
              {f.label}
              <input
                type={f.type ?? 'text'}
                className={inputClass}
                value={form[f.key] ?? ''}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                required={f.required ?? false}
                placeholder={f.placeholder}
              />
            </label>
          ))}

          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium text-slate-700">Canal préféré</legend>
            <div className="flex gap-4 pt-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="channel"
                  checked={preferredChannel === 'whatsapp'}
                  onChange={() => setPreferredChannel('whatsapp')}
                />
                WhatsApp
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="channel"
                  checked={preferredChannel === 'call'}
                  onChange={() => setPreferredChannel('call')}
                />
                Appel
              </label>
            </div>
          </fieldset>

          <label className={labelClass}>
            Moment préféré
            <select
              className={inputClass}
              value={preferredTime}
              onChange={(e) => setPreferredTime(e.target.value)}
            >
              <option value="maintenant">Maintenant</option>
              <option value="matin">Matin</option>
              <option value="apres_midi">Après-midi</option>
              <option value="soir">Soir</option>
            </select>
          </label>

          <label className={labelClass}>
            Produit
            <input className={`${inputClass} bg-slate-50`} value="Trottinette" readOnly disabled />
          </label>

          <details
            open={showQuote}
            onToggle={(e) => setShowQuote((e.target as HTMLDetailsElement).open)}
            className="rounded-md border border-slate-200 p-3"
          >
            <summary className="cursor-pointer text-sm font-medium text-slate-600">
              Infos devis (optionnel)
            </summary>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {QUOTE_FIELDS.map((f) => (
                <label key={f.key} className={labelClass}>
                  {f.label}
                  <input
                    type={f.type ?? 'text'}
                    className={inputClass}
                    value={quote[f.key] ?? ''}
                    onChange={(e) => setQuoteField(f.key, e.target.value)}
                    placeholder={f.placeholder}
                  />
                </label>
              ))}
            </div>
          </details>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={inject.isPending || !fullName || !phone}>
              {inject.isPending ? 'Envoi…' : 'Soumettre'}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={onReset}
              disabled={reset.isPending || !phone}
            >
              {reset.isPending ? 'Réinitialisation…' : 'Réinitialiser'}
            </Button>
          </div>

          {inject.error && (
            <p className="text-sm text-rose-700">{(inject.error as Error).message}</p>
          )}
          {reset.error && <p className="text-sm text-rose-700">{(reset.error as Error).message}</p>}
          {reset.isSuccess && reset.data && (
            <p className="text-sm text-emerald-700">
              Contact purgé · HubSpot : {reset.data.hubspot}.
            </p>
          )}
        </form>

        {/* Status panel */}
        <aside className="flex flex-col gap-3">
          <div className="rounded-md border border-slate-200 p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Identité</h2>
            {!phone ? (
              <p className="text-sm text-muted-foreground">Saisis un téléphone.</p>
            ) : status.isLoading ? (
              <p className="text-sm text-muted-foreground">Chargement…</p>
            ) : contact?.exists ? (
              <p className="text-sm text-slate-800">
                Client existant ({contact.leadCount} lead
                {contact.leadCount === 1 ? '' : 's'})
                {contact.lastLeadStatus ? ` · dernier : ${contact.lastLeadStatus}` : ''}
              </p>
            ) : (
              <p className="text-sm text-slate-800">Nouveau lead</p>
            )}
          </div>

          {lastResult && (
            <div className="rounded-md border border-sky-200 bg-sky-50 p-4 text-sm">
              <h2 className="mb-1 font-semibold text-sky-900">Dernier lead injecté</h2>
              <p className="text-sky-900">
                {lastResult.dedup === 'matched_existing'
                  ? 'Contact existant ré-utilisé'
                  : 'Nouveau client créé'}
              </p>
              <Link
                to={`/leads/${lastResult.leadId}`}
                className="mt-1 inline-block text-sky-700 hover:underline"
              >
                Voir le lead →
              </Link>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
