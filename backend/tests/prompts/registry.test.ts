/**
 * Prompt registry resolver (M14.T6) — DB-backed.
 *
 * Verifies the safe override-else-default behaviour + cache busting on write.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/index.js';
import { upsertOverride, deleteOverride } from '../../src/db/repositories/prompt-overrides.js';
import {
  resolvePrompt,
  registerPrompt,
  listPromptDefs,
  getPromptDef,
  bustPromptCache,
  __resetRegistryForTests,
} from '../../src/prompts/registry.js';

const pgUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!pgUrl);

d('prompt registry resolver', () => {
  let db: Database;
  beforeEach(async () => {
    db = createDb(pgUrl!);
    await db.execute(sql`TRUNCATE TABLE prompt_overrides`);
    __resetRegistryForTests();
  });
  afterEach(() => __resetRegistryForTests());

  it('returns the code default when no override exists', async () => {
    const out = await resolvePrompt(db, 'x.y', () => 'DEFAULT');
    expect(out).toBe('DEFAULT');
  });

  it('returns the override after upsert + cache bust, then default again after delete', async () => {
    await upsertOverride(db, 'x.y', 'OVERRIDE', 'tester');
    bustPromptCache();
    expect(await resolvePrompt(db, 'x.y', () => 'DEFAULT')).toBe('OVERRIDE');

    await deleteOverride(db, 'x.y');
    bustPromptCache();
    expect(await resolvePrompt(db, 'x.y', () => 'DEFAULT')).toBe('DEFAULT');
  });

  it('registers + lists defs sorted by agentRole then key', () => {
    registerPrompt({
      key: 'b.one',
      label: 'B1',
      agentRole: 'beta',
      description: '',
      getDefault: () => 'b1',
    });
    registerPrompt({
      key: 'a.two',
      label: 'A2',
      agentRole: 'alpha',
      description: '',
      getDefault: () => 'a2',
    });
    const defs = listPromptDefs();
    expect(defs.map((d) => d.key)).toEqual(['a.two', 'b.one']);
    expect(getPromptDef('a.two')?.label).toBe('A2');
    expect(getPromptDef('nope')).toBeUndefined();
  });
});
