/**
 * Knowledge ingestion CLI (F16 M7.T1).
 *
 * Bootstrap entry point for populating the `knowledge_chunks` table from a
 * local Markdown file. Default target is the Assuryal master knowledge MD
 * (`../ASSURYAL base connaissance agent.md` relative to backend/).
 *
 * Usage:
 *   pnpm exec tsx scripts/ingest-knowledge.ts \
 *     [--source <name>]       (default: assuryal_knowledge_md)
 *     [--path <file>]         (default: ../ASSURYAL base connaissance agent.md)
 *     [--dry-run]             preview chunks without embedding + writing
 *     [--batch-size <n>]      embedding batch size (default 32)
 *
 * Required env:
 *   DATABASE_URL          Postgres URL (pgvector required)
 *   OPENROUTER_API_KEY    text-embedding-3-small via OpenRouter (unless --dry-run)
 *
 * Output: a single JSON line (the IngestionResult) on stdout. Logs go to
 * stderr via the shared pino logger.
 */
import { resolve } from 'node:path';
import { createDb } from '../src/db/index.js';
import { logger } from '../src/logger.js';
import { ingestSource, markdownFileAdapter } from '../src/knowledge/index.js';

interface CliArgs {
  source: string;
  path: string;
  dryRun: boolean;
  batchSize: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    source: 'assuryal_knowledge_md',
    path: '../ASSURYAL base connaissance agent.md',
    dryRun: false,
    batchSize: 32,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--source':
        out.source = argv[++i] ?? out.source;
        break;
      case '--path':
        out.path = argv[++i] ?? out.path;
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--batch-size': {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n > 0) out.batchSize = n;
        break;
      }
      default:
        if (a?.startsWith('--')) {
          logger.warn({ arg: a }, 'ingest-knowledge: unknown flag ignored');
        }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    logger.error('DATABASE_URL is required');
    process.exit(2);
  }
  if (!args.dryRun && !process.env.OPENROUTER_API_KEY) {
    logger.error('OPENROUTER_API_KEY is required (or use --dry-run)');
    process.exit(2);
  }

  const absPath = resolve(process.cwd(), args.path);

  logger.info(
    { source: args.source, path: absPath, dryRun: args.dryRun, batchSize: args.batchSize },
    'ingest-knowledge: starting',
  );

  const db = createDb(dbUrl);

  const result = await ingestSource(
    db,
    markdownFileAdapter,
    { name: args.source, path: absPath },
    { dryRun: args.dryRun, batchSize: args.batchSize },
  );

  // The IngestionResult goes to stdout as a single JSON line — that's what
  // the commit body / CI artifact / human reader will quote.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'ingest-knowledge: fatal');
  process.exit(1);
});
