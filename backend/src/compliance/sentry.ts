/**
 * Compliance Sentry (M6.T4) — synchronous pre-send guardrail for the Sales
 * Agent's drafted outbound messages. Design §17 — defense in depth.
 *
 * Two layers, ordered cheapest-first:
 *   1. Server-side rule book — a small regex set catching the most obvious
 *      violations (asserting a contract is bound, asking for an OTP, naked
 *      IBAN, etc.). Hard hits short-circuit and block immediately, no LLM
 *      call. Soft hits are passed to the LLM as hints.
 *   2. Haiku LLM check — strict JSON `{verdict, reasons}` against the
 *      Assuryal guardrails (M6.T2). Runs only after the server rules pass.
 *
 * FAIL-CLOSED: any LLM/transport error, unparseable JSON, or schema mismatch
 * resolves to `block` so we over-escalate rather than send a bad message.
 *
 * Latency budget: ~500-800ms total at the call site (Haiku is fast + ~50ms
 * for the rule check). Sales Agent runs this synchronously before the send.
 *
 * No DB I/O here — the draft is already plaintext and the customer's last
 * inbound is passed in as plaintext from the dispatched intent payload.
 */
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { callClaude } from '../llm/claude.js';
import { registerPrompt, resolvePrompt } from '../prompts/registry.js';
import { logger } from '../logger.js';

/** Severity escalates from low→high. Reserved for future tunable thresholds. */
export type ComplianceSeverity = 'pass' | 'warn' | 'block';

export interface ComplianceCheckInput {
  draft: string;
  /** Context the LLM sentry uses — channel, productLine, leadStatus, recent customer message. */
  ctx: {
    customerId: string;
    channel: 'whatsapp' | 'voice' | 'email' | 'sms';
    productLine: 'scooter' | 'car';
    leadStatus: string;
    /** Last inbound from customer — to detect if draft is responsive vs out-of-context. */
    lastInboundContent?: string;
  };
}

export interface ComplianceCheckOutput {
  verdict: 'pass' | 'block';
  reasons: string[];
  /** Names of server-side rules that matched (hard OR soft). */
  ruleHits: string[];
  /** Brief LLM rationale when blocked by the LLM layer. */
  llmRationale?: string;
  durationMs: number;
}

/** ---------- server-side rule book ---------- */

interface ServerRule {
  name: string;
  pattern: RegExp;
  reason: string;
  /** If true, a partial match short-circuits to block. If false, treated as warn and surfaced to the LLM. */
  hard: boolean;
}

