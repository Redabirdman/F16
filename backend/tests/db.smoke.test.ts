import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, db } from '../src/db/index.js';
import * as schema from '../src/db/schema/index.js';

describe('db client factory', () => {
  it('createDb() wires postgres-js + drizzle and exposes query/execute', () => {
    // Use a clearly-bogus connection string — postgres-js is lazy and won't
    // actually open a socket until a query runs. We're smoking the wiring only.
    const instance = createDb('postgres://nobody:nobody@127.0.0.1:1/none');
    expect(instance).toBeDefined();
    expect(typeof instance.execute).toBe('function');
    // drizzle exposes a `query` namespace (one entry per schema table); should
    // at minimum be a defined object (empty for the empty barrel).
    expect(instance.query).toBeDefined();
  });

  it('exposes the schema barrel (importable, currently empty)', () => {
    expect(schema).toBeDefined();
    // No tables yet — M2.T3+ will populate this.
    expect(Object.keys(schema).filter((k) => k !== 'default')).toEqual([]);
  });
});

describe('db() lazy singleton', () => {
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedUrl = process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (savedUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = savedUrl;
    }
  });

  it('throws when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL;
    // Reset the cached singleton so this test isn't masked by a previous init.
    const mod = await import('../src/db/index.js');
    mod.__resetDbForTests();
    expect(() => db()).toThrowError(/DATABASE_URL/);
  });
});

// Live-DB integration: only runs when TEST_DATABASE_URL is set (CI / opt-in).
const liveUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!liveUrl)('db() against a live Postgres (TEST_DATABASE_URL)', () => {
  it('runs SELECT 1 AS one', async () => {
    const instance = createDb(liveUrl!);
    const rows = (await instance.execute(sql`SELECT 1 AS one`)) as unknown as Array<{
      one: number;
    }>;
    expect(rows[0]?.one).toBe(1);
  });
});
