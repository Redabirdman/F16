/**
 * `customers` + `customer_facts` tables (design §7.1).
 *
 * PII encryption policy (see `backend/src/db/crypto.ts`):
 *   - Encrypted at rest (AES-256-GCM, base64 blob stored in `text`):
 *       full_name, email, phone, address (JSON-stringified), iban_ciphertext
 *   - HMAC-SHA256 (43-char base64url) for dedup without decryption:
 *       iban_hash    — UNIQUE; the lookup key for IBAN dedup at intake
 *       phone_hash   — UNIQUE (partial); inbound-channel sender dedup so the
 *                      WhatsApp webhook can match repeat senders without
 *                      decrypting every customer row (M4.T3).
 *   - Plaintext jsonb (design treats as "lower sensitivity", needs to be
 *     queryable for matching/segmentation):
 *       vehicle, driver, preferences, consent
 *   - Plaintext scalars (operational metadata, low sensitivity):
 *       dob, civility, hubspot_id
 *
 * `address` is stored encrypted as a single `text` column even though it's
 * structurally JSON — column-level encryption of jsonb isn't supported
 * natively, so callers JSON.stringify before encrypt and JSON.parse after
 * decrypt. The repository layer (`repositories/customers.ts`) handles this.
 *
 * `customer_facts` is the embeddings tier — the LLM recall path (Mem0)
 * does kNN over `embedding` filtered by `customer_id`. HNSW index uses
 * cosine distance to match OpenAI text-embedding-3-small / -large output.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  varchar,
  date,
  jsonb,
  timestamp,
  real,
  vector,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { factTypeEnum } from './_enums.js';

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // --- Encrypted PII (base64 of iv ‖ ciphertext ‖ tag) ---
    fullName: text('full_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    // Stable HMAC of the E.164 phone for dedup at intake (M4.T3). Nullable —
    // historical rows + customers we only know by IBAN/email won't have one.
    phoneHash: varchar('phone_hash', { length: 43 }),
    address: text('address'), // encrypted JSON string

    // --- IBAN: ciphertext for decrypt, hash for dedup ---
    ibanCiphertext: text('iban_ciphertext'),
    ibanHash: varchar('iban_hash', { length: 43 }), // HMAC-SHA256 base64url = 43 chars

    // --- Plaintext low-sensitivity scalars ---
    dob: date('dob'),
    civility: text('civility'),
    hubspotId: text('hubspot_id'),

    // --- Plaintext jsonb (queryable, lower sensitivity per design) ---
    vehicle: jsonb('vehicle').$type<Record<string, unknown>>(),
    driver: jsonb('driver').$type<Record<string, unknown>>(),
    preferences: jsonb('preferences').$type<Record<string, unknown>>(),
    consent: jsonb('consent').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // IBAN dedup at intake — unique only when present (partial via NULLS DISTINCT default).
    uniqueIndex('customers_iban_hash_uniq').on(t.ibanHash),
    // Phone dedup for inbound-channel sender match (M4.T3). Partial — we
    // never want to collapse the NULL bucket into a single customer.
    uniqueIndex('customers_phone_hash_uniq')
      .on(t.phoneHash)
      .where(sql`${t.phoneHash} IS NOT NULL`),
    // Default leads/list ordering — recent first.
    index('customers_created_at_idx').on(sql`${t.createdAt} DESC`),
    // HubSpot lookup (sync flows match by external ID).
    index('customers_hubspot_id_idx').on(t.hubspotId),
  ],
);

export const customerFacts = pgTable(
  'customer_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .references(() => customers.id, { onDelete: 'cascade' })
      .notNull(),
    factType: factTypeEnum('fact_type').notNull(),
    content: text('content').notNull(),
    confidence: real('confidence'), // 0..1; nullable while not yet calibrated
    recordedBy: text('recorded_by'), // agent role string
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    // OpenAI text-embedding-3-small dim = 1536. Bump if model changes.
    embedding: vector('embedding', { dimensions: 1536 }),
  },
  (t) => [
    // Recall is always scoped to a customer first, then ranked by similarity.
    index('customer_facts_customer_id_idx').on(t.customerId),
    // HNSW + cosine ops matches OpenAI embeddings' similarity metric.
    index('customer_facts_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type CustomerFact = typeof customerFacts.$inferSelect;
export type NewCustomerFact = typeof customerFacts.$inferInsert;
