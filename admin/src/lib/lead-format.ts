/**
 * Lead formatting helpers (redesign 2026-07-08) — shared by the leads list
 * and the lead-detail view. Kept out of component files so react-refresh
 * stays happy (components-only exports there).
 */
export const STAGE_LABEL_FR: Record<string, string> = {
  new: 'Nouveau',
  scored: 'Scoré',
  qualifying: 'Qualification',
  quoting: 'Tarification',
  negotiating: 'Négociation',
  awaiting_payment: 'Attente paiement',
  closed_won: 'Gagné 🎉',
  closed_lost: 'Perdu',
  dormant: 'Dormant',
};

export function statusTone(status: string): string {
  if (status === 'new' || status === 'scored') return 'bg-slate-100 text-slate-700';
  if (status === 'qualifying' || status === 'quoting' || status === 'negotiating')
    return 'bg-indigo-100 text-indigo-800';
  if (status === 'awaiting_payment') return 'bg-amber-100 text-amber-800';
  if (status === 'closed_won') return 'bg-emerald-100 text-emerald-800';
  if (status === 'closed_lost' || status === 'dormant') return 'bg-rose-100 text-rose-800';
  return 'bg-amber-100 text-amber-800';
}

export function initialsOf(name: string | null): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => (p[0] ?? '').toUpperCase())
    .join('');
}
