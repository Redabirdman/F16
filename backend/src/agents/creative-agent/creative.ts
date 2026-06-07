/**
 * Creative Agent orchestrator (M12 Phase 3).
 *
 * Generates a brand-locked Assuryal trottinette creative for an angle, hashes
 * the bytes (content-addressed dedup), writes the PNG to disk, and registers it
 * in the `creatives` table with its angle/format/copy/provenance. The Ad Expert
 * (drafting) then picks creatives by (productLine, angle).
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from '../../db/index.js';
import { logger } from '../../logger.js';
import type { Creative } from '../../db/schema/ads.js';
import { insertCreative, getCreativeBySha256 } from '../../db/repositories/ads.js';
import { generateImage } from './generate.js';
import {
  buildCreativePrompt,
  angleCopy,
  ASSURYAL_LOGO_PATH,
  BRAND,
  type CreativeAngle,
} from './brand.js';

export type CreativeFormat = '1:1' | '4:5' | '9:16';

const FORMAT_ASPECT: Record<CreativeFormat, 'square' | 'portrait'> = {
  '1:1': 'square',
  '4:5': 'portrait',
  '9:16': 'portrait',
};

export interface GenerateCreativeOptions {
  db: Database;
  angle: CreativeAngle;
  format?: CreativeFormat;
  /** Output dir for PNGs. Default: $F16_CREATIVES_DIR or <cwd>/.creatives. */
  outputDir?: string;
  logoPath?: string;
  apiKey?: string;
  /** Provenance tag. Default 'ai-nano-banana'. */
  generatedBy?: string;
  fetchImpl?: typeof fetch;
}

export async function generateAndRegisterCreative(
  opts: GenerateCreativeOptions,
): Promise<Creative> {
  const format = opts.format ?? '1:1';
  const prompt = buildCreativePrompt(opts.angle);
  const bytes = await generateImage({
    prompt,
    logoPath: opts.logoPath ?? ASSURYAL_LOGO_PATH,
    aspect: FORMAT_ASPECT[format],
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  const sha = createHash('sha256').update(bytes).digest('hex');

  // Content dedup — an identical render already on file is reused.
  const existing = await getCreativeBySha256(opts.db, sha);
  if (existing) {
    logger.info({ angle: opts.angle, format, sha: sha.slice(0, 12) }, 'creative: dedup hit');
    return existing;
  }

  const dir =
    opts.outputDir ?? process.env['F16_CREATIVES_DIR'] ?? join(process.cwd(), '.creatives');
  await mkdir(dir, { recursive: true });
  const fileName = `assuryal-trottinette-${opts.angle}-${format.replace(':', 'x')}-${sha.slice(0, 12)}.png`;
  const filePath = join(dir, fileName);
  await writeFile(filePath, bytes);

  const copy = angleCopy(opts.angle);
  const row = await insertCreative(opts.db, {
    name: `trottinette-${opts.angle}-${format}`,
    angle: opts.angle,
    productLine: 'scooter',
    format,
    headline: copy.headline,
    subCopy: copy.description,
    ctaText: BRAND.cta,
    fileUrl: filePath,
    fileSha256: sha,
    generationPrompt: prompt,
    generationMeta: { model: 'google/gemini-3-pro-image-preview', format, bytes: bytes.length },
    generatedBy: opts.generatedBy ?? 'ai-nano-banana',
  });

  logger.info(
    { creativeId: row.id, angle: opts.angle, format, bytes: bytes.length, file: fileName },
    'creative: generated + registered',
  );
  return row;
}
