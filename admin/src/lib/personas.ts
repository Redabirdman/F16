/**
 * Agent personas (redesign 2026-07-08, Ridaa: "give the agents names —
 * feel like a real company").
 *
 * One source of truth for role → human identity, shared by the Bureau
 * (sprite name tags + side panel), the dashboard agents donut and any
 * page that mentions an agent role. Names are personas, NOT real people.
 */
export interface AgentPersona {
  /** French first name shown in the UI. */
  name: string;
  /** Human job title, French. */
  title: string;
  /** Hex CSS color for chips / charts (mirrors office ROLE_COLOR). */
  color: string;
}

export const AGENT_PERSONAS: Record<string, AgentPersona> = {
  'sales-agent': { name: 'Yasmine', title: 'Conseillère commerciale', color: '#38bdf8' },
  'voice-operator': { name: 'Adam', title: 'Chargé des appels', color: '#a78bfa' },
  'maxance-operator': { name: 'Karim', title: 'Opérateur Maxance', color: '#fbbf24' },
  supervisor: { name: 'Omar', title: 'Superviseur', color: '#f87171' },
  'human-router': { name: 'Nadia', title: 'Liaison équipe humaine', color: '#34d399' },
  'engagement-agent': { name: 'Mehdi', title: 'Relances & fidélisation', color: '#5eead4' },
  'ads-manager-agent': { name: 'Sofia', title: 'Responsable publicité', color: '#fb923c' },
  'creative-agent': { name: 'Lina', title: 'Directrice artistique', color: '#f472b6' },
  'lead-scorer': { name: 'Salma', title: 'Qualification des leads', color: '#94a3b8' },
};

const FALLBACK: AgentPersona = { name: 'Agent', title: 'Agent', color: '#94a3b8' };

export function personaFor(role: string): AgentPersona {
  return AGENT_PERSONAS[role] ?? { ...FALLBACK, name: role };
}

/** "Yasmine — Conseillère commerciale" or the raw role when unknown. */
export function personaLabel(role: string): string {
  const p = AGENT_PERSONAS[role];
  return p ? `${p.name} — ${p.title}` : role;
}

/** Plain-French description of what an agent is doing from a bus intent. */
export function intentLabel(intent: string): string {
  const u = intent.toUpperCase();
  if (u.startsWith('QUOTE.CONFIRM')) return 'Création du devis Maxance';
  if (u.startsWith('QUOTE.')) return 'Tarification en cours';
  if (u.startsWith('DEVIS.')) return 'Envoi du devis au client';
  if (u.startsWith('VOICE.')) return 'Appel téléphonique';
  if (u.startsWith('LEAD.')) return "Traitement d'un lead";
  if (u.startsWith('ENGAGEMENT')) return 'Relance client';
  if (u.startsWith('SUBSCRIPTION')) return 'Souscription en cours';
  if (u.startsWith('KNOWLEDGE')) return 'Mise à jour des connaissances';
  if (u.startsWith('HUMAN_ACTION')) return "Escalade vers l'équipe";
  if (u.startsWith('CHANNEL')) return 'Message client';
  return intent;
}
