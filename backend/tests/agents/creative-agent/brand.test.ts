/**
 * Creative Agent brand/prompt tests (M12 Phase 3) — pure, no network/DB.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCreativePrompt,
  angleCopy,
  ALL_ANGLES,
  BRAND,
} from '../../../src/agents/creative-agent/brand.js';

describe('buildCreativePrompt', () => {
  it('embeds the angle hook + brand anchors for every angle', () => {
    for (const angle of ALL_ANGLES) {
      const p = buildCreativePrompt(angle);
      expect(p).toContain('Assuryal');
      expect(p).toContain('ASSURYAL logo'); // logo anchor
      expect(p).toContain(BRAND.price); // 5€
      expect(p).toContain(BRAND.cta); // Profitez de l'offre
      expect(p).toContain('NO phone number'); // scooter override
      expect(p.length).toBeGreaterThan(400);
    }
  });

  it('uses the fear hook for the fear angle', () => {
    expect(buildCreativePrompt('fear')).toContain('VOL OU ACCIDENT ?');
  });
});

describe('angleCopy', () => {
  it('returns French ad copy with primary/headline/description per angle', () => {
    for (const angle of ALL_ANGLES) {
      const c = angleCopy(angle);
      expect(c.primaryText.length).toBeGreaterThan(10);
      expect(c.headline.length).toBeGreaterThan(3);
      expect(c.description.length).toBeGreaterThan(3);
    }
    expect(angleCopy('value').headline).toContain('5€');
  });
});
