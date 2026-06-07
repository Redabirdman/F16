/**
 * Assuryal creative brand spec + per-angle prompt builder (M12 Phase 3).
 *
 * Reuses the AW Assur Conseil validated visual system (navy #150D3F + violet
 * #5E3FDE, fixed layout: top logo, headline card, shield, price block, CTA
 * pill, navy help bar) rebranded to Assuryal, scoped to the TROTTINETTE / NVEI
 * line — the only live auto-quote product (M9). Scooter overrides: price 5€,
 * CTA « Profitez de l'offre », NO phone number in the help bar.
 *
 * Each angle carries the on-image hook/sub (brand-locked typography embedded in
 * the scene) AND the Meta ad copy (primary text / headline / description) used
 * when the ad is launched.
 */
export const ASSURYAL_LOGO_PATH =
  'C:\\Users\\Rlefr\\Desktop\\Platforms Factory\\Assuryal\\AW Assur Conseil\\Assuryal conseil\\Logo Assuryal conseil\\Logo.png';

export const BRAND = {
  navy: '#150D3F',
  violet: '#5E3FDE',
  price: '5€',
  cta: "→ Profitez de l'offre",
  helpBar: "Besoin d'aide ou d'assistance ?",
} as const;

export type CreativeAngle = 'fear' | 'legal' | 'value' | 'speed' | 'social';
export const ALL_ANGLES: CreativeAngle[] = ['fear', 'legal', 'value', 'speed', 'social'];

interface AngleSpec {
  /** On-image headline (embedded in the creative). */
  hook: string;
  /** On-image sub-line. */
  sub: string;
  /** Photoreal scene description for the generator. */
  scene: string;
  /** Meta ad copy. */
  primaryText: string;
  headline: string;
  description: string;
}

const ANGLES: Record<CreativeAngle, AngleSpec> = {
  fear: {
    hook: 'VOL OU ACCIDENT ?',
    sub: 'Vous êtes couvert.',
    scene:
      'A photoreal cinematic shot of a 30-year-old Parisian standing protectively next to a modern electric scooter (trottinette électrique) on a city sidewalk at golden hour, holding the handlebar, a faint concerned-but-reassured expression. The e-scooter is the clear subject, sharp and prominent.',
    primaryText:
      'Vol, casse, accident… votre trottinette électrique est exposée chaque jour. Assurez-la dès 5€/mois et roulez l’esprit tranquille. 🛴',
    headline: 'Assurez votre trottinette',
    description: 'Devis en 2 minutes, 100% en ligne',
  },
  legal: {
    hook: 'ASSURANCE OBLIGATOIRE',
    sub: 'Roulez en règle.',
    scene:
      'A photoreal shot of a person on an electric scooter stopped at a Parisian crosswalk next to a subtle official-looking street sign, clean daylight, responsible and calm mood. The e-scooter is centred and unmistakable as the subject.',
    primaryText:
      'Saviez-vous que l’assurance responsabilité civile est obligatoire pour votre trottinette électrique ? Mettez-vous en règle dès 5€/mois. 🛴',
    headline: 'En règle dès 5€/mois',
    description: 'Responsabilité civile incluse',
  },
  value: {
    hook: 'DÈS 5€/MOIS',
    sub: 'Protégez votre trottinette.',
    scene:
      'A bright, clean photoreal hero shot of a sleek electric scooter (trottinette) with a happy young commuter beside it in a sunlit modern urban setting, optimistic and premium feel. The e-scooter dominates the frame.',
    primaryText:
      'Une assurance trottinette complète pour le prix d’un café : dès 5€/mois. Vol, dommages, responsabilité civile. 🛴',
    headline: 'À partir de 5€/mois',
    description: 'Protection complète, petit prix',
  },
  speed: {
    hook: 'ASSURÉ EN 2 MIN',
    sub: 'Souscription 100% en ligne.',
    scene:
      'A dynamic photoreal shot of a commuter riding an electric scooter through a bright Parisian street with light motion blur in the background, sense of speed and ease. The moving e-scooter is the sharp, central subject.',
    primaryText:
      'Assurez votre trottinette en 2 minutes, sans paperasse, 100% en ligne. Dès 5€/mois. 🛴',
    headline: 'Assuré en 2 minutes',
    description: 'Sans paperasse, tout en ligne',
  },
  social: {
    hook: 'REJOIGNEZ-LES',
    sub: 'Déjà des milliers d’assurés.',
    scene:
      'A warm photoreal lifestyle shot of two or three diverse young Parisians with their electric scooters together in a lively city square, friendly community feel, golden light. The e-scooters are clearly the focal subject.',
    primaryText:
      'Des milliers de Français protègent déjà leur trottinette avec Assuryal. Rejoignez-les dès 5€/mois. 🛴',
    headline: 'Déjà des milliers d’assurés',
    description: 'Rejoignez la communauté Assuryal',
  },
};

export interface AngleCopy {
  primaryText: string;
  headline: string;
  description: string;
}

export function angleCopy(angle: CreativeAngle): AngleCopy {
  const a = ANGLES[angle];
  return { primaryText: a.primaryText, headline: a.headline, description: a.description };
}

const BRAND_ANCHORS = (hook: string, sub: string): string =>
  `BRAND ANCHOR LAYOUT (Assuryal — French electric-scooter / trottinette insurance):
(A) Small white ASSURYAL logo at the very TOP of the image (~7% of frame height), sitting over the photo — use the provided reference image for the logo, do not redraw it.
(B) A rounded-rectangle HEADLINE CARD filled brand violet-purple, containing a bold white headline reading EXACTLY '${hook}' and below it a smaller white sub-line reading EXACTLY '${sub}'.
(C) A small violet-purple shield icon with a white check mark (trust signal).
(D) A compact white rounded PRICE BLOCK with visible text EXACTLY: 'À partir de' (small grey), then '${BRAND.price}' (large bold violet-purple), then '/mois' (small grey).
(E) A compact deep-navy pill CTA button with white text EXACTLY '${BRAND.cta}'.
(F) A full-width deep-navy bar at the very bottom with a small white headset icon and white text EXACTLY '${BRAND.helpBar}' — NO phone number anywhere in the image.
Brand violet-purple appears ONLY on the headline card, the price digits, the shield, and the CTA accent — NEVER as a large background area. Do NOT render any hex code or colour code as visible text. Render all French text with perfect accents and no spelling artefacts. Style: premium editorial commercial photography for a French insurance brand, scroll-stopping; the electric scooter is always unmistakably the subject.`;

/** Build the full Nano Banana prompt for an angle. */
export function buildCreativePrompt(angle: CreativeAngle): string {
  const a = ANGLES[angle];
  return `Ad creative for Assuryal (French electric-scooter / trottinette insurance).

SCENE: ${a.scene}

${BRAND_ANCHORS(a.hook, a.sub)}`;
}
