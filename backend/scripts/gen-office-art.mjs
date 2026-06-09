/**
 * One-off generator for the /office isometric art (M14.T11 Phase 4).
 *
 * Reuses F16's proven OpenRouter Nano-Banana path (google/gemini-3-pro-image-preview,
 * the same model creative-agent/generate.ts uses) but TEXT-ONLY (no brand logo
 * reference — these are generic game sprites, not branded creatives).
 *
 * Gemini image output is opaque, so every prompt renders the subject on a solid
 * chroma-key green field; key-office-art.py removes it to transparency afterward.
 *
 * Run from backend/ with the OpenRouter key loaded (never printed):
 *   node --env-file=.env scripts/gen-office-art.mjs            # all assets
 *   node --env-file=.env scripts/gen-office-art.mjs sales-agent supervisor   # subset
 *
 * Writes raw PNGs to ../admin/public/office/_raw/<name>.png
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(__dirname, '../../admin/public/office/_raw');

const BASE_URL = 'https://openrouter.ai/api/v1';
const MODEL = 'google/gemini-3-pro-image-preview';
const TIMEOUT_MS = 180_000;

// Shared style directive appended to every prompt for coherence.
const STYLE = [
  'Warm, friendly isometric office video-game art, Habbo Hotel meets Stardew Valley aesthetic.',
  'Soft warm ambient lighting, clean rounded chunky vector shading, cozy vibrant but tasteful colors.',
  'Single subject, centered, full body, 3/4 top-down isometric viewing angle.',
  'The subject stands on NOTHING — render it floating, no ground, no shadow.',
  'CRITICAL: the entire background is one perfectly uniform flat chroma-key green color (pure #00b140), edge to edge, with NO gradient, NO props, NO scenery behind the subject.',
  'High quality game asset.',
].join(' ');

/** role/asset → subject description. */
const ASSETS = {
  // --- 9 character sprites ---
  'char-sales-agent': 'a friendly young insurance salesperson wearing a telephone headset and a smart-casual blue blazer, smiling, holding a small tablet',
  'char-voice-operator': 'a friendly call-centre voice agent wearing a large headset with a boom microphone, mid-conversation gesture, purple-accented outfit',
  'char-maxance-operator': 'a focused technician seated-style posture working at a computer terminal, amber/yellow outfit, operator vibe',
  'char-supervisor': 'a confident team manager in a smart red-accented blazer holding a clipboard, supervisory posture',
  'char-human-router': 'a tidy office messenger/secretary holding a stack of papers and a pen, green-accented outfit, helpful expression',
  'char-engagement-agent': 'a cheerful customer-care person waving warmly with a small chat speech-bubble, teal-accented outfit',
  'char-ads-manager-agent': 'an energetic marketer holding a megaphone, orange-accented outfit, dynamic confident pose',
  'char-creative-agent': 'a creative designer holding an artist palette and a stylus tablet, pink-accented outfit, artistic flair',
  'char-lead-scorer': 'a sharp data analyst holding a magnifying glass over a small bar chart, grey/slate outfit, studious look',
  // --- environment props (these can keep a tiny base since they sit ON the floor) ---
  'prop-desk': 'a single cute isometric office desk with a computer monitor and keyboard, warm wood and white',
  'prop-plant': 'a single cute isometric potted office plant, lush green leaves in a terracotta pot',
  'prop-maxance': 'a single cute isometric computer workstation booth/kiosk with a glowing screen, techy but cozy',
  'prop-door': 'a single cute isometric office glass entrance door in a frame, warm welcoming',
  // floor tile is generated separately (no chroma key needed — it tiles)
  'floor-tile': 'a single seamless isometric diamond-shaped warm light-wood floor tile, top-down isometric, subtle plank texture',
};

function extractImageDataUrl(json) {
  const msg = json?.choices?.[0]?.message;
  const fromImages = msg?.images?.[0]?.image_url?.url;
  if (typeof fromImages === 'string' && fromImages.startsWith('data:')) return fromImages;
  if (Array.isArray(msg?.content)) {
    for (const part of msg.content) {
      const url = part?.image_url?.url;
      if (typeof url === 'string' && url.startsWith('data:')) return url;
    }
  }
  return null;
}

async function genOne(name, subject) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set (run with node --env-file=.env)');
  const isFloor = name === 'floor-tile';
  const text = isFloor
    ? `A single seamless isometric diamond floor tile. ${subject}. Square 1:1 image. Plain, no characters, no props.`
    : `Generate a square 1:1 image of ${subject}. ${STYLE}`;

  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    modalities: ['image'],
  };
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://assuryalconseil.fr',
      'X-Title': 'F16 Office Sprites',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${name}: OpenRouter ${res.status} — ${err}`);
  }
  const json = await res.json();
  const dataUrl = extractImageDataUrl(json);
  if (!dataUrl) throw new Error(`${name}: no image in response`);
  const b64 = dataUrl.split(',', 2)[1] ?? '';
  const bytes = Buffer.from(b64, 'base64');
  const out = resolve(RAW_DIR, `${name}.png`);
  await writeFile(out, bytes);
  console.log(`ok  ${name}  (${(bytes.length / 1024).toFixed(0)} KB, ${Date.now() - t0}ms)`);
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  const argv = process.argv.slice(2);
  const names = argv.length > 0 ? argv : Object.keys(ASSETS);
  for (const name of names) {
    const subject = ASSETS[name];
    if (!subject) {
      console.error(`skip ${name}: unknown asset`);
      continue;
    }
    try {
      await genOne(name, subject);
    } catch (e) {
      console.error(`ERR ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

await main();
