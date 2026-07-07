/**
 * Channel registry (design §8 / M4.T1).
 *
 * Process-wide Map from `ChannelId` → `ConversationChannel` implementation.
 * Adapters self-register at boot (e.g. the WAHA adapter in M4.T2 will call
 * `registerChannel(new WahaChannel(...))` from the wiring layer). Lookups go
 * through `getChannel` (throws on miss — agents must not silently swallow a
 * missing channel) or `tryGetChannel` (for optional checks like the
 * /integrations panel).
 *
 * Why a module-level Map rather than DI:
 *   - Keeps adapter wiring out of every call site (a tool just calls
 *     `getChannel('whatsapp').send(...)` — it doesn't need a container).
 *   - Mirrors `src/tools/registry.ts` so the patterns rhyme.
 *   - Tests reset between cases with `__resetChannelsForTests()`.
 *
 * Duplicate registration throws — accidental shadowing (two files registering
 * the same channel) is loud rather than silent.
 */
import type { ChannelId, ConversationChannel } from './types.js';

// Internal — never expose the Map; force all reads through the helpers below.
const _channels = new Map<ChannelId, ConversationChannel>();

/**
 * Register a channel adapter. Throws on duplicate id so two competing
 * registrations can't silently shadow each other.
 */
export function registerChannel(channel: ConversationChannel): void {
  if (_channels.has(channel.id)) {
    throw new Error(`Channel ${channel.id} already registered`);
  }
  _channels.set(channel.id, channel);
}

/**
 * Look up a channel by id. Throws when none is registered — agents calling
 * this expect the channel to exist; a missing channel is a configuration bug,
 * not a recoverable runtime condition.
 */
export function getChannel(id: ChannelId): ConversationChannel {
  const c = _channels.get(id);
  if (!c) throw new Error(`No channel registered for id ${id}`);
  return c;
}

/**
 * Look up a channel by id, returning undefined if unknown. Use this when the
 * caller wants to decide what to do on miss (e.g. the /integrations panel
 * listing which channels are configured).
 */
export function tryGetChannel(id: ChannelId): ConversationChannel | undefined {
  return _channels.get(id);
}

/** List all registered channels (iteration order is insertion order). */
export function listChannels(): ConversationChannel[] {
  return [..._channels.values()];
}

/**
 * Pick a channel we can actually SEND on. Conversation turns record every
 * channel a lead touched — including 'voice', which has no send adapter
 * (calls are placed by the voice-operator, not sent like messages). Blindly
 * reusing the last turn's channel made QUOTE.* handlers and engagement
 * nudges hit getChannel('voice') → throw → BullMQ retries → DLQ, and the
 * customer never received the message (2026-07-04 audit).
 *
 * Rule: the candidate wins when a send adapter is registered for it;
 * otherwise fall back to WhatsApp (the Assuryal funnel is WhatsApp-first).
 * When the registry is empty (unit tests that stub sendViaChannel), the
 * candidate passes through unchanged so channel-selection tests keep their
 * inputs.
 */
export function coerceSendableChannel(candidate: ChannelId | undefined): ChannelId {
  if (_channels.size === 0) return candidate ?? 'whatsapp';
  if (candidate && _channels.has(candidate)) return candidate;
  return 'whatsapp';
}

/**
 * Pick the channel the CUSTOMER actually lives on: their most recent INBOUND
 * turn's channel, falling back to the most recent turn of any direction.
 *
 * Why not just `turns[0].channel`: our own multi-channel sends write turns
 * too — a devis PDF delivery writes a WhatsApp turn AND an email turn, so the
 * "latest turn" flips to email and every subsequent message (quote-ready
 * notice, approved drafts, continuation acks) silently followed to email
 * while the conversation lived on WhatsApp (live 2026-07-07, Achraf's run —
 * Ridaa approved a message and it arrived in Gmail). The customer's own last
 * message is the truth about where they're talking to us.
 *
 * `turns` must be most-recent-first (the shape every `listTurns` caller has).
 */
export function preferInboundChannel(
  turns: ReadonlyArray<{ direction: string; channel: string }>,
): ChannelId {
  const lastInbound = turns.find((t) => t.direction === 'inbound');
  return coerceSendableChannel(
    (lastInbound?.channel ?? turns[0]?.channel) as ChannelId | undefined,
  );
}

/**
 * Test-only escape hatch — clears the registry so a test starts from a known
 * empty state. Not part of the public API; production code never calls this.
 */
export function __resetChannelsForTests(): void {
  _channels.clear();
}