const SERVER_RULES: ServerRule[] = [
  // Hard blocks — phrases that should never appear in a Sales Agent reply.
  {
    name: 'contract-already-bound',
    hard: true,
    pattern:
      /(votre|le)\s+(contrat|adh[ée]sion)\s+(est|sera)\s+(valid[ée]|conclu[e]?|sign[ée]|effectif)/i,
    reason:
      'Promet ou laisse entendre que le contrat est lié — interdit avant validation Maxance humaine.',
  },
  {
    name: 'insurance-active',
    hard: true,
    pattern: /\bvous\s+[êe]tes\s+(?:d[ée]sormais\s+|maintenant\s+|bien\s+)?(?:couvert|assur)/i,
    reason: 'Annonce que le client est assuré — interdit sans confirmation Maxance.',
  },
  {
    name: 'exact-price-no-devis',
    hard: false,
    // matches "votre prix sera de 42€" or "ça vous coûtera 12.34€/mois"
    pattern: /(prix|tarif|cotisation|prime|mensualit[ée]).{0,30}?\d+[,.]?\d*\s*€/i,
    reason:
      "Annonce un prix sans contexte de devis — vérifier qu'un devis Maxance a bien été généré.",
  },
  {
    name: 'asks-password-otp',
    hard: true,
    pattern: /\b(mot\s+de\s+passe|code\s+sms|code\s+secret|otp|pin)\b/i,
    reason: 'Demande un mot de passe ou code — jamais autorisé.',
  },
  {
    name: 'guarantees-claim-outcome',
    hard: true,
    pattern:
      /(garantis|garantit|promets)\s+(que|de).{0,40}?(rembours|indemnis|prend[s]?\s+en\s+charge)/i,
    reason: 'Promesse de prise en charge / remboursement — sortir du cadre commercial.',
  },
  {
    name: 'legal-advice',
    hard: false,
    pattern:
      /\b(je\s+vous\s+conseille|d'un\s+point\s+de\s+vue\s+(l[ée]gal|juridique)|art[.\s]+\d+\s+du\s+code)/i,
    reason: 'Donne un conseil juridique — sortir du périmètre.',
  },
  {
    name: 'medical-advice',
    hard: true,
    pattern: /(consultez\s+un\s+m[ée]decin|posologie|diagnostic|traitement\s+m[ée]dical)/i,
    reason: 'Donne un conseil médical — interdit.',
  },
  // Soft warnings — don't auto-block but surface to the LLM as hints.
  {
    name: 'iban-full',
    hard: false,
    pattern: /FR\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{3}/,
    reason: 'IBAN complet en clair dans le message — risque PII.',
  },
];

/** Apply the server-side rule book. */
function runServerRules(draft: string): { hardHits: ServerRule[]; softHits: ServerRule[] } {
  const hardHits: ServerRule[] = [];
  const softHits: ServerRule[] = [];
  for (const rule of SERVER_RULES) {
    if (rule.pattern.test(draft)) {
      (rule.hard ? hardHits : softHits).push(rule);
    }
  }
  return { hardHits, softHits };
}

/** ---------- LLM (Haiku) sentry ---------- */

const SENTRY_SYSTEM = `Tu es le **Compliance Sentry** d'Assuryal. Tu juges si un message à envoyer à un client respecte les règles d'éthique et de conformité d'un courtier en assurance français.

Tu réponds STRICTEMENT par UN JSON :
{
  "verdict": "pass" | "block",
  "reasons": ["raison 1 si block", "raison 2", ...]
}

Bloque ABSOLUMENT si le message :
- Affirme que LE CONTRAT DE CE CLIENT est conclu / signé / actif / lié avant validation humaine côté Maxance. (NB : rappeler qu'un type de contrat existe est OK ; promettre que CELUI DU CLIENT est validé n'est pas OK.)
- Annonce un PRIX PERSONNALISÉ pour CE CLIENT (du type "votre prime sera de X €" ou "ça vous coûtera Y €/mois") sans qu'un devis Maxance ait été demandé/généré. (NB : citer le tarif PUBLIC d'appel ("à partir de 5 €/mois pour la trottinette", "à partir de X €/mois") est AUTORISÉ — c'est de l'info commerciale publique, pas un engagement personnalisé.)
- Promet un délai DE TRAITEMENT SPÉCIFIQUE pour ce client (remboursement, prise d'effet, carence) sans donnée Maxance précise pour son dossier.
- Demande un mot de passe, code SMS, OTP, ou code de carte.
- Donne un conseil MÉDICAL.
- Donne un conseil JURIDIQUE PERSONNALISÉ ("dans votre situation vous devriez attaquer X", "votre démarche est illégale", interprétation d'un article de loi pour un cas précis). (NB : rappeler une OBLIGATION LÉGALE GÉNÉRALE de droit français — "l'assurance RC est obligatoire pour les EDPM en France", "la limite est 25 km/h", "la conduite sans assurance est sanctionnée" — est AUTORISÉ : c'est de la culture-métier commerciale, pas du conseil juridique.)
- Insulte / juge / commente négativement le client.
- Contient un IBAN ou numéro de carte en clair.
- Reformule des informations clients sensibles inutilement (donner un IBAN complet en clair, par exemple).
- Sort manifestement du contexte de l'échange (par exemple, le client demande un prix et le draft parle de météo).
- Promet un échange humain dans un délai précis sans que ce délai soit géré par l'équipe.

PASS si le message :
- Est commercial, factuel, respecte les règles, et reste dans le périmètre d'Assuryal.
- Demande au client une information pour qualifier son dossier ou propose une étape sans franchir une ligne rouge.
- Cite un tarif PUBLIC d'appel ou une OBLIGATION LÉGALE GÉNÉRALE (voir nuances ci-dessus).
- Répond à une question FAQ du client (vitesse max EDPM, obligation d'assurance, différence VAE vs vélo électrique, etc.) en s'appuyant sur le droit français usuel.
- Récapitule au CLIENT ses PROPRES coordonnées (nom, adresse, email, téléphone) pour confirmation, sur le canal où il vient de les donner. C'est une bonne pratique commerciale, PAS une fuite de données — le client est le destinataire et la source. (Seul un IBAN/carte complet en clair reste interdit.)
- Rassure sur l'attente SANS délai chiffré ("je reviens vers vous très vite", "dès que possible", "un conseiller revient vers vous rapidement", "pas d'inquiétude"). C'est la formulation OBLIGATOIRE côté vente — les délais chiffrés sont interdits par le playbook. L'ABSENCE de délai précis n'est JAMAIS un motif de blocage, même si le client demande "quand ?" ; le flou volontaire est le comportement conforme, pas une faute.
- Annonce la FENÊTRE DE RÉOUVERTURE du service de tarification ("vos tarifs arriveront demain matin, à partir de 8h", "lundi matin", "dès la réouverture de notre service de tarification"). Le portail de tarification est FERMÉ les nuits (20h-8h) et les week-ends ; annoncer cette fenêtre au client est la formulation APPROUVÉE par la direction (2026-07-05) quand le système lui-même a programmé le devis pour la réouverture (portalClosed=true). Ce n'est PAS une promesse de délai de traitement personnalisé — c'est un horaire d'ouverture du service, comme les horaires d'une agence.
- Explique les FRAIS Assuryal avec les formulations APPROUVÉES ("frais d'inscription au contrat", "honoraires de gestion du dossier", "accompagnement administratif") et des chiffres issus du devis DÉJÀ présenté au client (ex. "inclus dans votre premier paiement de 22,96 €"). Une fois le menu de prix envoyé (il indiquait déjà le premier paiement), reprendre ou détailler ces montants est AUTORISÉ — ce n'est pas un prix inventé. Seule l'annonce de chiffres SANS AUCUN devis existant reste bloquable.
- Rappelle au client que ses devis "ont bien été envoyés" quand les tours PRÉCÉDENTS de la conversation contiennent leurs références (numéros DR..., "en pièce jointe", confirmation d'envoi). Référencer un devis DÉJÀ créé et livré est un FAIT vérifiable dans l'historique, PAS une affirmation non validée — ne bloque jamais un rappel factuel d'un envoi déjà effectué.

EN CAS DE DOUTE : si le draft fait juste de la pédagogie commerciale + des faits publics + une question de relance, c'est PASS. Bloquer doit être réservé aux promesses personnalisées et aux interdits explicites.

Tu réponds UNIQUEMENT par le JSON, jamais de préambule ou de markdown.`;

const SentryLLMOutputSchema = z.object({
  verdict: z.enum(['pass', 'block']),
  reasons: z.array(z.string()).default([]),
});
type SentryLLMOutput = z.infer<typeof SentryLLMOutputSchema>;

// M14.T6 — editable compliance rubric (the LLM sentry's system prompt).
const COMPLIANCE_SENTRY_KEY = 'compliance.sentry';
registerPrompt({
  key: COMPLIANCE_SENTRY_KEY,
  label: 'Compliance Sentry — rubrique',
  agentRole: 'compliance',
  description:
    'Rubrique de conformité ACPR/éthique jugeant chaque message client (verdict pass/block + raisons, JSON). ' +
    'Le message à juger est fourni dans le prompt utilisateur. ⚠️ Garde-fou réglementaire — éditer avec prudence.',
  getDefault: () => SENTRY_SYSTEM,
});

/**
 * One LLM round-trip + parse. Discriminated so `llmSentryCheck` can tell a
 * transport failure (fail closed immediately — the API is down, a second call
 * lands on the same outage) from an UNPARSEABLE reply (model flake — worth
 * one retry before failing closed; it happened twice in ~3 minutes on the
 * 2026-07-06 live test, pure noise for management).
 */
type SentryAttempt =
  | { status: 'ok'; pass: boolean; reasons: string[] }
  | { status: 'transport'; reasons: string[]; rationale?: string }
  | { status: 'unparseable'; reasons: string[] };

async function llmSentryAttempt(system: string, userPrompt: string): Promise<SentryAttempt> {
  let raw: string;
  try {
    const out = await callClaude({
      tier: 'haiku',
      systemFragments: [{ text: system, cache: true }],
      userPrompt,
      maxTokens: 200,
      structured: false,
    });
    raw = typeof out === 'string' ? out : out.text;
  } catch (err) {
    logger.warn({ err }, 'compliance: LLM check failed; defaulting to block + escalate');
    return {
      status: 'transport',
      reasons: ['compliance LLM unavailable'],
      ...(err instanceof Error ? { rationale: err.message } : {}),
    };
  }

  // Strip fences and surrounding non-JSON.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    logger.warn({ raw }, 'compliance: LLM produced no JSON');
    return { status: 'unparseable', reasons: ['compliance LLM response not parseable'] };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    logger.warn({ err }, 'compliance: JSON parse failed');
    return { status: 'unparseable', reasons: ['compliance LLM JSON parse failed'] };
  }
  const parsed = SentryLLMOutputSchema.safeParse(obj);
  if (!parsed.success) {
    return { status: 'unparseable', reasons: ['compliance LLM schema mismatch'] };
  }
  const result: SentryLLMOutput = parsed.data;
  return { status: 'ok', pass: result.verdict === 'pass', reasons: result.reasons };
}

