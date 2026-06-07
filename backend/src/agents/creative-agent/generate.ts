/**
 * Nano Banana Pro image generation (M12 Phase 3).
 *
 * Node port of the AW Assur `image_or.py` pipeline: generates a brand-locked
 * ad creative via OpenRouter's `google/gemini-3-pro-image-preview`, passing the
 * Assuryal logo as a reference image and the brand prompt as text. Returns the
 * rendered PNG bytes.
 *
 * The model occasionally returns the image under `message.images[]` and
 * occasionally inline in `message.content[]` — we handle both. Generation is
 * slow (30-90s); the caller should allow a generous timeout.
 */
import { readFile } from 'node:fs/promises';
import { logger } from '../../logger.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'google/gemini-3-pro-image-preview';
const DEFAULT_TIMEOUT_MS = 180_000;

export interface GenerateImageOptions {
  /** Full brand prompt (scene + anchors). Aspect instruction is prepended. */
  prompt: string;
  /** Absolute path to the reference logo PNG. */
  logoPath: string;
  /** 'square' (1:1) | 'portrait' (4:5/9:16) | 'landscape' (16:9). */
  aspect?: 'square' | 'portrait' | 'landscape';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const ASPECT_INSTRUCTION: Record<NonNullable<GenerateImageOptions['aspect']>, string> = {
  square: 'Generate a square image (1:1 aspect ratio, 1080x1080px).',
  portrait: 'Generate a portrait/tall image (4:5 aspect ratio, 1080x1350px).',
  landscape: 'Generate a landscape/wide image (16:9 aspect ratio, 1920x1080px).',
};

/** Pull a base64 data URL out of an OpenRouter image-gen response. */
function extractImageDataUrl(json: unknown): string | null {
  const j = json as {
    choices?: Array<{
      message?: {
        images?: Array<{ image_url?: { url?: string } }>;
        content?: unknown;
      };
    }>;
  };
  const msg = j.choices?.[0]?.message;
  const fromImages = msg?.images?.[0]?.image_url?.url;
  if (typeof fromImages === 'string' && fromImages.startsWith('data:')) return fromImages;
  // Fallback: scan content array for an image_url part.
  if (Array.isArray(msg?.content)) {
    for (const part of msg.content as Array<{ type?: string; image_url?: { url?: string } }>) {
      const url = part?.image_url?.url;
      if (typeof url === 'string' && url.startsWith('data:')) return url;
    }
  }
  return null;
}

export async function generateImage(opts: GenerateImageOptions): Promise<Buffer> {
  const apiKey = opts.apiKey ?? process.env['OPENROUTER_API_KEY'];
  if (!apiKey) throw new Error('generateImage: OPENROUTER_API_KEY is required');
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = opts.model ?? DEFAULT_MODEL;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const logoBytes = await readFile(opts.logoPath);
  const logoDataUrl = `data:image/png;base64,${logoBytes.toString('base64')}`;
  const aspectLine = ASPECT_INSTRUCTION[opts.aspect ?? 'square'];
  const text = `${aspectLine}\n\n${opts.prompt}`;

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: logoDataUrl } },
          { type: 'text', text },
        ],
      },
    ],
    modalities: ['image'],
  };

  const t0 = Date.now();
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://assuryalconseil.fr',
      'X-Title': 'F16 Assuryal Ad Creatives',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`generateImage: OpenRouter ${res.status} — ${errText}`);
  }

  const json = await res.json();
  const dataUrl = extractImageDataUrl(json);
  if (!dataUrl) {
    throw new Error('generateImage: no image in OpenRouter response');
  }
  const base64 = dataUrl.split(',', 2)[1] ?? '';
  const bytes = Buffer.from(base64, 'base64');
  logger.info(
    { model, bytes: bytes.length, durationMs: Date.now() - t0 },
    'creative: image generated',
  );
  return bytes;
}
