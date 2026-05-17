/**
 * Unit tests for the channel switching policy (M4.T6).
 *
 * Pure-logic tests — no infra, no DB, no clock dependency (the policy accepts
 * an injectable `now`).
 */
import { describe, it, expect } from 'vitest';
import {
  pickChannel,
  isCallMeRequest,
  CALL_ME_REGEX,
  WHATSAPP_SILENCE_VOICE_ESCALATION_MS,
  VOICE_FAIL_THRESHOLD_BEFORE_SMS,
  type SwitchingContext,
} from '../../src/channels/switching.js';

/** Freeze a now so threshold math is deterministic. */
const NOW = new Date('2026-05-16T12:00:00.000Z');

/** Helper: minimal context, override per-test. */
function ctx(overrides: Partial<SwitchingContext> = {}): SwitchingContext {
  return {
    startedOnChannel: 'whatsapp',
    lastChannel: 'whatsapp',
    lastInboundAt: null,
    lastInboundContent: null,
    consecutiveVoiceFails: 0,
    whatsappFollowupsSent: 0,
    now: NOW,
    ...overrides,
  };
}

describe('pickChannel — default (sticky-last-channel)', () => {
  it('reply with no special signal stays on whatsapp', () => {
    const out = pickChannel({
      intent: 'reply',
      ctx: ctx({ lastChannel: 'whatsapp', lastInboundContent: 'merci !' }),
    });
    expect(out).toEqual({ channel: 'whatsapp', reason: 'sticky-last-channel' });
  });

  it('reply with no special signal stays on email', () => {
    const out = pickChannel({
      intent: 'reply',
      ctx: ctx({ lastChannel: 'email', lastInboundContent: 'thanks for the info' }),
    });
    expect(out).toEqual({ channel: 'email', reason: 'sticky-last-channel' });
  });

  it('reply with null lastInboundContent stays sticky', () => {
    const out = pickChannel({
      intent: 'reply',
      ctx: ctx({ lastChannel: 'sms', lastInboundContent: null }),
    });
    expect(out).toEqual({ channel: 'sms', reason: 'sticky-last-channel' });
  });

  it("followup with null lastInboundAt stays sticky (can't compute silence)", () => {
    const out = pickChannel({
      intent: 'followup',
      ctx: ctx({
        lastChannel: 'whatsapp',
        lastInboundAt: null,
        whatsappFollowupsSent: 5,
      }),
    });
    expect(out).toEqual({ channel: 'whatsapp', reason: 'sticky-last-channel' });
  });
});

describe('pickChannel — Rule 1: customer-requested-callback', () => {
  const callMePhrases = [
    'appelez-moi',
    'appelez moi',
    'appellez-moi', // common misspelling
    'appelle-moi quand tu peux',
    'rappelez-moi svp',
    'rappelle-moi demain',
    'téléphonez-moi',
    'telephonez-moi',
    "Pouvez-vous m'appeler ?",
    'pouvez-vous me rappeler ?',
    'merci de me rappeler',
    'veuillez me rappeler dès que possible',
    'call me',
    'call me back',
    'please call me',
    'phone me',
    'give me a call',
    'could you call me later',
  ];

  for (const phrase of callMePhrases) {
    it(`detects "${phrase}" → voice/customer-requested-callback`, () => {
      const out = pickChannel({
        intent: 'reply',
        ctx: ctx({ lastChannel: 'whatsapp', lastInboundContent: phrase }),
      });
      expect(out).toEqual({ channel: 'voice', reason: 'customer-requested-callback' });
    });
  }

  it('does NOT trigger on 3rd-person mentions ("je vais l\'appeler demain")', () => {
    // Policy is conservative: requires imperative 2nd-person or politeness
    // frame ("pouvez-vous m'appeler") — bare "appeler" / "rappelle" alone
    // (talking about a third party) must NOT escalate.
    const phrases = [
      "je vais l'appeler demain",
      'il faut que je rappelle Paul',
      'je dois téléphoner à mon frère',
      'she will call me tomorrow', // 3rd-person subject + "call me" — currently matches
    ];
    // First three are clean; document the known 4th edge.
    expect(isCallMeRequest(phrases[0])).toBe(false);
    expect(isCallMeRequest(phrases[1])).toBe(false);
    expect(isCallMeRequest(phrases[2])).toBe(false);
    // "she will call me" — naive cheap tightening still matches "call me".
    // Documented as conservative false-positive: customer either picks up or
    // doesn't — safer than missing a genuine request.
    expect(isCallMeRequest(phrases[3])).toBe(true);
  });

  it('only fires on intent=reply (not followup or broadcast)', () => {
    const out = pickChannel({
      intent: 'followup',
      ctx: ctx({
        lastChannel: 'whatsapp',
        lastInboundContent: 'appelez-moi',
        lastInboundAt: new Date(NOW.getTime() - 60_000),
      }),
    });
    expect(out.reason).not.toBe('customer-requested-callback');
  });
});

