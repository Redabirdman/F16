/**
 * Creative Agent (M12 Phase 3) — barrel.
 *
 * The "Creative Expert": wraps the Nano Banana (OpenRouter) pipeline to
 * generate brand-locked Assuryal trottinette ad creatives per angle, and
 * registers them in the creatives library for the Ad Expert to draft with.
 */
export {
  generateAndRegisterCreative,
  type GenerateCreativeOptions,
  type CreativeFormat,
} from './creative.js';
export { generateImage, type GenerateImageOptions } from './generate.js';
export {
  buildCreativePrompt,
  angleCopy,
  ALL_ANGLES,
  BRAND,
  ASSURYAL_LOGO_PATH,
  type CreativeAngle,
  type AngleCopy,
} from './brand.js';
