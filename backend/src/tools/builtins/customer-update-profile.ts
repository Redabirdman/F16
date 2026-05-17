/**
 * Tool: `customer.update_profile` — partial PII-aware update of a customer row.
 *
 * Sparse semantics: ONLY the fields explicitly listed under `fields` are
 * touched. Passing an empty `fields` object is a no-op success (the agent's
 * "I have nothing new to write" path), passing `email: null` means "wipe the
 * email" — `undefined` means "leave it alone".
 *
 * PII fields (fullName, email, phone, address) are re-encrypted before
 * insertion so the DB never sees plaintext. Address is JSON-stringified before
 * encryption (the column is a `text` blob for ciphertext, see `customers.ts`).
 *
 * Out of scope (deferred):
 *   - Updates to `iban` (it has its own dedup-hash path and is intake-only).
 *   - Updates to `consent` (auditable elsewhere; deliberately not exposed to
 *     the LLM-driven path).
 *   - Audit log emission — wired in M6 when the SDK invokes tools through
 *     `invokeTool` with a known agent identity.
 */
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { registerTool } from '../registry.js';
import { customers } from '../../db/schema/index.js';
import { encryptPII } from '../../db/crypto.js';

export const customerUpdateProfileToolName = 'customer.update_profile';

/**
 * `fields` mirrors the writable surface of a customer profile. Every property
 * is optional — only listed properties are written.
 *
 * `null` means "clear" / "set to NULL"; `undefined` (omitted) means "leave it
 * alone". This is the standard sparse-patch pattern.
 */
const fieldsSchema = z
  .object({
    fullName: z.string().min(1).optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().min(1).nullable().optional(),
    address: z.record(z.string(), z.unknown()).nullable().optional(),
    vehicle: z.record(z.string(), z.unknown()).nullable().optional(),
    driver: z.record(z.string(), z.unknown()).nullable().optional(),
    preferences: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

const inputSchema = z.object({
  customerId: z.string().uuid(),
  fields: fieldsSchema,
});

const outputSchema = z.object({
  updated: z.literal(true),
});

registerTool({
  name: customerUpdateProfileToolName,
  description:
    'Partial update of a customer profile. Only fields explicitly passed under ' +
    '`fields` are written; pass `null` to clear a field, omit it to leave it ' +
    'alone. PII (name/email/phone/address) is re-encrypted before storage.',
  inputSchema,
  outputSchema,
  handler: async (ctx, input) => {
    const { customerId, fields } = input;

    // Build a partial update — only the keys explicitly present in `fields`.
    // We can't just `set(fields)` because (a) PII fields need encryption and
    // (b) drizzle would otherwise treat omitted keys as "set to undefined".
    const patch: Record<string, unknown> = {};

    if ('fullName' in fields && fields.fullName !== undefined) {
      // fullName is NOT NULL — schema already forbids passing null here.
      patch['fullName'] = encryptPII(fields.fullName);
    }
    if ('email' in fields) {
      patch['email'] = encryptPII(fields.email ?? null);
    }
    if ('phone' in fields) {
      patch['phone'] = encryptPII(fields.phone ?? null);
    }
    if ('address' in fields) {
      const addrJson = fields.address ? JSON.stringify(fields.address) : null;
      patch['address'] = encryptPII(addrJson);
    }
    if ('vehicle' in fields) {
      patch['vehicle'] = fields.vehicle ?? null;
    }
    if ('driver' in fields) {
      patch['driver'] = fields.driver ?? null;
    }
    if ('preferences' in fields) {
      patch['preferences'] = fields.preferences ?? null;
    }

    if (Object.keys(patch).length === 0) {
      // Empty-fields no-op. Verify the customer exists so the LLM can't be
      // fooled into thinking it just updated a non-existent row.
      const [existing] = await ctx.db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, customerId))
        .limit(1);
      if (!existing) throw new Error(`Customer ${customerId} not found`);
      return { updated: true as const };
    }

    // updated_at is a normal column with defaultNow at insert — we bump it
    // explicitly here so observers (audit, sync) can see "this row changed".
    patch['updatedAt'] = sql`now()`;

    const result = await ctx.db
      .update(customers)
      .set(patch)
      .where(eq(customers.id, customerId))
      .returning({ id: customers.id });

    if (result.length === 0) throw new Error(`Customer ${customerId} not found`);

    return { updated: true as const };
  },
});