describe('pickChannel — Rule 2: whatsapp-silence-escalation', () => {
  it('does NOT escalate if customer messaged 1h ago', () => {
    const oneHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000);
    const out = pickChannel({
      intent: 'followup',
      ctx: ctx({
        lastChannel: 'whatsapp',
        lastInboundAt: oneHourAgo,
        whatsappFollowupsSent: 3, // even with many pings, recent silence ≠ escalation
      }),
    });
    expect(out).toEqual({ channel: 'whatsapp', reason: 'sticky-last-channel' });
  });

  it('escalates after 24h + 1 follow-up sent', () => {
    const twentyFiveHoursAgo = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const out = pickChannel({
      intent: 'followup',
      ctx: ctx({
        lastChannel: 'whatsapp',
        lastInboundAt: twentyFiveHoursAgo,
        whatsappFollowupsSent: 1,
      }),
    });
    expect(out).toEqual({ channel: 'voice', reason: 'whatsapp-silence-escalation' });
  });

  it('does NOT yet escalate after 24h with 0 follow-ups (still on first ping)', () => {
    const twentyFiveHoursAgo = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const out = pickChannel({
      intent: 'followup',
      ctx: ctx({
        lastChannel: 'whatsapp',
        lastInboundAt: twentyFiveHoursAgo,
        whatsappFollowupsSent: 0,
      }),
    });
    expect(out).toEqual({ channel: 'whatsapp', reason: 'sticky-last-channel' });
  });

  it('does NOT escalate if last channel is not whatsapp', () => {
    const twentyFiveHoursAgo = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const out = pickChannel({
      intent: 'followup',
      ctx: ctx({
        lastChannel: 'email',
        lastInboundAt: twentyFiveHoursAgo,
        whatsappFollowupsSent: 5,
      }),
    });
    expect(out).toEqual({ channel: 'email', reason: 'sticky-last-channel' });
  });
});

describe('pickChannel — Rule 3: callback intent', () => {
  it('intent=callback with 0 fails → voice/explicit-callback-intent', () => {
    const out = pickChannel({
      intent: 'callback',
      ctx: ctx({ lastChannel: 'whatsapp', consecutiveVoiceFails: 0 }),
    });
    expect(out).toEqual({ channel: 'voice', reason: 'explicit-callback-intent' });
  });

  it('intent=callback with 1 fail (below threshold) → voice (retry)', () => {
    const out = pickChannel({
      intent: 'callback',
      ctx: ctx({ lastChannel: 'whatsapp', consecutiveVoiceFails: 1 }),
    });
    expect(out).toEqual({ channel: 'voice', reason: 'explicit-callback-intent' });
  });

  it('intent=callback with 2 fails → sms/voice-fail-fallback', () => {
    const out = pickChannel({
      intent: 'callback',
      ctx: ctx({ lastChannel: 'whatsapp', consecutiveVoiceFails: 2 }),
    });
    expect(out).toEqual({ channel: 'sms', reason: 'voice-fail-fallback' });
  });

  it('intent=callback with 3 fails → sms/voice-fail-fallback', () => {
    const out = pickChannel({
      intent: 'callback',
      ctx: ctx({ lastChannel: 'email', consecutiveVoiceFails: 3 }),
    });
    expect(out).toEqual({ channel: 'sms', reason: 'voice-fail-fallback' });
  });
});

describe('pickChannel — Rule 4: broadcast', () => {
  it('broadcast always rides the last channel', () => {
    const out = pickChannel({
      intent: 'broadcast',
      ctx: ctx({ lastChannel: 'whatsapp', lastInboundContent: 'appelez-moi' }),
    });
    expect(out).toEqual({ channel: 'whatsapp', reason: 'sticky-last-channel' });
  });
});

describe('pickChannel — injectable now', () => {
  it('uses ctx.now for threshold math (not real wall-clock)', () => {
    // lastInboundAt is 25h before NOW; but if we pass a `now` only 1h after
    // lastInboundAt, escalation must NOT fire.
    const lastInboundAt = new Date('2026-05-15T11:00:00.000Z');
    const fakeNow = new Date('2026-05-15T12:00:00.000Z'); // +1h
    const out = pickChannel({
      intent: 'followup',
      ctx: {
        startedOnChannel: 'whatsapp',
        lastChannel: 'whatsapp',
        lastInboundAt,
        lastInboundContent: null,
        consecutiveVoiceFails: 0,
        whatsappFollowupsSent: 1,
        now: fakeNow,
      },
    });
    expect(out).toEqual({ channel: 'whatsapp', reason: 'sticky-last-channel' });
  });
});

describe('exported constants', () => {
  it('WHATSAPP_SILENCE_VOICE_ESCALATION_MS = 24h', () => {
    expect(WHATSAPP_SILENCE_VOICE_ESCALATION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('VOICE_FAIL_THRESHOLD_BEFORE_SMS = 2', () => {
    expect(VOICE_FAIL_THRESHOLD_BEFORE_SMS).toBe(2);
  });

  it('CALL_ME_REGEX is exported and case-insensitive', () => {
    expect(CALL_ME_REGEX.flags).toContain('i');
    expect(CALL_ME_REGEX.test('APPELEZ-MOI')).toBe(true);
  });
});
