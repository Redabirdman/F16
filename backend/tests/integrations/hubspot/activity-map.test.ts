/**
 * activity-map.test.ts — pure mapping tests (Phase 3 HubSpot activity timeline).
 *
 * No IO, no mocks. mapActivityToEngagement is a pure function — each test
 * provides an F16ActivityEvent and asserts the returned EngagementSpec shape.
 */
import { describe, it, expect } from 'vitest';
import {
  mapActivityToEngagement,
  type VoiceCallEndedEvent,
  type WhatsAppTurnEvent,
  type EngagementFollowupEvent,
  type HumanActionResolvedEvent,
} from '../../../src/integrations/hubspot/activity-map.js';

const TS = new Date('2024-06-10T10:00:00.000Z');

describe('mapActivityToEngagement — voice-call-ended', () => {
  it('returns a call spec with OUTBOUND direction, title, body, and duration', () => {
    const event: VoiceCallEndedEvent = {
      kind: 'voice-call-ended',
      customerId: 'cust-1',
      leadId: 'lead-1',
      durationMs: 90_000,
      transcriptSummary: 'Client wants scooter insurance, interested in monthly 29€',
      timestamp: TS,
    };
    const spec = mapActivityToEngagement(event);
    expect(spec.kind).toBe('call');
    if (spec.kind !== 'call') return;
    expect(spec.title).toBe('Appel sortant Assuryal');
    expect(spec.body).toContain('scooter insurance');
    expect(spec.durationMs).toBe(90_000);
    expect(spec.timestamp).toBe(TS);
  });

  it('uses fallback body when transcriptSummary is empty', () => {
    const event: VoiceCallEndedEvent = {
      kind: 'voice-call-ended',
      customerId: 'cust-1',
      transcriptSummary: '   ',
      timestamp: TS,
    };
    const spec = mapActivityToEngagement(event);
    expect(spec.kind).toBe('call');
    if (spec.kind !== 'call') return;
    expect(spec.body).toContain('pas de résumé');
  });

  it('omits durationMs when not provided', () => {
    const event: VoiceCallEndedEvent = {
      kind: 'voice-call-ended',
      customerId: 'cust-1',
      transcriptSummary: 'Test',
      timestamp: TS,
    };
    const spec = mapActivityToEngagement(event);
    expect(spec.kind).toBe('call');
    if (spec.kind !== 'call') return;
    expect(spec.durationMs).toBeUndefined();
  });
});

describe('mapActivityToEngagement — whatsapp-turn', () => {
  it('returns a communication spec with WHATSAPP channel and inbound prefix', () => {
    const event: WhatsAppTurnEvent = {
      kind: 'whatsapp-turn',
      customerId: 'cust-1',
      leadId: 'lead-1',
      body: 'Bonjour, je veux un devis',
      direction: 'inbound',
      timestamp: TS,
    };
    const spec = mapActivityToEngagement(event);
    expect(spec.kind).toBe('communication');
    if (spec.kind !== 'communication') return;
    expect(spec.channel).toBe('WHATSAPP');
    expect(spec.body).toContain('[Client]');
    expect(spec.body).toContain('Bonjour');
    expect(spec.timestamp).toBe(TS);
  });

  it('prefixes outbound turns with [Agent Assuryal]', () => {
    const event: WhatsAppTurnEvent = {
      kind: 'whatsapp-turn',
      customerId: 'cust-1',
      body: 'Voici votre devis: 29€/mois',
      direction: 'outbound',
      timestamp: TS,
    };
    const spec = mapActivityToEngagement(event);
    expect(spec.kind).toBe('communication');
    if (spec.kind !== 'communication') return;
    expect(spec.body).toContain('[Agent Assuryal]');
    expect(spec.body).toContain('29€/mois');
  });
});

describe('mapActivityToEngagement — engagement-followup', () => {
  it('step 0 → note with J+1 label + nudge text', () => {
    const event: EngagementFollowupEvent = {
      kind: 'engagement-followup',
      customerId: 'cust-1',
      leadId: 'lead-1',
      nudgeText: 'Bonjour, avez-vous des questions?',
      step: 0,
      timestamp: TS,
    };
    const spec = mapActivityToEngagement(event);
    expect(spec.kind).toBe('note');
    if (spec.kind !== 'note') return;
    expect(spec.body).toContain('J+1');
    expect(spec.body).toContain('24 h');
    expect(spec.body).toContain('Bonjour, avez-vous des questions?');
  });

  it('step 1 → note with J+3 label', () => {
    const event: EngagementFollowupEvent = {
      kind: 'engagement-followup',
      customerId: 'cust-1',
      nudgeText: 'Toujours disponible pour vous aider.',
      step: 1,
      timestamp: TS,
    };
    const spec = mapActivityToEngagement(event);
    expect(spec.kind).toBe('note');
    if (spec.kind !== 'note') return;
    expect(spec.body).toContain('J+3');
  });

  it('step 2 → note with J+7 escalation label', () => {
    const event: EngagementFollowupEvent = {
      kind: 'engagement-followup',
      customerId: 'cust-1',
      nudgeText: 'Désolé de vous déranger.',
      step: 2,
      timestamp: TS,
    };
    const spec = mapActivityToEngagement(event);
    expect(spec.kind).toBe('note');
    if (spec.kind !== 'note') return;
    expect(spec.body).toContain('J+7');
    expect(spec.body).toContain('dormant');
  });
});

describe('mapActivityToEngagement — human-action-resolved', () => {
  it('returns a note spec with action id + chosen option + source', () => {
    const event: HumanActionResolvedEvent = {
      kind: 'human-action-resolved',
      customerId: 'cust-1',
      leadId: 'lead-1',
      humanActionId: 'action-uuid-123',
      chosenOptionId: 'approve',
      source: 'admin',
      timestamp: TS,
    };
    const spec = mapActivityToEngagement(event);
    expect(spec.kind).toBe('note');
    if (spec.kind !== 'note') return;
    expect(spec.body).toContain('admin');
    expect(spec.body).toContain('approve');
    expect(spec.body).toContain('action-uuid-123');
    expect(spec.timestamp).toBe(TS);
  });

  it('source=whatsapp is reflected in the note body', () => {
    const event: HumanActionResolvedEvent = {
      kind: 'human-action-resolved',
      customerId: 'cust-1',
      humanActionId: 'action-2',
      chosenOptionId: 'revise',
      source: 'whatsapp',
      timestamp: TS,
    };
    const spec = mapActivityToEngagement(event);
    expect(spec.kind).toBe('note');
    if (spec.kind !== 'note') return;
    expect(spec.body).toContain('whatsapp');
  });
});
