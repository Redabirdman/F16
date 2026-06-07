/**
 * Meta lead-form mapping + callback-time tests (M12) — pure, no DB.
 */
import { describe, it, expect } from 'vitest';
import {
  mapLeadgenToIntake,
  parsePreferredChannel,
  parsePreferredTime,
  computeCallbackDueAt,
} from '../../src/leads/meta-leadgen.js';
import type { LeadgenData } from '../../src/integrations/meta/client.js';

function leadgen(
  fieldData: { name: string; values: string[] }[],
  extra: Partial<LeadgenData> = {},
): LeadgenData {
  return {
    id: 'LEAD1',
    createdTime: '2026-06-07T10:00:00+0000',
    fieldData,
    adId: 'AD1',
    adName: 'Ad 1',
    adsetId: 'AS1',
    adsetName: 'Adset 1',
    campaignId: 'C1',
    campaignName: 'Campaign 1',
    formId: 'F1',
    platform: 'fb',
    raw: {},
    ...extra,
  };
}

/** Hour-of-day in Europe/Paris for an instant. */
function parisHour(d: Date): number {
  return (
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Paris',
        hour: '2-digit',
        hour12: false,
      }).format(d),
    ) % 24
  );
}

describe('parsePreferredChannel', () => {
  it('maps WhatsApp + call variants (FR/EN)', () => {
    expect(parsePreferredChannel('Par WhatsApp')).toBe('whatsapp');
    expect(parsePreferredChannel('WhatsApp message')).toBe('whatsapp');
    expect(parsePreferredChannel('Par appel téléphonique')).toBe('call');
    expect(parsePreferredChannel('Call me')).toBe('call');
    expect(parsePreferredChannel('Téléphone')).toBe('call');
    expect(parsePreferredChannel('autre chose')).toBeNull();
    expect(parsePreferredChannel(null)).toBeNull();
  });
});

describe('parsePreferredTime', () => {
  it('maps the four windows incl. accented "Après-midi"', () => {
    expect(parsePreferredTime('Contactez-moi maintenant')).toBe('maintenant');
    expect(parsePreferredTime('Now please')).toBe('maintenant');
    expect(parsePreferredTime('Le matin')).toBe('matin');
    expect(parsePreferredTime('Après-midi')).toBe('apres_midi');
    expect(parsePreferredTime('apres midi')).toBe('apres_midi');
    expect(parsePreferredTime('En soirée')).toBe('soir');
    expect(parsePreferredTime('whenever')).toBeNull();
  });
});

describe('mapLeadgenToIntake', () => {
  it('maps standard form keys + preferences + attribution', () => {
    const payload = mapLeadgenToIntake(
      leadgen([
        { name: 'full_name', values: ['Jean Dupont'] },
        { name: 'email', values: ['jean@example.com'] },
        { name: 'phone_number', values: ['+33612345678'] },
        { name: 'preferred_channel', values: ['Par appel téléphonique'] },
        { name: 'preferred_time', values: ['Après-midi'] },
      ]),
      { productLine: 'scooter' },
    );
    expect(payload.source).toBe('meta');
    expect(payload.fullName).toBe('Jean Dupont');
    expect(payload.email).toBe('jean@example.com');
    expect(payload.phone).toBe('+33612345678');
    expect(payload.preferredChannel).toBe('call');
    expect(payload.preferredTime).toBe('apres_midi');
    expect(payload.metaLeadgenId).toBe('LEAD1');
    expect(payload.sourceId).toBe('F1');
    expect(payload.productLine).toBe('scooter');
    expect(payload.attribution).toMatchObject({ campaignId: 'C1', adId: 'AD1', formId: 'F1' });
  });

  it('combines first_name + last_name and fuzzy-matches French question labels', () => {
    const payload = mapLeadgenToIntake(
      leadgen([
        { name: 'first_name', values: ['Marie'] },
        { name: 'last_name', values: ['Curie'] },
        { name: 'Adresse e-mail', values: ['marie@example.com'] },
        { name: 'Numéro de téléphone', values: ['0612345678'] },
        { name: 'Comment préférez-vous être contacté ?', values: ['Par WhatsApp'] },
        { name: 'Quel moment vous convient ?', values: ['Le matin'] },
      ]),
      { productLine: 'scooter' },
    );
    expect(payload.fullName).toBe('Marie Curie');
    expect(payload.email).toBe('marie@example.com');
    expect(payload.phone).toBe('0612345678');
    expect(payload.preferredChannel).toBe('whatsapp');
    expect(payload.preferredTime).toBe('matin');
  });

  it('tolerates a lead with no preference answers', () => {
    const payload = mapLeadgenToIntake(
      leadgen([{ name: 'phone_number', values: ['0612345678'] }]),
      { productLine: 'scooter' },
    );
    expect(payload.preferredChannel).toBeUndefined();
    expect(payload.preferredTime).toBeUndefined();
    expect(payload.phone).toBe('0612345678');
  });
});

describe('computeCallbackDueAt', () => {
  it('returns ~now for "maintenant"', () => {
    const now = new Date('2026-06-15T08:30:00Z');
    expect(computeCallbackDueAt('maintenant', now).getTime()).toBe(now.getTime());
  });

  it('schedules the next Europe/Paris slot start, today if still ahead', () => {
    // 06:00 UTC = 08:00 Paris (CEST). Matin slot 09:00 Paris is still ahead today.
    const now = new Date('2026-06-15T06:00:00Z');
    const due = computeCallbackDueAt('matin', now);
    expect(due.getTime()).toBeGreaterThan(now.getTime());
    expect(parisHour(due)).toBe(9);
  });

  it('rolls to tomorrow when the slot already passed today', () => {
    // 19:00 UTC = 21:00 Paris. Soir (18:00) already passed → tomorrow 18:00 Paris.
    const now = new Date('2026-06-15T19:00:00Z');
    const due = computeCallbackDueAt('soir', now);
    expect(due.getTime()).toBeGreaterThan(now.getTime());
    expect(parisHour(due)).toBe(18);
    // Strictly more than ~12h out (next day), proves the rollover.
    expect(due.getTime() - now.getTime()).toBeGreaterThan(12 * 3600_000);
  });
});
