import { z } from 'zod';

/**
 * Strongly-typed registry mapping intent name -> zod schema for its payload.
 * Producing or consuming an intent with no registered schema MUST throw.
 *
 * Pattern: each domain module (lead.ts, quote.ts, ...) calls registerIntent()
 * at module load with its (name, schema). The barrel re-exports from each
 * module, which triggers registration before any caller invokes
 * validateIntentPayload.
 */
const _registry = new Map<string, z.ZodTypeAny>();

export function registerIntent<S extends z.ZodTypeAny>(name: string, schema: S): S {
  if (_registry.has(name)) {
    throw new Error(`Intent ${name} already registered`);
  }
  _registry.set(name, schema);
  return schema;
}

export function getIntentSchema(name: string): z.ZodTypeAny | undefined {
  return _registry.get(name);
}

export function listIntents(): string[] {
  return [..._registry.keys()].sort();
}

/**
 * Validate a payload against the registered schema for an intent.
 * Throws if the intent is not registered, or if the payload doesn't match.
 * Returns the parsed (typed) payload on success.
 */
export function validateIntentPayload(name: string, payload: unknown): unknown {
  const schema = _registry.get(name);
  if (!schema) {
    throw new Error(`Unknown intent: ${name}. Register it in src/intents/<domain>.ts first.`);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // IMPORTANT: do not log the payload (may contain PII). Just the issue list.
    throw new Error(`Invalid payload for intent ${name}: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

/** Test-only reset. */
export function __resetIntentsForTests(): void {
  _registry.clear();
}
