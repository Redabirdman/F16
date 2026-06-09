/**
 * Prompt registry + override resolver (M14.T6).
 *
 * Every agent prompt site registers a stable `key` + a code `getDefault`. The
 * admin can store an override per key (`prompt_overrides` table); `resolvePrompt`
 * returns the override when present, else the code default. It NEVER throws — any
 * DB/cache failure falls back to the default, so a prompt edit (or a DB blip) can
 * never break an agent.
 *
 * Caching: overrides are cached in-memory keyed by a monotonically-bumped version;
 * `bustPromptCache()` (called on every admin write) invalidates the whole cache.
 * Single backend process on this PC → no cross-process invalidation needed.
 */
import type { Database } from '../db/index.js';
import { getOverride } from '../db/repositories/prompt-overrides.js';

export interface PromptDef {
  /** Stable dotted id, e.g. `sales-agent.system`. */
  key: string;
  /** Human label for the admin list. */
  label: string;
  /** Owning agent/role, for grouping in the admin. */
  agentRole: string;
  /** What this prompt is + caveats for the editor. */
  description: string;
  /** The code default — the source of truth when no override is set. */
  getDefault: () => string;
}

const registry = new Map<string, PromptDef>();
let cacheVersion = 0;
const cache = new Map<string, { v: number; content: string | null }>();

/** Register an editable prompt. Last registration wins (idempotent on reload). */
export function registerPrompt(def: PromptDef): void {
  registry.set(def.key, def);
}

/** All registered prompt defs, sorted by agentRole then key. */
export function listPromptDefs(): PromptDef[] {
  return [...registry.values()].sort(
    (a, b) => a.agentRole.localeCompare(b.agentRole) || a.key.localeCompare(b.key),
  );
}

export function getPromptDef(key: string): PromptDef | undefined {
  return registry.get(key);
}

/** Invalidate the override cache — call after any write to prompt_overrides. */
export function bustPromptCache(): void {
  cacheVersion += 1;
}

/**
 * Resolve a prompt: the DB override if set, else the code default. Safe — any
 * error returns the default so an agent is never broken by this layer.
 */
export async function resolvePrompt(
  db: Database,
  key: string,
  getDefault: () => string,
): Promise<string> {
  try {
    const cached = cache.get(key);
    if (cached && cached.v === cacheVersion) return cached.content ?? getDefault();
    const row = await getOverride(db, key);
    cache.set(key, { v: cacheVersion, content: row?.content ?? null });
    return row?.content ?? getDefault();
  } catch {
    return getDefault();
  }
}

/** Test-only: clear the registry + cache. */
export function __resetRegistryForTests(): void {
  registry.clear();
  cache.clear();
  cacheVersion = 0;
}
