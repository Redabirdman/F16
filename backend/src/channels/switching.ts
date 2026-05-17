/**
 * Channel switching policy (design §8.1, M4.T6).
 *
 * Pure-logic module: given the state of a conversation thread and the agent's
 * intent, returns the channel the agent should send on next. No I/O — the
 * caller (Sales Agent M6, Customer Engagement Agent M11) is responsible for
 * loading the {@link SwitchingContext} from the DB / `conversation_turns` /
 * recent send-result history and then invoking {@link pickChannel}.
 *
 * Rules (in priority order):
 *   1. Customer explicitly asked us to call them back ("appelez-moi",
 *      "call me back", …) → voice.
 *   2. Customer Engagement follow-up on a WhatsApp lead that's been silent
 *      > 24 h AND we've already sent at least one WhatsApp ping in that
 *      silence window → escalate to voice.
 *   3. `intent === 'callback'` → voice, unless we've already failed
 *      {@link VOICE_FAIL_THRESHOLD_BEFORE_SMS} times in a row → fall back
 *      to SMS.
 *   4. Default: stay sticky on whichever channel the customer last used.
 *
 * Out of scope (M4.T6):
 *   - actually scheduling the voice callback (M10 Pipecat integration)
 *   - persisting the switching decision (callers audit via `agent_messages`)
 *   - A/B variants of the thresholds (defer)
 */

import type { ChannelId } from './types.js';

/**
 * State the policy uses to decide. The caller assembles it from DB +
 * recent `conversation_turns`; the policy itself is pure.
 */
export interface SwitchingContext {
  /** The channel the customer's current thread started on. */
  startedOnChannel: ChannelId;
  /** The channel of the last MESSAGE in the thread (inbound or outbound). */
  lastChannel: ChannelId;
  /** Time the customer last sent us anything, or null if they never have. */
  lastInboundAt: Date | null;
  /** Most recent customer-message body (raw text) — used for keyword detection. */
  lastInboundContent: string | null;
  /** Successive voice-call failures since the most recent customer message. */
  consecutiveVoiceFails: number;
  /** Number of WhatsApp follow-ups already sent since `lastInboundAt`. */
  whatsappFollowupsSent: number;
  /** Now-time, injectable for tests. Default: `new Date()`. */
  now?: Date;
}

export interface PickChannelInput {
  /** What the agent intends to do — informs the policy. */
  intent: 'reply' | 'followup' | 'callback' | 'broadcast';
  /** The conversation context. */
  ctx: SwitchingContext;
}

export interface PickChannelOutput {
  channel: ChannelId;
  /** Short machine-readable code explaining which branch fired (audit-friendly). */
  reason:
    | 'customer-requested-callback'
    | 'whatsapp-silence-escalation'
    | 'voice-fail-fallback'
    | 'explicit-callback-intent'
    | 'sticky-last-channel';
}

/**
 * Regex for "call me (back)" style phrases, FR + EN. Deliberately conservative:
 * we require the imperative 2nd-person form ("appelez-moi", "rappelle-moi",
 * "call me", "phone me") OR an explicit politeness frame
 * ("pouvez-vous m'appeler", "merci de me rappeler", "please call me") so that
 * 3rd-person mentions like "je vais l'appeler demain" don't trigger a false
 * voice escalation.
 *
 * If we DO get a false positive, the worst case is we attempt a voice call,
 * which is observable (the customer either picks up or doesn't) — far better
 * than missing a genuine callback request.
 */
export const CALL_ME_REGEX =
  /(?:\b(?:appelez|appellez|appelle|rappelez|rappelle|t[ée]l[ée]phonez|t[ée]l[ée]phone)[\s-]?moi\b|\b(?:pouvez[-\s]vous|peux[-\s]tu|pourriez[-\s]vous|veuillez|merci\s+de|vous\s+pouvez)\s+(?:me\s+(?:rappeler|t[ée]l[ée]phoner|joindre)|m['’]appeler)\b|\b(?:please\s+)?call\s+me(?:\s+back)?\b|\bphone\s+me\b|\bring\s+me\b|\bgive\s+me\s+a\s+call\b|\bcould\s+you\s+call\s+me\b)/i;

/** Silence threshold (ms) before WhatsApp escalates to voice. Design §8.1. */
export const WHATSAPP_SILENCE_VOICE_ESCALATION_MS = 24 * 60 * 60 * 1000;

/** After this many consecutive failed voice calls, fall back to SMS. Design §8.1. */
export const VOICE_FAIL_THRESHOLD_BEFORE_SMS = 2;

/**
 * Detect whether a customer message is an explicit callback request.
 * Exported for callers that want to surface the signal in agent prompts
 * (e.g. the Sales Agent's "the customer asked you to call" hint).
 */
export function isCallMeRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  return CALL_ME_REGEX.test(text);
}

/**
 * Pick the channel an agent should send on next. Pure function — same input
 * always produces the same output.
 */
export function pickChannel(input: PickChannelInput): PickChannelOutput {
  const { intent, ctx } = input;
  const now = ctx.now ?? new Date();

  // Rule 1 — customer explicitly asked to be called back.
  // Only applies when we're replying to a fresh inbound; follow-ups and
  // broadcasts shouldn't reinterpret an old message.
  if (intent === 'reply' && isCallMeRequest(ctx.lastInboundContent)) {
    return { channel: 'voice', reason: 'customer-requested-callback' };
  }

  // Rule 2 — WhatsApp silence > 24h, and we've already sent at least one
  // follow-up ping on WhatsApp. Time to escalate to voice.
  if (intent === 'followup' && ctx.lastChannel === 'whatsapp' && ctx.lastInboundAt !== null) {
    const silenceMs = now.getTime() - ctx.lastInboundAt.getTime();
    if (silenceMs > WHATSAPP_SILENCE_VOICE_ESCALATION_MS && ctx.whatsappFollowupsSent >= 1) {
      return { channel: 'voice', reason: 'whatsapp-silence-escalation' };
    }
  }

  // Rule 3 — explicit callback intent maps to voice, with SMS fallback once
  // we've burned through too many failed attempts.
  if (intent === 'callback') {
    if (ctx.consecutiveVoiceFails >= VOICE_FAIL_THRESHOLD_BEFORE_SMS) {
      return { channel: 'sms', reason: 'voice-fail-fallback' };
    }
    return { channel: 'voice', reason: 'explicit-callback-intent' };
  }

  // Rule 4 (default) — stay sticky on the last channel.
  return { channel: ctx.lastChannel, reason: 'sticky-last-channel' };
}
