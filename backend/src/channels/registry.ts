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
 * Test-only escape hatch — clears the registry so a test starts from a known
 * empty state. Not part of the public API; production code never calls this.
 */
export function __resetChannelsForTests(): void {
  _channels.clear();
}
