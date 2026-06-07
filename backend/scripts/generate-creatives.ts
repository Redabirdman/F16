/* eslint-disable no-console -- standalone creative-generation ops script. */
/**
 * Generate Assuryal trottinette ad creatives via Nano Banana (M12 Phase 3).
 *
 *   npx tsx scripts/generate-creatives.ts [angle ...] [--format=1:1]
 *
 * Defaults to angles fear/value/speed at 1:1. Reads DATABASE_URL +
 * OPENROUTER_API_KEY from backend/.env. Registers each in the creatives table
 * and writes the PNG under .creatives/.
 */
import 'dotenv/config';
import { createDb } from '../src/db/index.js';
import {
  generateAndRegisterCreative,
  ALL_ANGLES,
  type CreativeAngle,
  type CreativeFormat,
} from '../src/agents/creative-agent/index.js';

const args = process.argv.slice(2);
const formatArg = args.find((a) => a.startsWith('--format='))?.split('=')[1] as
  | CreativeFormat
  | undefined;
const angleArgs = args.filter((a) => !a.startsWith('--')) as CreativeAngle[];
const angles = angleArgs.length > 0 ? angleArgs : (['fear', 'value', 'speed'] as CreativeAngle[]);

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const db = createDb(dbUrl);

(async () => {
  for (const angle of angles) {
    if (!ALL_ANGLES.includes(angle)) {
      console.log(`skip unknown angle "${angle}" (valid: ${ALL_ANGLES.join(', ')})`);
      continue;
    }
    console.log(`generating ${angle} (${formatArg ?? '1:1'})…`);
    try {
      const c = await generateAndRegisterCreative({
        db,
        angle,
        ...(formatArg ? { format: formatArg } : {}),
      });
      console.log(`  ✓ ${c.id}  ${c.fileUrl}`);
    } catch (err) {
      console.error(`  ✗ ${angle}:`, err instanceof Error ? err.message : err);
    }
  }
  process.exit(0);
})();
