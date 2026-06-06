/**
 * Debug: dump a lead's conversation thread (inbound transcripts + outbound
 * replies) so we can see exactly what STT heard and what the brain answered.
 *
 *   npx tsx scripts/dump-thread.ts <leadId> [channel]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
function loadEnv(path: string): void {
  let txt: string;
  try {
    txt = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv(resolve(here, '..', '.env'));

const { createDb } = await import('../src/db/index.js');
const { listTurns } = await import('../src/db/repositories/conversation-turns.js');

async function main(): Promise<void> {
  const leadId = process.argv[2];
  if (!leadId) throw new Error('usage: dump-thread.ts <leadId> [channel]');
  const channel = process.argv[3] as 'voice' | undefined;
  const db = createDb(process.env.DATABASE_URL ?? '');
  const turns = await listTurns(db, { leadId, ...(channel ? { channel } : {}) });
  for (const t of turns) {
    const ts = (t.occurredAt as Date).toISOString().slice(11, 19);
    const arrow = t.direction === 'inbound' ? '←IN ' : '→OUT';
    console.log(`${ts} ${arrow} [${t.channel}] ${JSON.stringify(t.content)}`);
  }
  console.log(`(${turns.length} turns)`);
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('dump-thread failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
