/**
 * Shared dependency surface the extracted QUOTE.* / SUBSCRIPTION.* handlers
 * need from the SalesAgent instance. The agent builds one of these and passes
 * it to the free handler functions, so the handlers stay decoupled from the
 * class internals (and remain trivially unit-testable with a fake ctx).
 */
import type { Database } from '../../../db/index.js';
import type { ChannelId, ContactRef } from '../../../channels/types.js';
import type { AgentMessageEnvelope } from '../../../messaging/dispatcher.js';
import type { customers, leads } from '../../../db/schema/index.js';

export interface SalesHandlerCtx {
  readonly db: Database;
  readonly role: string;
  readonly instanceId: string;
  /**
   * Resolve `(lead, customer, ContactRef)` for the given lead+channel.
   * `contactRef` is null when the customer has no address for the channel.
   */
  resolveCustomerAndContact(
    leadId: string,
    channel: ChannelId,
  ): Promise<{
    customer: typeof customers.$inferSelect;
    lead: typeof leads.$inferSelect;
    contactRef: ContactRef | null;
  }>;
  /** Resolve the leadId for the current envelope (meta.leadId → correlationId). */
  leadIdFromEnvelope(envelope: AgentMessageEnvelope): string | null;
}
