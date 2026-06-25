/**
 * Transactional purge of one contact (by phone) — the customer row plus every
 * row that carries their memory: leads, quotes, conversation_turns, and the
 * human_actions correlated to those ids.
 *
 * Used by the admin "Simulation" reset so a remote tester (Achraf) can wipe his
 * own contact and re-run a scenario from scratch. Scoped to a single phone —
 * there is no bulk-purge path.
 *
 * Idempotent: no matching customer (or an unnormalizable phone) returns all
 * zeros without touching the DB. Single transaction with an explicit delete
 * order so a partial failure rolls back cleanly.
 *
 * PII discipline: logs ids/counts only, never decrypted values. The lookup goes
 * through the customers repo's phone *hash* — the plaintext is never read back.
 */
import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { customers, leads, quotes, conversationTurns, humanActions } from '../db/schema/index.js';
import { getCustomerByPhone } from '../db/repositories/customers.js';
import { normalizePhone } from './intake.js';
import { logger } from '../logger.js';

export interface PurgeResult {
  customer: number;
  leads: number;
  quotes: number;
  conversations: number;
  humanActions: number;
}

const EMPTY: PurgeResult = {
  customer: 0,
  leads: 0,
  quotes: 0,
  conversations: 0,
  humanActions: 0,
};

export async function purgeContact(db: Database, input: { phone?: string }): Promise<PurgeResult> {
  const e164 = normalizePhone(input.phone);
  if (!e164) return { ...EMPTY };

  const existing = await getCustomerByPhone(db, e164);
  if (!existing) return { ...EMPTY };
  const customerId = existing.id;

  return db.transaction(async (tx) => {
    // Collect the ids that human_actions may correlate to (free-text
    // correlation_id holds customer/lead/quote id strings).
    const leadRows = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.customerId, customerId));
    const quoteRows = await tx
      .select({ id: quotes.id })
      .from(quotes)
      .where(eq(quotes.customerId, customerId));
    const correlated = [customerId, ...leadRows.map((r) => r.id), ...quoteRows.map((r) => r.id)];

    // Explicit delete order: child rows first, customer last. conversation_turns
    // and quotes cascade on customer delete anyway, but deleting them here keeps
    // the returned counts accurate and the order FK-safe regardless of cascade.
    const conv = await tx
      .delete(conversationTurns)
      .where(eq(conversationTurns.customerId, customerId))
      .returning({ id: conversationTurns.id });
    const q = await tx
      .delete(quotes)
      .where(eq(quotes.customerId, customerId))
      .returning({ id: quotes.id });
    const ha = await tx
      .delete(humanActions)
      .where(inArray(humanActions.correlationId, correlated))
      .returning({ id: humanActions.id });
    const ld = await tx
      .delete(leads)
      .where(eq(leads.customerId, customerId))
      .returning({ id: leads.id });
    const cust = await tx
      .delete(customers)
      .where(eq(customers.id, customerId))
      .returning({ id: customers.id });

    const result: PurgeResult = {
      customer: cust.length,
      leads: ld.length,
      quotes: q.length,
      conversations: conv.length,
      humanActions: ha.length,
    };
    logger.info({ customerId, ...result }, 'contact purged (simulation reset)');
    return result;
  });
}
