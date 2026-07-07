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
    /**
     * The lead's REAL quote/devis state, one French line (e.g. "2 devis générés
     * et envoyés au client (DR0000984252, DR0000984255) — mensualité 7,97 €/mois,
     * annuel 83,71 €"). Without it the sentry judged every draft BLIND and
     * blocked correct devis-backed prices as "prix inventé sans devis" (live
     * 2026-07-07, Ridaa: pointless approvals). Callers with DB access build it
     * via buildQuoteContextLine().
     */
    quoteContext?: string;
  };
}

export interface ComplianceCheckOutput {
  verdict: 'pass' | 'block';
  reasons: string[];
  /** Names of server-side rules that matched (hard OR soft). */
  ruleHits: string[];
  /** Brief LLM rationale when blocked by the LLM layer. */
  llmRationale?: string;
  /**
   * verdict='pass' but the advisory layer had reservations (LLM minor concern,
   * LLM unavailable/unparseable). The message SENDS; callers should audit-log
   * it for after-the-fact review. Restructure 2026-07-07 (Ridaa): pre-send
   * approval is reserved for hard red lines — "I am not here to approve every
   * message; otherwise it is not an automated business."
   */
  flagged?: boolean;
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
  {
    name: 'frais-as-tax',
    hard: true,
    // The closing rules forbid presenting the frais as a state tax or a legal
    // obligation — misleading presentation (real red line, was LLM-only).
    pattern: /taxe\s+(impos[ée]e?(\s+par\s+l.[ÉEé]tat)?|l[ée]gale|obligatoire|d.[ÉEé]tat)/i,
    reason:
      'Présente les frais comme une taxe / obligation légale — présentation trompeuse interdite (règles closing).',
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
  "severity": "critical" | "minor",
  "reasons": ["raison 1 si block", "raison 2", ...]
}
"reasons" : 1 à 2 raisons COURTES (≤ 15 mots chacune) — jamais de paragraphe.

"severity" ne compte que si verdict=block :
- "critical" = UNIQUEMENT ces 5 familles : (1) contrat/couverture de CE client affirmé conclu/actif/signé ; (2) prix personnalisé INVENTÉ alors qu'AUCUN devis n'existe dans le contexte ; (3) demande de mot de passe / code / données de paiement ; (4) conseil médical ou juridique personnalisé ; (5) IBAN/carte en clair. → le message sera RETENU et la direction devra trancher.
- "minor" = TOUT LE RESTE, y compris : promesses de délai (même chiffrées — "deux minutes", "demain") concernant l'ENVOI ou la PRÉPARATION d'un devis/document ; approximations sur l'état du dossier ("vos deux devis" quand un seul est parti) ; style, doute, contexte flou. Le message PARTIRA et sera journalisé pour revue. Quand tu hésites, choisis "minor" : une conversation interrompue coûte plus cher qu'un message imparfait.

Bloque ABSOLUMENT si le message :
- Affirme que LE CONTRAT DE CE CLIENT est conclu / signé / actif / lié avant validation humaine côté Maxance. (NB : rappeler qu'un type de contrat existe est OK ; promettre que CELUI DU CLIENT est validé n'est pas OK.)
- Annonce un PRIX PERSONNALISÉ pour CE CLIENT (du type "votre prime sera de X €" ou "ça vous coûtera Y €/mois") sans qu'un devis Maxance ait été demandé/généré. (NB : citer le tarif PUBLIC d'appel ("à partir de 5 €/mois pour la trottinette", "à partir de X €/mois") est AUTORISÉ — c'est de l'info commerciale publique, pas un engagement personnalisé.)
- Promet un délai DE TRAITEMENT SPÉCIFIQUE pour ce client (remboursement, prise d'effet, carence) sans donnée Maxance précise pour son dossier. ⚠️ Un délai "spécifique" = une DATE/HEURE CHIFFRÉE promise pour un RÉSULTAT métier (indemnisation, prise d'effet). Un délai VAGUE ("très vite", "rapidement", "tout de suite", "dans un instant", "en route") n'est JAMAIS un délai spécifique. L'envoi d'un DOCUMENT (devis, PDF) que le système est en train de produire n'est PAS un traitement métier — dire qu'il "arrive" est un fait, pas une promesse.
- Demande un mot de passe, code SMS, OTP, ou code de carte.
- Donne un conseil MÉDICAL.
- Donne un conseil JURIDIQUE PERSONNALISÉ ("dans votre situation vous devriez attaquer X", "votre démarche est illégale", interprétation d'un article de loi pour un cas précis). (NB : rappeler une OBLIGATION LÉGALE GÉNÉRALE de droit français — "l'assurance RC est obligatoire pour les EDPM en France", "la limite est 25 km/h", "la conduite sans assurance est sanctionnée" — est AUTORISÉ : c'est de la culture-métier commerciale, pas du conseil juridique.)
- Insulte / juge / commente négativement le client.
- Contient un IBAN ou numéro de carte en clair.
- Reformule des informations clients sensibles inutilement (donner un IBAN complet en clair, par exemple).
- Sort manifestement du contexte de l'échange (par exemple, le client demande un prix et le draft parle de météo).
- Promet un échange humain à une HEURE PRÉCISE ("un conseiller vous appellera à 15h30") sans que ce rendez-vous soit réellement programmé. ⚠️ Les RELANCES DE SUIVI à granularité jour ("je vous recontacte demain", "je reviens vers vous dans la journée", "on se reparle bientôt") sont GÉRÉES PAR LE SYSTÈME (agent de relance automatique 24h/72h/7j) — elles sont AUTORISÉES et ne sont jamais un motif de blocage.

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
- Annonce qu'un devis / document DEMANDÉ PAR LE CLIENT est "en route", "en préparation", "arrive très vite / tout de suite" quand la conversation montre que le client vient de le demander ou de confirmer. Le système génère et envoie les devis AUTOMATIQUEMENT — dire qu'il arrive est factuel. (Live 2026-07-07 : bloquer "le second devis est en route" pendant que le système l'envoyait a fait taire l'agent au pire moment.)
- Promet une RELANCE de suivi à granularité jour ("je vous recontacte demain", "je reviens vers vous demain pour voir si vous avez des questions"). L'agent de relance automatique (24h/72h/7j) tient cette promesse — c'est un engagement SYSTÈME, pas une promesse en l'air.

⚠️ SOURCE DE VÉRITÉ DEVIS : le contexte fourni peut contenir la ligne « Devis Maxance de CE client » — ce sont des FAITS vérifiés en base de données (références DR..., mensualité, annuel, comptant). Quand cette ligne existe, TOUT chiffre du draft cohérent avec ces devis (mensualité, options ≈1-1,50 €/mois de plus, frais d'inscription 50/60/65 € selon la formule, premier prélèvement) est AUTORISÉ — ne bloque JAMAIS pour « prix sans devis » ou « chiffre inventé » dans ce cas. Bloque pour prix inventé UNIQUEMENT quand AUCUN devis n'est listé dans le contexte ET que le chiffre n'est pas un tarif public d'appel.

EN CAS DE DOUTE : si le draft fait juste de la pédagogie commerciale + des faits publics + une question de relance, c'est PASS. Bloquer doit être réservé aux promesses personnalisées et aux interdits explicites. RÈGLE DE CALIBRAGE (direction, 2026-07-07) : chaque blocage interrompt la conversation client et exige une validation humaine — un blocage injustifié coûte plus cher qu'un message imparfait. Bloque UNIQUEMENT les lignes rouges listées ci-dessus ; le style, la tournure, l'enthousiasme commercial et les formulations vagues ne sont JAMAIS des motifs de blocage.

Tu réponds UNIQUEMENT par le JSON, jamais de préambule ou de markdown.`;

const SentryLLMOutputSchema = z.object({
  verdict: z.enum(['pass', 'block']),
  // Missing severity on a block = 'critical' (fail-safe: an old-format or
  // truncated output keeps the pre-send hold rather than silently sending).
  severity: z.enum(['critical', 'minor']).default('critical'),
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
  | { status: 'ok'; pass: boolean; severity: 'critical' | 'minor'; reasons: string[] }
  | { status: 'transport'; reasons: string[]; rationale?: string }
  | { status: 'unparseable'; reasons: string[] };

async function llmSentryAttempt(system: string, userPrompt: string): Promise<SentryAttempt> {
  let raw: string;
  try {
    const out = await callClaude({
      tier: 'haiku',
      systemFragments: [{ text: system, cache: true }],
      userPrompt,
      // 200 was truncating the JSON mid-reasons once severity + verbose French
      // reasons landed (live 2026-07-07: "LLM output unparseable" on every
      // turn) — the parse failure then flag-ran every message.
      maxTokens: 400,
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
  return {
    status: 'ok',
    pass: result.verdict === 'pass',
    severity: result.severity,
    reasons: result.reasons,
  };
}

async function llmSentryCheck(
  db: Database,
  draft: string,
  ctx: ComplianceCheckInput['ctx'],
  serverHits: ServerRule[],
): Promise<{
  outcome: 'pass' | 'block' | 'flag';
  reasons: string[];
  rationale?: string;
}> {
  const userPrompt = [
    'Contexte :',
    `- Canal : ${ctx.channel}`,
    `- Produit : ${ctx.productLine === 'scooter' ? 'trottinette' : 'auto'}`,
    `- Statut du lead : ${ctx.leadStatus}`,
    ctx.quoteContext
      ? `- Devis Maxance de CE client (FAITS vérifiés en base — les chiffres cohérents avec ces devis sont AUTORISÉS) : ${ctx.quoteContext}`
      : null,
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

  // Unparseable output gets ONE same-prompt retry — a single Haiku flake must
  // not disturb a clean draft. RESTRUCTURE (2026-07-07, Ridaa): the LLM layer
  // is ADVISORY except for critical red lines —
  //   - ok + pass            → pass
  //   - ok + block/critical  → block (pre-send hold + management decision)
  //   - ok + block/minor     → flag (message SENDS, audit-logged for review)
  //   - transport error      → flag (hard server rules already passed; an LLM
  //                            outage must not silence the sales conversation)
  //   - unparseable ×2       → flag (same reasoning — was the "technical
  //                            glitch" approval noise management kept getting)
  let attempt = await llmSentryAttempt(system, userPrompt);
  if (attempt.status === 'unparseable') {
    logger.warn({ reasons: attempt.reasons }, 'compliance: LLM output unparseable — retrying once');
    attempt = await llmSentryAttempt(system, userPrompt);
  }
  if (attempt.status === 'ok') {
    if (attempt.pass) return { outcome: 'pass', reasons: attempt.reasons };
    return {
      outcome: attempt.severity === 'critical' ? 'block' : 'flag',
      reasons: attempt.reasons,
    };
  }
  return {
    outcome: 'flag',
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

  // LLM check — soft hits surface to the LLM as a hint. Only a CRITICAL
  // red-line verdict holds the message; minor concerns and LLM availability
  // problems flag-and-send (see llmSentryCheck).
  const llm = await llmSentryCheck(db, input.draft, input.ctx, softHits);
  if (llm.outcome === 'block') {
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
    reasons: llm.outcome === 'flag' ? llm.reasons : [],
    ruleHits: softHits.map((r) => r.name),
    ...(llm.outcome === 'flag' ? { flagged: true } : {}),
    ...(llm.rationale ? { llmRationale: llm.rationale } : {}),
    durationMs: Date.now() - t0,
  };
}

/**
 * Build the sentry's `quoteContext` line from the lead's quotes — the FACTS
 * that stop the LLM sentry from blocking devis-backed prices as "invented".
 * One line, newest-first, only quotes that produced prices or a real devis.
 * Best-effort: returns undefined on any error (the sentry then just judges
 * without it, as before).
 */
export async function buildQuoteContextLine(
  db: Database,
  leadId: string,
): Promise<string | undefined> {
  try {
    const { quotes } = await import('../db/schema/index.js');
    const { desc, eq } = await import('drizzle-orm');
    const rows = await db
      .select({
        devis: quotes.maxanceDevisNumber,
        monthly: quotes.monthlyPremium,
        annual: quotes.annualPremium,
        comptant: quotes.montantComptant,
      })
      .from(quotes)
      .where(eq(quotes.leadId, leadId))
      .orderBy(desc(quotes.requestedAt))
      .limit(5);
    const useful = rows.filter((r) => r.devis || r.monthly);
    if (useful.length === 0) return undefined;
    const devisRefs = useful.map((r) => r.devis).filter(Boolean);
    const priced = useful.find((r) => r.monthly);
    const parts: string[] = [];
    if (devisRefs.length > 0) {
      parts.push(`${devisRefs.length} devis générés et envoyés (${devisRefs.join(', ')})`);
    } else {
      parts.push('tarification Maxance effectuée (menu de prix présenté au client)');
    }
    if (priced?.monthly) parts.push(`mensualité ${priced.monthly} €/mois`);
    if (priced?.annual) parts.push(`annuel ${priced.annual} €`);
    if (priced?.comptant) parts.push(`premier paiement ${priced.comptant} €`);
    return parts.join(' — ');
  } catch {
    return undefined;
  }
}

// Exposed for unit tests that introspect the rule book.
export { SERVER_RULES };