async function llmSentryCheck(
  db: Database,
  draft: string,
  ctx: ComplianceCheckInput['ctx'],
  serverHits: ServerRule[],
): Promise<{ pass: boolean; reasons: string[]; rationale?: string }> {
  const userPrompt = [
    'Contexte :',
    `- Canal : ${ctx.channel}`,
    `- Produit : ${ctx.productLine === 'scooter' ? 'trottinette' : 'auto'}`,
    `- Statut du lead : ${ctx.leadStatus}`,
    ctx.lastInboundContent
      ? `- Dernier message client : "${ctx.lastInboundContent.slice(0, 500)}"`
      : null,
    serverHits.length > 0
      ? `- Signaux automatiques détectés : ${serverHits.map((r) => r.name).join(', ')}`
      : null,
    '',
    'Message à juger :',
    '"""',
    draft,
    '"""',
    '',
    'Évalue maintenant.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const system = await resolvePrompt(db, COMPLIANCE_SENTRY_KEY, () => SENTRY_SYSTEM);

  // Unparseable output gets ONE same-prompt retry before failing closed —
  // a single Haiku flake must not escalate a clean draft to management.
  // Transport errors stay immediately fail-closed (same-outage retry is
  // wasted latency), and everything else keeps fail-closed semantics.
  let attempt = await llmSentryAttempt(system, userPrompt);
  if (attempt.status === 'unparseable') {
    logger.warn(
      { reasons: attempt.reasons },
      'compliance: LLM output unparseable — retrying once before fail-closed',
    );
    attempt = await llmSentryAttempt(system, userPrompt);
  }
  if (attempt.status === 'ok') {
    return { pass: attempt.pass, reasons: attempt.reasons };
  }
  return {
    pass: false,
    reasons: attempt.reasons,
    ...(attempt.status === 'transport' && attempt.rationale
      ? { rationale: attempt.rationale }
      : {}),
  };
}

/** ---------- public API ---------- */

/**
 * Run the compliance check. Combines server rules + LLM sentry.
 * Fast-paths to block when a hard server rule matches (no LLM call).
 * Defaults to block on any LLM error (fail-closed).
 *
 * `db` is used to resolve the (admin-editable) sentry rubric override (M14.T6).
 */
export async function checkComplianceFor(
  db: Database,
  input: ComplianceCheckInput,
  options: { rulesOnly?: boolean } = {},
): Promise<ComplianceCheckOutput> {
  const t0 = Date.now();
  const { hardHits, softHits } = runServerRules(input.draft);

  // Fast-path: hard rule → block, no LLM call.
  if (hardHits.length > 0) {
    return {
      verdict: 'block',
      reasons: hardHits.map((r) => r.reason),
      ruleHits: hardHits.map((r) => r.name),
      durationMs: Date.now() - t0,
    };
  }

  // Rules-only mode (live VOICE calls): the hard server rules above already
  // fail-closed; skip the LLM sentry round-trip that would add seconds of dead
  // air mid-call. Soft hits are reported as ruleHits but not LLM-adjudicated.
  if (options.rulesOnly) {
    return {
      verdict: 'pass',
      reasons: [],
      ruleHits: softHits.map((r) => r.name),
      durationMs: Date.now() - t0,
    };
  }

  // LLM check — soft hits surface to the LLM as a hint.
  const llm = await llmSentryCheck(db, input.draft, input.ctx, softHits);
  if (!llm.pass) {
    return {
      verdict: 'block',
      reasons: llm.reasons.length > 0 ? llm.reasons : ['compliance LLM blocked'],
      ruleHits: softHits.map((r) => r.name),
      ...(llm.rationale ? { llmRationale: llm.rationale } : {}),
      durationMs: Date.now() - t0,
    };
  }

  return {
    verdict: 'pass',
    reasons: [],
    ruleHits: softHits.map((r) => r.name),
    durationMs: Date.now() - t0,
  };
}

// Exposed for unit tests that introspect the rule book.
export { SERVER_RULES };
