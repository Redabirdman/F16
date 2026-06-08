/**
 * Creative learning engine (M12 P3 — intelligence).
 *
 * Turns Ridaa's free-form feedback into DURABLE, reusable creative guidance via
 * an LLM (the "creative director" brain), stores it, and surfaces all
 * applicable guidance for injection into future prompts. This is how the system
 * learns: a one-off correction ("we insure stand-up scooters, not seated ones")
 * becomes a permanent constraint on every creative, instead of a dumb verbatim
 * append.
 */
import { desc, eq, isNull, or } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { callClaude } from '../../llm/claude.js';
import { logger } from '../../logger.js';
import { creativeLearnings } from '../../db/schema/index.js';
import type { CreativeAngle } from './brand.js';

export interface DistilledLearning {
  guidance: string;
  /** null = global (all creatives); else the angle key. */
  angle: string | null;
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try {
    return JSON.parse(cleaned.slice(s, e + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** LLM-distil a piece of feedback into one reusable creative constraint. */
export async function distillFeedbackToGuidance(args: {
  feedback: string;
  angle: CreativeAngle;
  callImpl?: typeof callClaude;
}): Promise<DistilledLearning | null> {
  const systemPrompt =
    "Tu es le directeur créatif d'Assuryal (assurance pour trottinettes électriques en France). " +
    "À partir d'un retour de Ridaa sur un visuel publicitaire, formule UNE consigne créative claire, " +
    "précise et RÉUTILISABLE (en français) que le générateur d'images devra TOUJOURS respecter ensuite. " +
    'Décide si la consigne est GLOBALE (vaut pour tous les visuels) ou spécifique à cet angle. ' +
    'Exemple — feedback "le scooter a une selle, nous on assure des trottinettes où on se tient debout" ' +
    '→ consigne globale: "Le véhicule doit être une trottinette électrique sur laquelle le rider se tient ' +
    'DEBOUT (plateau plat, guidon vertical, deux petites roues), JAMAIS un scooter/cyclomoteur avec une ' +
    'selle ou sur lequel on s\'assoit." Réponds UNIQUEMENT en JSON.';
  const userPrompt =
    `ANGLE DU VISUEL: ${args.angle}\nFEEDBACK DE RIDAA: "${args.feedback}"\n\n` +
    'JSON strict: {"guidance":"<consigne claire et réutilisable>","scope":"global"|"angle"}';

  const call = args.callImpl ?? callClaude;
  let text: string;
  try {
    const out = await call({
      tier: 'haiku',
      systemPrompt,
      userPrompt,
      maxTokens: 300,
      structured: false,
    });
    text = typeof out === 'string' ? out : out.text;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'learnings: distil LLM failed',
    );
    return null;
  }
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed.guidance !== 'string' || !parsed.guidance.trim()) return null;
  return {
    guidance: parsed.guidance.trim(),
    angle: parsed.scope === 'angle' ? args.angle : null,
  };
}

export async function storeLearning(
  db: Database,
  args: {
    guidance: string;
    angle: string | null;
    sourceFeedback?: string;
    createdByAgent?: string;
  },
): Promise<void> {
  await db.insert(creativeLearnings).values({
    angle: args.angle,
    guidance: args.guidance,
    sourceFeedback: args.sourceFeedback ?? null,
    createdByAgent: args.createdByAgent ?? 'creative-agent',
  });
}

/** All guidance applicable to an angle (global + angle-specific), newest first. */
export async function loadLearnings(db: Database, angle: CreativeAngle): Promise<string[]> {
  const rows = await db
    .select()
    .from(creativeLearnings)
    .where(or(isNull(creativeLearnings.angle), eq(creativeLearnings.angle, angle)))
    .orderBy(desc(creativeLearnings.createdAt))
    .limit(40);
  return rows.map((r) => r.guidance);
}

/**
 * Distil + persist a learning from feedback, returning the guidance text (for
 * logging). Best-effort: a failed distillation returns null and the caller
 * proceeds without a stored learning.
 */
export async function learnFromFeedback(
  db: Database,
  args: { feedback: string; angle: CreativeAngle; createdByAgent?: string },
): Promise<DistilledLearning | null> {
  const distilled = await distillFeedbackToGuidance({ feedback: args.feedback, angle: args.angle });
  if (!distilled) return null;
  await storeLearning(db, {
    guidance: distilled.guidance,
    angle: distilled.angle,
    sourceFeedback: args.feedback,
    ...(args.createdByAgent ? { createdByAgent: args.createdByAgent } : {}),
  });
  logger.info(
    { angle: distilled.angle ?? 'global', guidance: distilled.guidance },
    'learnings: distilled + stored a creative learning',
  );
  return distilled;
}
