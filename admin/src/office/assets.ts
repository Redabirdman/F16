// admin/src/office/assets.ts
// Maps (role, spriteState) → texture URL. In PLACEHOLDER_MODE the scene draws
// programmatic shapes instead of loading PNGs (P1–P3). P4 flips the flag and
// drops the warm Nano-Banana art into admin/public/office/.
import type { SpriteState } from './types';

/** Flip to false in P4 once the warm art lands in public/office/. */
export const PLACEHOLDER_MODE = true;

/** Accent color per role for placeholder sprites + side-panel chips. */
export const ROLE_COLOR: Record<string, number> = {
  'sales-agent': 0x38bdf8,
  'voice-operator': 0xa78bfa,
  'maxance-operator': 0xfbbf24,
  supervisor: 0xf87171,
  'human-router': 0x34d399,
  'engagement-agent': 0x5eead4,
  'ads-manager-agent': 0xfb923c,
  'creative-agent': 0xf472b6,
  'lead-scorer': 0x94a3b8,
};

export function roleColor(role: string): number {
  return ROLE_COLOR[role] ?? 0x94a3b8;
}

/** Public URL for a character texture. Only used when PLACEHOLDER_MODE=false. */
export function textureUrl(role: string, state: SpriteState): string {
  const pose = state === 'walking' || state === 'talking' || state === 'working' ? state : 'idle';
  return `/office/char-${role}-${pose}.png`;
}

/** Public URLs for environment textures (P4). */
export const ENV_TEXTURES = {
  floorTile: '/office/floor-tile.png',
  desk: '/office/prop-desk.png',
  plant: '/office/prop-plant.png',
  maxanceBooth: '/office/prop-maxance.png',
  door: '/office/prop-door.png',
} as const;
