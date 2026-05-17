/**
 * Channel abstraction types (design §8 / M4.T1).
 *
 * Every outbound surface (WhatsApp, voice, email, SMS) implements the
 * `ConversationChannel` interface. Agents NEVER talk to WAHA / Pipecat /
 * BillionMail / android-sms-gateway directly — they go through this seam so
 *   - the Sales Agent's channel-switching logic (§8.1, M4.T6) is the only place
 *     that picks which channel to send on,
 *   - each adapter (M4.T2 onwards) can evolve independently behind a stable
 *     contract,
 *   - tests can substitute a stub channel (see `tests/channels/registry.test.ts`)
 *     without booting any infra.
 *
 * Out of scope for M4.T1 (deferred):
 *   - The adapters themselves (WAHA → M4.T2, BillionMail → M4.T4,
 *     android-sms-gateway → M4.T5, voice/Pipecat → M10).
 *   - The switching policy (M4.T6) and conversation_turns write integration
 *     (M4.T7) — this file only defines the seam.
 *   - Inbound webhook normalization (M4.T3) — webhooks are received elsewhere
 *     and translated into agent inputs; they do not flow through this interface.
 */

/** Identifier for a channel implementation. */
export type ChannelId = 'whatsapp' | 'voice' | 'email' | 'sms';

/** Identifier for a contact in a given channel's namespace. */
export interface ContactRef {
  channel: ChannelId;
  /**
   * Channel-specific identity:
   *   whatsapp: E.164 phone, e.g. '+33612345678'
   *   voice:    E.164 phone
   *   email:    RFC-5322 address, e.g. 'marie@example.fr'
   *   sms:      E.164 phone
   */
  address: string;
  /** Optional display name to render in UIs/logs (never used for routing). */
  displayName?: string;
}

/**
 * Identifier for a specific message in a channel's namespace
 * (e.g. WAHA message id like `<phone>@c.us_<hash>`, an email Message-Id, an
 * SMS gateway message id). Used for thread/reply correlation.
 */
export interface MessageRef {
  channel: ChannelId;
  /** Channel-specific id (WAHA: `<phone>@c.us_<hash>`; email: Message-Id; SMS: gateway id). */
  externalId: string;
}

/**
 * Atomic piece of message content. Channels render each block according to
 * their capabilities; unsupported blocks degrade gracefully (e.g. SMS drops
 * markdown formatting; voice would TTS the text — but voice in M10).
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'markdown'; text: string }
  | { type: 'image'; url: string; caption?: string; sha256?: string }
  | { type: 'audio'; url: string; caption?: string; durationSec?: number }
  | { type: 'video'; url: string; caption?: string; durationSec?: number }
  | { type: 'document'; url: string; filename: string; mimeType: string; sha256?: string }
  | { type: 'location'; lat: number; lng: number; name?: string }
  /** Channel-specific interactive payload (WhatsApp list, voice DTMF prompt, etc.) — opaque per channel. */
  | { type: 'interactive'; spec: Record<string, unknown> };

/** Receipt returned after a successful send. */
export interface DeliveryReceipt {
  channel: ChannelId;
  /** Channel-specific id assigned by the provider. */
  externalId: string;
  /** When the provider acknowledged. */
  acceptedAt: Date;
  /** Raw provider response, retained for audit / debugging. */
  raw?: Record<string, unknown>;
}

/** Capability declaration by a channel implementation. */
export interface ChannelCapabilities {
  /** Supports interactive elements (buttons, lists, quick replies). */
  interactive: boolean;
  /** Audio in/out supported (voice channel = true; WhatsApp = false). */
  voice: boolean;
  /** Can carry file attachments (images, documents, etc.). */
  attachments: boolean;
  /** Renders markdown formatting (bold/italic/links). */
  markdown: boolean;
}

/** Send options handed to a channel's `send()` method. */
export interface SendOptions {
  to: ContactRef;
  body: readonly ContentBlock[];
  replyTo?: MessageRef;
  /** Optional correlation id for tracing/audit (lead_id, customer_id, etc.). */
  correlationId?: string;
  /** Optional: agent identity for outbound attribution (written to conversation_turns). */
  agentRole?: string;
  agentInstance?: string;
}

/** The contract every channel adapter implements. */
export interface ConversationChannel {
  readonly id: ChannelId;
  capabilities(): ChannelCapabilities;
  send(opts: SendOptions): Promise<DeliveryReceipt>;
  /**
   * Optional health probe — channels expose readiness so the admin
   * /integrations panel can dashboard them. Returns true if the channel is
   * ready to send; false if its upstream provider is down.
   */
  healthCheck?(): Promise<{ healthy: boolean; detail?: string }>;
}
