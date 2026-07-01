/**
 * Progressive quote qualification — the Sales Agent's structured slot memory.
 *
 * Without a durable record of what's already been collected, the agent
 * re-derives "what's still missing" from raw chat history every turn and
 * re-asks answered questions (it acknowledges a value, then forgets it next
 * turn — the "dumb bot" failure the intelligence mandate warns against).
 *
 * This module keeps a structured record per lead (`leads.qualification`) and
 * merges newly-provided fields out of each customer message with a cheap Haiku
 * call — robust to messy French / typos / abbreviations ("je vous ai noté ça
 * vaut 600", "10 fev 1999", "box"). The reply prompt then renders an explicit
 * ✓/✗ checklist (see prompts/index.ts) so the agent asks ONLY for the gaps and
 * fires `quote.request` once every required field is present.
 *
 * Trottinette (V1) fields mirror the `quote.request` formData (minus the fixed
 * `vehicleKind`). Extend the schema when auto qualification lands.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { callClaude } from '../../llm/claude.js';
import { logger } from '../../logger.js';
import type { Database } from '../../db/index.js';
import { leads } from '../../db/schema/index.js';
import { registerPrompt, resolvePrompt } from '../../prompts/registry.js';

/** The structured fields collected for a trottinette quote. All optional — collected progressively. */
export const QualificationSchema = z
  .object({
    purchasePriceEur: z.number().positive().max(100_000).optional(),
    purchaseDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    postalCode: z
      .string()
      .regex(/^\d{5}$/)
      .optional(),
    clientDateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    stationnement: z
      .enum(['garage_box', 'parking_prive_clos', 'parking_prive_non_clos', 'rue'])
      .optional(),
    city: z.string().min(1).optional(),
  })
  .strict();

export type QualificationState = z.infer<typeof QualificationSchema>;

/** The fields REQUIRED before `quote.request` can fire (city is optional). */
export const REQUIRED_QUAL_FIELDS = [
  'purchasePriceEur',
  'purchaseDate',
  'postalCode',
  'clientDateOfBirth',
  'stationnement',
] as const;

/** Which required fields are still missing from a state. */
export function missingQualFields(state: QualificationState): string[] {
  return REQUIRED_QUAL_FIELDS.filter((f) => state[f] === undefined || state[f] === null);
}

/** True when every required field is present. */
export function isQualificationComplete(state: QualificationState): boolean {
  return missingQualFields(state).length === 0;
}

// M14.T6 — editable extractor instruction.
const QUAL_EXTRACT_KEY = 'sales-agent.qualification-extractor';
const QUAL_EXTRACT_SYSTEM =
  "Tu extrais des champs structurés d'un message client pour un devis d'assurance trottinette " +
  "électrique. On te donne l'état DÉJÀ collecté et le NOUVEAU message. Renvoie UNIQUEMENT les " +
  "champs que le NOUVEAU message fournit ou corrige (un objet JSON partiel), rien d'autre. " +
  'Comprends le français familier, les abréviations et les fautes ("ça vaut 600", "10 fev 1999", ' +
  '"box"). Normalise : dates au format YYYY-MM-DD ; prix en nombre (euros) ; code postal = 5 ' +
  'chiffres. Mappe le stationnement sur EXACTEMENT une valeur : "garage_box" (garage/box), ' +
  '"parking_prive_clos" (parking privé fermé), "parking_prive_non_clos" (parking privé ouvert), ' +
  '"rue" (dans la rue). Champs possibles : purchasePriceEur (nombre), purchaseDate (string), ' +
  'postalCode (string), clientDateOfBirth (string), stationnement (string), city (string). ' +
  "N'invente RIEN : si le message ne donne aucun champ, renvoie {}. Réponds en JSON strict.";
registerPrompt({
  key: QUAL_EXTRACT_KEY,
  label: 'Sales Agent — extracteur de qualification devis',
  agentRole: 'sales-agent',
  description:
    "Instruction de l'extracteur (Haiku) qui lit un message client et en tire les champs " +
    "structurés du devis trottinette. L'état actuel + le message sont fournis dans le prompt utilisateur.",
  getDefault: () => QUAL_EXTRACT_SYSTEM,
});

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

/**
 * Merge any quote fields the customer just provided into the current state via
 * a cheap Haiku call. Returns the merged, validated state. On ANY failure
 * (LLM error, bad JSON, schema mismatch) returns `current` UNCHANGED — the
 * extractor can never lose already-collected fields.
 *
 * Only fields the model returns are applied over `current`; omitted fields keep
 * their existing value (so a model that forgets a known field can't drop it).
 */
export async function extractQualification(args: {
  current: QualificationState;
  message: string;
  callImpl?: typeof callClaude;
  /** Resolves the (admin-editable) extractor prompt override when provided. */
  db?: Database;
}): Promise<QualificationState> {
  const { current, message } = args;
  if (!message || message.trim().length === 0) return current;

  const systemPrompt = args.db
    ? await resolvePrompt(args.db, QUAL_EXTRACT_KEY, () => QUAL_EXTRACT_SYSTEM)
    : QUAL_EXTRACT_SYSTEM;
  const userPrompt =
    `ÉTAT DÉJÀ COLLECTÉ (JSON):\n${JSON.stringify(current)}\n\n` +
    `NOUVEAU MESSAGE DU CLIENT:\n"${message}"\n\n` +
    'Renvoie UNIQUEMENT les champs fournis/corrigés par ce message, en JSON strict (objet partiel, {} si aucun).';

  const call = args.callImpl ?? callClaude;
  let text: string;
  try {
    const out = await call({
      tier: 'haiku',
      systemPrompt,
      userPrompt,
      maxTokens: 200,
      structured: false,
    });
    text = typeof out === 'string' ? out : out.text;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'qualification: extractor LLM call failed; keeping current state',
    );
    return current;
  }

  const parsed = parseJsonLoose(text);
  if (!parsed) return current;

  // Validate the model's partial against the field schema; drop anything that
  // doesn't fit rather than corrupt the state. We merge field-by-field so one
  // bad field never discards the good ones.
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || value === undefined) continue;
    const single = QualificationSchema.safeParse({ [key]: value });
    if (single.success && (single.data as Record<string, unknown>)[key] !== undefined) {
      merged[key] = (single.data as Record<string, unknown>)[key];
    }
  }
  return merged as QualificationState;
}

/** Read the persisted qualification state for a lead (empty object when none). */
export async function loadQualification(db: Database, leadId: string): Promise<QualificationState> {
  const [row] = await db
    .select({ qualification: leads.qualification })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  const raw = (row?.qualification ?? null) as unknown;
  const parsed = QualificationSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** Persist the qualification state for a lead. */
export async function saveQualification(
  db: Database,
  leadId: string,
  state: QualificationState,
): Promise<void> {
  await db.update(leads).set({ qualification: state }).where(eq(leads.id, leadId));
}
