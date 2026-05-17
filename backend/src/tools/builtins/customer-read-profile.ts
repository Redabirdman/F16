/**
 * Tool: `customer.read_profile` — fetch a customer profile with PII decrypted.
 *
 * The Sales/Service/Quote agents need to see the customer's name, contact info
 * and vehicle/driver context when composing replies. This tool centralises the
 * PII-decrypt step so the handler is the only place plaintext is materialised
 * in the agent runtime path.
 *
 * Security:
 *   - The response contains DECRYPTED PII. Callers MUST NOT log the response.
 *     The audit trail logs the tool call by name + customerId only; the body
 *     is dropped at the boundary.
 *   - Throws on unknown customerId — never silently returns null (the LLM
 *     would happily proceed with a half-formed reply otherwise).
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { registerTool } from '../registry.js';
import { customers } from '../../db/schema/index.js';
import { decryptPII } from '../../db/crypto.js';

export const customerReadProfileToolName = 'customer.read_profile';

const inputSchema = z.object({
  customerId: z.string().uuid(),
});

const outputSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  // address, vehicle, driver, preferences are returned as parsed JSON / null.
  address: z.unknown().nullable(),
  vehicle: z.unknown().nullable(),
  driver: z.unknown().nullable(),
  preferences: z.unknown().nullable(),
  civility: z.string().nullable(),
  /** ISO date string (YYYY-MM-DD) or null. */
  dob: z.string().nullable(),
  hubspotId: z.string().nullable(),
  /** ISO 8601 timestamp. */
  createdAt: z.string(),
});

registerTool({
  name: customerReadProfileToolName,
  description:
    'Read a customer profile by id. Returns decrypted PII fields (full name, ' +
    'email, phone, address) for use by the calling agent — never log the response.',
  inputSchema,
  outputSchema,
  handler: async (ctx, input) => {
    const [row] = await ctx.db
      .select()
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);

    if (!row) throw new Error(`Customer ${input.customerId} not found`);

    // address is stored as an ENCRYPTED JSON string in a text column — decrypt
    // first, then parse. JSON.parse of "null" returns null, which is the
    // sentinel for "no address recorded".
    const addressPlain = decryptPII(row.address);
    const address =
      addressPlain && addressPlain !== 'null'
        ? (JSON.parse(addressPlain) as Record<string, unknown>)
        : null;

    const fullName = decryptPII(row.fullName);
    if (fullName === null) {
      // full_name is NOT NULL in the schema — null here means decrypt failed.
      throw new Error(`Customer ${input.customerId} has unreadable full_name`);
    }

    return {
      id: row.id,
      fullName,
      email: decryptPII(row.email),
      phone: decryptPII(row.phone),
      address,
      vehicle: row.vehicle ?? null,
      driver: row.driver ?? null,
      preferences: row.preferences ?? null,
      civility: row.civility,
      // drizzle `date()` returns ISO date strings already.
      dob: row.dob ?? null,
      hubspotId: row.hubspotId,
      createdAt: row.createdAt.toISOString(),
    };
  },
});
