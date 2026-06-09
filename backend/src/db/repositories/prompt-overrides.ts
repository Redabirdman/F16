/**
 * prompt_overrides repository (M14.T6) — CRUD on the admin-editable prompt
 * overrides. Keyed on the registry `key`. See `src/prompts/registry.ts`.
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import { promptOverrides, type PromptOverride } from '../schema/prompt-overrides.js';

export async function getOverride(db: Database, key: string): Promise<PromptOverride | null> {
  const [row] = await db
    .select()
    .from(promptOverrides)
    .where(eq(promptOverrides.key, key))
    .limit(1);
  return row ?? null;
}

export async function listOverrides(db: Database): Promise<PromptOverride[]> {
  return db.select().from(promptOverrides);
}

export async function upsertOverride(
  db: Database,
  key: string,
  content: string,
  updatedBy: string | null,
): Promise<void> {
  await db
    .insert(promptOverrides)
    .values({ key, content, updatedBy })
    .onConflictDoUpdate({
      target: promptOverrides.key,
      set: { content, updatedBy, updatedAt: sql`now()` },
    });
}

export async function deleteOverride(db: Database, key: string): Promise<boolean> {
  const res = await db
    .delete(promptOverrides)
    .where(eq(promptOverrides.key, key))
    .returning({ key: promptOverrides.key });
  return res.length > 0;
}
