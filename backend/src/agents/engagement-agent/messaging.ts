/**
 * Nudge generation for the Customer Engagement Agent (M11).
 *
 * Locked design: messages are LLM-generated (Claude Haiku), NOT templated.
 * Templates feel like a CRM blast; LLM-generated keeps the tone consistent
 * with the rest of the Sales Agent's French, conversational voice. We do
 * fall back to a deterministic template when the LLM call throws — a single
 * outage shouldn't strand the entire engagement pipeline.
 *
 * Step semantics:
 *   - step 1 (first nudge, T+24h): brief, friendly check-in.
 *   - step 2 (softer, T+72h): explicitly low-pressure; offers a graceful exit
 *     ("dites-moi et je clôture").
 *
 * step 3 (T+7d) is NOT a customer-facing message — that path escalates to
 * Ridaa/Achraf via the Reporter Agent and marks the lead dormant. So this
 * module only ever generates steps 1 + 2.
 *
 * PII discipline: only the customer's first name (already plaintext after
 * `decryptPII` at the call site) and product line touch the prompt. Phones,
 * emails, full identity stay out.
 */
import { callClaude } from '../../llm/claude.js';
import { logger } from '../../logger.js';

const HAIKU_MAX_TOKENS = 220;

/** Cadence step the agent has decided to act on. */
export type EngagementStep = 1 | 2;

export interface NudgeGenInput {
  step: EngagementStep;
  /** Customer first name (plaintext, optional). */
  firstName: string | null;
  /** 'scooter' or 'car' — drives the product wording. */
  productLine: 'scooter' | 'car';
  /** Last few inbound + outbound turns, oldest first, for tone context. */
  recentSnippets: Array<{ direction: 'inbound' | 'outbound'; content: string }>;
}

export interface NudgeGenResult {
  text: string;
  source: 'llm' | 'fallback';
}

/**
 * Generate a French nudge message for the requested cadence step. Tries
 * Haiku first; on any throw or empty response falls back to the deterministic
 * template so the agent always has something to send.
 */
export async function generateNudgeText(input: NudgeGenInput): Promise<NudgeGenResult> {
  try {
    const text = await callClaudeForNudge(input);
    const cleaned = stripWrappers(text);
    if (cleaned.length === 0) {
      logger.warn(
        { step: input.step, productLine: input.productLine },
        'engagement-agent: Haiku returned empty nudge — falling back to template',
      );
      return { text: fallbackNudge(input), source: 'fallback' };
    }
    return { text: cleaned, source: 'llm' };
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        step: input.step,
        productLine: input.productLine,
      },
      'engagement-agent: Haiku nudge generation failed — falling back to template',
    );
    return { text: fallbackNudge(input), source: 'fallback' };
  }
}

async function callClaudeForNudge(input: NudgeGenInput): Promise<string> {
  const systemPrompt = buildSystemPrompt(input.step);
  const userPrompt = buildUserPrompt(input);
  // `callClaude` returns `string | ClaudeCallStructuredOutcome`; without
  // `structured: true` the runtime value is always a string. Narrow with a
  // typeof check so we don't drop the type guard.
  const out = await callClaude({
    tier: 'haiku',
    systemPrompt,
    userPrompt,
    maxTokens: HAIKU_MAX_TOKENS,
    logContext: { agent: 'engagement-agent', step: input.step },
  });
  return typeof out === 'string' ? out : out.text;
}

/**
 * System prompt — tone + rules + the cadence-specific intent. Per step so
 * the LLM hits the right register without having to guess from context.
 */
function buildSystemPrompt(step: EngagementStep): string {
  const sharedRules = [
    'Tu es un conseiller Assuryal (assurance en France). Tu écris en français,',
    'sur un ton chaleureux, naturel, jamais commercial agressif.',
    '',
    'Règles strictes :',
    "- 1 à 2 phrases maximum. Pas de signature, pas d'emojis.",
    "- Ne JAMAIS répéter un prix, un devis, ou un détail produit que tu n'as pas en contexte.",
    '- Ne JAMAIS supposer que le client est encore intéressé : pose la question.',
    '- Si tu connais le prénom, tutoie sans excès. Sinon, dis simplement « Bonjour ».',
    "- Pas de phrases du type « je voulais simplement m'assurer », « je me permets de revenir vers vous » — trop corporate.",
    '- Réponds UNIQUEMENT par le message à envoyer (pas de préambule, pas de guillemets).',
  ].join('\n');

  const stepIntent =
    step === 1
      ? [
          '',
          'Objectif : premier rappel doux 24h après la dernière interaction.',
          'Demande simplement si le client a pu prendre un moment pour réfléchir au devis / à sa demande.',
        ].join('\n')
      : [
          '',
          'Objectif : deuxième et dernier rappel, plus discret encore (72h après la dernière interaction).',
          "Propose explicitement de clôturer le dossier si le client n'est plus intéressé,",
          'sans culpabiliser ni insister.',
        ].join('\n');

  return sharedRules + stepIntent;
}

/**
 * User prompt — minimal per-lead context. The LLM gets first name, product
 * line, and (when present) the last inbound topic snippet so the nudge can
 * gently reference the conversation without quoting it.
 */
function buildUserPrompt(input: NudgeGenInput): string {
  const productLabel = input.productLine === 'scooter' ? 'assurance trottinette' : 'assurance auto';
  const lastInbound = input.recentSnippets
    .filter((t) => t.direction === 'inbound')
    .slice(-1)[0]?.content;
  const lastInboundLine = lastInbound
    ? `Dernier message du client (extrait) : ${truncate(lastInbound, 240)}`
    : "Le client n'a pas encore répondu après le premier contact.";
  const firstNameLine = input.firstName
    ? `Prénom du client : ${input.firstName}`
    : 'Prénom du client : inconnu';
  return [
    `Sujet : ${productLabel}`,
    firstNameLine,
    lastInboundLine,
    '',
    'Rédige le message de relance maintenant.',
  ].join('\n');
}

/** Deterministic safety net — used when Haiku is unavailable. */
export function fallbackNudge(input: NudgeGenInput): string {
  const greeting = input.firstName ? `Bonjour ${input.firstName},` : 'Bonjour,';
  const product = input.productLine === 'scooter' ? 'votre devis trottinette' : 'votre devis auto';
  if (input.step === 1) {
    return `${greeting} avez-vous eu le temps de jeter un œil à ${product} ? Je reste à votre disposition.`;
  }
  return `${greeting} pas de souci si vous n'êtes plus intéressé par ${product} — dites-moi et je clôture le dossier.`;
}

/**
 * Light wrapper-strip — Haiku occasionally returns wrapped text. We don't
 * need the Sales Agent's full `cleanLLMReply` since the nudge prompt forbids
 * preambles; this just trims and removes paired surrounding quotes.
 */
function stripWrappers(raw: string): string {
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith('«') && s.endsWith('»')) ||
    (s.startsWith('“') && s.endsWith('”'))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
