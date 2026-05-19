/**
 * Intent executor — translates HTTP intent payloads into Stagehand V3 calls.
 *
 * Five intents (Maxance-agnostic; M8.T2 will compose them):
 *   - goto       → page.goto(url) + report title/url
 *   - act        → stagehand.act(instruction) — natural-language click/fill
 *   - extract    → stagehand.extract(instruction, zodSchema) — typed extraction
 *   - observe    → stagehand.observe(instruction) — surface candidate actions
 *   - screenshot → just capture (every intent also screenshots on success)
 *
 * Stagehand V3 surface (drift vs M8 design snippet — confirmed against
 * `node_modules/@browserbasehq/stagehand@3.4.0/dist/esm/lib/v3/v3.d.ts`):
 *   - The natural-language methods live on the Stagehand instance itself, NOT
 *     on `stagehand.page`. There is no `stagehand.page` accessor in V3 — the
 *     equivalent is `stagehand.context.activePage()` which returns a V3 `Page`.
 *   - `page.goto` accepts `{ waitUntil: 'load'|'domcontentloaded'|'networkidle' }`.
 *   - `extract(instruction, schema)` infers the result type from the Zod schema.
 *
 * Every successful intent also captures a screenshot to disk. Cheap (~50KB)
 * and invaluable for the M14 audit log + the M8.T6 PDF capture pipeline.
 */
import { z } from 'zod';
import type { Stagehand } from '@browserbasehq/stagehand';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.js';

export type IntentName = 'goto' | 'act' | 'extract' | 'observe' | 'screenshot';

export interface IntentInput {
  intent: IntentName;
  payload: Record<string, unknown>;
}

export interface IntentResult {
  ok: true;
  intent: IntentName;
  result: unknown;
  screenshotUrl?: string;
  durationMs: number;
}

export interface IntentError {
  ok: false;
  intent: IntentName;
  error: string;
  durationMs: number;
}

const GotoSchema = z.object({ url: z.string().url() });
const ActSchema = z.object({ instruction: z.string().min(1) });
const ObserveSchema = z.object({ instruction: z.string().min(1) });
/**
 * V1 extract schema: flat record of field→primitive type. Keeps the wire shape
 * JSON-friendly (no Zod-over-HTTP), trades off nested/array schemas for shipping.
 * If Maxance needs a nested extract in M8.T2, lift this to a recursive form then.
 */
const ExtractSchema = z.object({
  instruction: z.string().min(1),
  schema: z.record(z.string(), z.enum(['string', 'number', 'boolean'])),
});
const ScreenshotSchema = z.object({}).loose();

/**
 * Build a zod object from the simple field→type mapping the client sent.
 * Kept tiny on purpose — the spec capped V1 at primitives.
 */
function buildExtractSchema(shape: Record<string, 'string' | 'number' | 'boolean'>): z.ZodObject {
  const out: Record<string, z.ZodTypeAny> = {};
  for (const [k, t] of Object.entries(shape)) {
    out[k] = t === 'string' ? z.string() : t === 'number' ? z.number() : z.boolean();
  }
  return z.object(out);
}

export async function executeIntent(
  stagehand: Stagehand,
  sessionId: string,
  input: IntentInput,
  opts: { dataRoot: string },
): Promise<IntentResult | IntentError> {
  const t0 = Date.now();
  try {
    // V3 exposes the active page via context, not via a `stagehand.page` field.
    const page = stagehand.context.activePage();
    if (!page) {
      return {
        ok: false,
        intent: input.intent,
        error: 'no active page (did stagehand.init complete?)',
        durationMs: Date.now() - t0,
      };
    }

    let result: unknown;
    switch (input.intent) {
      case 'goto': {
        const p = GotoSchema.parse(input.payload);
        await page.goto(p.url, { waitUntil: 'domcontentloaded' });
        const title = await page.title();
        const url = page.url();
        result = { title, url };
        break;
      }
      case 'act': {
        const p = ActSchema.parse(input.payload);
        result = await stagehand.act(p.instruction);
        break;
      }
      case 'observe': {
        const p = ObserveSchema.parse(input.payload);
        result = await stagehand.observe(p.instruction);
        break;
      }
      case 'extract': {
        const p = ExtractSchema.parse(input.payload);
        const zSchema = buildExtractSchema(p.schema);
        result = await stagehand.extract(p.instruction, zSchema);
        break;
      }
      case 'screenshot': {
        ScreenshotSchema.parse(input.payload ?? {});
        // Falls through to the unconditional capture below — `result` stays
        // undefined so the response carries just `{ ok, screenshotUrl, ... }`.
        result = null;
        break;
      }
      default: {
        return {
          ok: false,
          intent: input.intent,
          error: `unknown intent: ${String(input.intent)}`,
          durationMs: Date.now() - t0,
        };
      }
    }

    // Capture every intent's resulting frame. We do this AFTER the action so the
    // screenshot reflects the post-state. If the screenshot itself fails we
    // still return ok — the intent succeeded, the audit artifact is best-effort.
    let screenshotUrl: string | undefined;
    try {
      const dir = join(opts.dataRoot, 'screenshots');
      await mkdir(dir, { recursive: true });
      const filename = `${sessionId}-${Date.now()}-${input.intent}.png`;
      const png = await page.screenshot({ type: 'png', fullPage: false });
      await writeFile(join(dir, filename), png);
      screenshotUrl = `/v1/static/screenshots/${filename}`;
    } catch (err) {
      logger.warn({ err, sessionId, intent: input.intent }, 'post-intent screenshot failed');
    }

    return {
      ok: true,
      intent: input.intent,
      result,
      ...(screenshotUrl !== undefined ? { screenshotUrl } : {}),
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    logger.warn({ err, sessionId, intent: input.intent }, 'intent execution failed');
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, intent: input.intent, error: msg, durationMs: Date.now() - t0 };
  }
}
