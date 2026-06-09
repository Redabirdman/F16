/**
 * LLM interpreter for human replies to a human-action (M12 P3 — intelligence).
 *
 * Ridaa/Achraf reply in their own words ("approved", "looks good", "redo the
 * speed one to show a stand-up scooter, the others are fine"). Rather than
 * regex-match, we ask an LLM to pick the option that matches their REAL intent
 * and, for a revise, distil a clear, actionable instruction. This is the
 * "manager brain" of the WhatsApp approval loop — reasoning, not keywords.
 *
 * Falls back to null on an unparseable model reply so the caller can degrade to
 * the deterministic fast-path / ask for clarification.
 */
import { callClaude } from '../../llm/claude.js';
import { logger } from '../../logger.js';
import type { Database } from '../../db/index.js';
import { registerPrompt, resolvePrompt } from '../../prompts/registry.js';
import type { HumanAction, HumanActionOption } from '../../db/schema/agent-runtime.js';

// M14.T6 — editable instruction for the WhatsApp reply interpreter.
const REPORTER_INTERPRET_KEY = 'reporter.interpret';
const REPORTER_INTERPRET_SYSTEM =
  "Tu es l'assistant qui interprète les réponses de Ridaa et Achraf, les dirigeants d'Assuryal, " +
  'à une demande de validation envoyée sur WhatsApp. Comprends leur intention RÉELLE quelle que soit ' +
  'la formulation (français/anglais, familier, abréviations, fautes de frappe, temps passé comme ' +
  '"approved"/"validé"). Choisis EXACTEMENT une des options proposées. Si c\'est une demande de ' +
  'modification (revise), reformule leur demande en une instruction claire, précise et actionnable ' +
  'pour le créateur de visuels (mentionne quel visuel et quel changement). Réponds UNIQUEMENT en JSON.';
registerPrompt({
  key: REPORTER_INTERPRET_KEY,
  label: 'Reporter — interprète des réponses WhatsApp',
  agentRole: 'reporter-agent',
  description:
    'Instruction de l’interpréteur LLM qui mappe une réponse libre (sur WhatsApp) vers une option de ' +
    'validation + une consigne actionnable. Les options + le message sont fournis dans le prompt utilisateur.',
  getDefault: () => REPORTER_INTERPRET_SYSTEM,
});

export interface InterpretedReply {
  optionId: string;
  optionKind: HumanActionOption['kind'];
  /** For revise: a clear, actionable restatement of the requested change. */
  feedback: string | null;
  confidence: 'high' | 'low';
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function interpretHumanReply(args: {
  action: HumanAction;
  message: string;
  callImpl?: typeof callClaude;
  /** When provided, resolves the (admin-editable) interpreter prompt override. */
  db?: Database;
}): Promise<InterpretedReply | null> {
  const options = args.action.options as HumanActionOption[];
  if (options.length === 0) return null;
  const optionList = options.map((o) => `- id="${o.id}" (type=${o.kind}) : ${o.label}`).join('\n');

  const systemPrompt = args.db
    ? await resolvePrompt(args.db, REPORTER_INTERPRET_KEY, () => REPORTER_INTERPRET_SYSTEM)
    : REPORTER_INTERPRET_SYSTEM;

  const userPrompt =
    `DEMANDE EN ATTENTE DE VALIDATION:\n${args.action.summary}\n\n` +
    `OPTIONS POSSIBLES:\n${optionList}\n\n` +
    `RÉPONSE DE L'HUMAIN:\n"${args.message}"\n\n` +
    'Réponds en JSON strict, sans texte autour: ' +
    '{"optionId":"<id exact de l\'option choisie>","feedback":"<si revise: instruction claire et ' +
    'actionnable; sinon null>","confidence":"high"|"low"}';

  const call = args.callImpl ?? callClaude;
  let text: string;
  try {
    const out = await call({
      tier: 'haiku',
      systemPrompt,
      userPrompt,
      maxTokens: 400,
      structured: false,
    });
    text = typeof out === 'string' ? out : out.text;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'interpret: LLM call failed',
    );
    return null;
  }

  const parsed = parseJsonLoose(text);
  if (!parsed) return null;
  const optionId = typeof parsed.optionId === 'string' ? parsed.optionId : '';
  const opt = options.find((o) => o.id === optionId);
  if (!opt) return null;
  const feedbackRaw = parsed.feedback;
  const feedback =
    typeof feedbackRaw === 'string' &&
    feedbackRaw.trim() &&
    feedbackRaw.trim().toLowerCase() !== 'null'
      ? feedbackRaw.trim()
      : null;
  return {
    optionId: opt.id,
    optionKind: opt.kind,
    feedback,
    confidence: parsed.confidence === 'high' ? 'high' : 'low',
  };
}
