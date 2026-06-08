/* eslint-disable no-console -- standalone DLQ ops CLI. */
/**
 * Dead-letter queue ops (M16).
 *
 *   npx tsx scripts/dlq.ts list   <queue> [limit]   # inspect parked records
 *   npx tsx scripts/dlq.ts count  <queue>           # how many are parked
 *   npx tsx scripts/dlq.ts replay <queue> [limit]   # re-drive onto original queue
 *   npx tsx scripts/dlq.ts purge  <queue>           # wipe the DLQ
 *
 * <queue> is the ORIGINAL queue name (lead, customer, quote, voice, ads,
 * human_action, knowledge, compliance, operations, engagement) — NOT the
 * `-dlq` suffix.
 */
import 'dotenv/config';
import { listDlq, countDlq, replayDlq, purgeDlq } from '../src/queue/dlq.js';
import { shutdownQueues } from '../src/queue/index.js';

async function main(): Promise<void> {
  const [cmd, queue, limitArg] = process.argv.slice(2);
  if (!cmd || !queue) {
    console.error('usage: dlq.ts <list|count|replay|purge> <queue> [limit]');
    process.exit(1);
  }
  const limit = limitArg ? Number(limitArg) : 100;

  switch (cmd) {
    case 'list': {
      const records = await listDlq(queue, limit);
      console.log(`${records.length} dead-letter record(s) on ${queue}-dlq`);
      for (const r of records) {
        console.log(
          `- ${r.deadLetteredAt}  ${r.jobName}  attempts=${r.attemptsMade}  reason=${r.failedReason}`,
        );
      }
      break;
    }
    case 'count': {
      console.log(`${await countDlq(queue)} parked on ${queue}-dlq`);
      break;
    }
    case 'replay': {
      const n = await replayDlq(queue, limit);
      console.log(`replayed ${n} job(s) from ${queue}-dlq onto ${queue}`);
      break;
    }
    case 'purge': {
      await purgeDlq(queue);
      console.log(`purged ${queue}-dlq`);
      break;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
}

main()
  .then(() => shutdownQueues())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('dlq op failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
