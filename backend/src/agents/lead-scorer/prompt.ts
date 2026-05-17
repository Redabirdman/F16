/**
 * Lead Scorer prompt — M5.T3.
 *
 * The system prompt is in two halves:
 *   - `ASSURYAL_LEAD_SCORER_BASE` — the brand voice + scoring rubric. STABLE,
 *     marked cacheable so every lead reuses the cached prefix (~10% input
 *     cost on subsequent calls).
 *   - The user prompt is built per lead from the enriched payload.
 *
 * Output contract: strict JSON, no markdown, validated downstream by the
 * worker's zod schema. A French rubric because Assuryal is a French insurance
 * broker — keeping the prompt monolingual avoids translation drift.
 */
import type { SystemFragment } from '../../llm/cache.js';

/** Stable cacheable prefix — brand voice + scoring rubric. */
const ASSURYAL_LEAD_SCORER_BASE = `Tu es un évaluateur de prospects pour Assuryal, un courtier en assurance français spécialisé en :
- Assurance trottinette électrique (à partir de 5€/mois)
- Assurance auto pour conducteurs avec malus, sans antécédent, alcoolémie, etc.

Pour chaque prospect entrant, tu produis UN JSON STRICT :
{
  "score": <entier 0-100>,
  "channel": "whatsapp" | "voice" | "email" | "sms",
  "opening": "<message d'ouverture en français, 1-3 phrases, naturel, jamais robotique>",
  "rationale": "<courte justification interne, 1 phrase>"
}

Règles de score :
- 90-100 : prospect chaud — a fourni nom + téléphone + véhicule précis, contexte urgent (ex: malus à régulariser)
- 70-89 : prospect qualifié — a fourni email + téléphone + intention claire
- 50-69 : prospect tiède — info partielle (juste email OU juste téléphone)
- 25-49 : prospect froid — info minimale, source organique sans clear intent
- 0-24 : suspect — info incohérente ou possiblement bot

Choix du canal :
- whatsapp par défaut si téléphone disponible (réponse rapide, attendu en France)
- voice si le prospect a explicitement demandé "appelez-moi" / "rappel"
- email si seulement email disponible
- sms en dernier recours

Le message d'ouverture :
- En français, en tutoyant uniquement si l'âge le suggère ; sinon vouvoiement
- Personnalisé avec le prénom et le produit
- Termine par UNE question simple qui invite à répondre
- Jamais plus de 3 phrases
- Aucun emoji robotique ; ton chaleureux, professionnel, court
- INTERDIT : ne JAMAIS mentionner de prix, tarif, ou montant en euros — un devis Maxance sera généré plus tard
- INTERDIT : ne pas reformuler des détails sensibles (marque/modèle exact, données personnelles autres que le prénom)
- INTERDIT : ne pas faire de promesse commerciale (couverture spécifique, garantie de remboursement, etc.)

Tu DOIS répondre SEULEMENT par le JSON, sans markdown, sans préambule.`;

/**
 * Build the cacheable system prompt fragments for the Lead Scorer.
 *
 * Returns a single cacheable fragment — there's no per-lead dynamic system
 * content (per-lead context goes in the user prompt). The whole rubric is
 * stable for the lifetime of M5, so caching the full prefix is the right call.
 */
export function buildLeadScorerSystemPrompt(): SystemFragment[] {
  return [{ text: ASSURYAL_LEAD_SCORER_BASE, cache: true }];
}

/** Input shape for the per-lead user prompt. */
export interface LeadScorerUserPromptInput {
  source: 'website' | 'meta' | 'organic' | 'referral' | 'other';
  productLine: 'scooter' | 'car';
  fullName: string | null;
  email: string | null;
  phone: string | null;
  /** jsonb — passed through opaquely. */
  vehicle: unknown;
  driver: unknown;
  formAnswers: Record<string, unknown> | null;
}

/**
 * Build the per-lead user prompt. Empty/null optional fields are omitted so
 * we don't feed the model lines like "Nom : null" that bias the score.
 */
export function buildLeadScorerUserPrompt(input: LeadScorerUserPromptInput): string {
  const parts: string[] = ['Nouveau prospect à évaluer :'];
  parts.push(`- Source : ${input.source}`);
  parts.push(`- Produit : ${input.productLine}`);
  if (input.fullName) parts.push(`- Nom : ${input.fullName}`);
  if (input.email) parts.push(`- Email : ${input.email}`);
  if (input.phone) parts.push(`- Téléphone : ${input.phone}`);
  if (
    input.vehicle &&
    typeof input.vehicle === 'object' &&
    Object.keys(input.vehicle as Record<string, unknown>).length > 0
  ) {
    parts.push(`- Véhicule : ${JSON.stringify(input.vehicle)}`);
  }
  if (
    input.driver &&
    typeof input.driver === 'object' &&
    Object.keys(input.driver as Record<string, unknown>).length > 0
  ) {
    parts.push(`- Conducteur : ${JSON.stringify(input.driver)}`);
  }
  if (input.formAnswers && Object.keys(input.formAnswers).length > 0) {
    parts.push(`- Réponses formulaire : ${JSON.stringify(input.formAnswers)}`);
  }
  parts.push('');
  parts.push('Évalue maintenant.');
  return parts.join('\n');
}
