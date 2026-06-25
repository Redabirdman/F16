/**
 * Customers repository — the only layer that knows about PII encryption.
 *
 * Application code talks plaintext domain objects (`CustomerInput` /
 * `CustomerOutput`). This module is responsible for:
 *   - encrypting on the way in (full_name, email, phone, address JSON, IBAN)
 *   - computing the IBAN hash for dedup
 *   - decrypting on the way out and re-parsing the address JSON
 *
 * Keep this file thin — no business logic, no validation beyond shape.
 * Validation lives in zod schemas at the request boundary (M4 onwards).
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../index.js';
import { customers } from '../schema/index.js';
import type { Customer } from '../schema/customers.js';
import { encryptPII, decryptPII, hashPII } from '../crypto.js';
import { normalizeIban, validateIban, maskIban } from '../../lib/iban.js';

/** Plaintext domain shape passed into the repo. */
export interface CustomerInput {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  /** Parsed JSON; stringified + encrypted before storage. */
  address?: Record<string, unknown> | null;
  iban?: string | null;
  dob?: Date | null;
  civility?: string | null;
  vehicle?: Record<string, unknown> | null;
  driver?: Record<string, unknown> | null;
  preferences?: Record<string, unknown> | null;
  consent?: Record<string, unknown> | null;
  hubspotId?: string | null;
}

/** Plaintext domain shape returned by reads. PII is decrypted. */
export interface CustomerOutput extends CustomerInput {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Insert a new customer; returns the decrypted row. */
export async function insertCustomer(db: Database, input: CustomerInput): Promise<CustomerOutput> {
  // encryptPII returns null for null/undefined; coerce non-null fields explicitly.
  const fullNameCt = encryptPII(input.fullName);
  if (fullNameCt === null) {
    // Defensive: full_name is NOT NULL at the DB level. Catch the misuse early
    // with a clear message rather than a Postgres constraint violation.
    throw new Error('insertCustomer: fullName is required');
  }

  const addressJson = input.address ? JSON.stringify(input.address) : null;

  const [inserted] = await db
    .insert(customers)
    .values({
      fullName: fullNameCt,
      email: encryptPII(input.email ?? null),
      phone: encryptPII(input.phone ?? null),
      // Mirror the IBAN pattern: encrypt the phone for retrieval, store an
      // HMAC alongside so the inbound webhook can match repeat senders
      // (M4.T3) without scanning + decrypting every row.
      phoneHash: hashPII(input.phone ?? null),
      address: encryptPII(addressJson),
      ibanCiphertext: encryptPII(input.iban ?? null),
      ibanHash: hashPII(input.iban ?? null),
      dob: input.dob ? toIsoDate(input.dob) : null,
      civility: input.civility ?? null,
      hubspotId: input.hubspotId ?? null,
      vehicle: input.vehicle ?? null,
      driver: input.driver ?? null,
      preferences: input.preferences ?? null,
      consent: input.consent ?? null,
    })
    .returning();

  if (!inserted) throw new Error('insertCustomer: insert returned no row');
  return decryptCustomerRow(inserted);
}

/** Fetch a customer by id; returns null if not found. PII is decrypted. */
export async function getCustomerById(db: Database, id: string): Promise<CustomerOutput | null> {
  const [row] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  if (!row) return null;
  return decryptCustomerRow(row);
}

/** Fetch a customer by IBAN — uses the dedup hash, never decrypts. */
export async function getCustomerByIban(
  db: Database,
  iban: string,
): Promise<CustomerOutput | null> {
  const hash = hashPII(iban);
  if (!hash) return null;
  const [row] = await db.select().from(customers).where(eq(customers.ibanHash, hash)).limit(1);
  if (!row) return null;
  return decryptCustomerRow(row);
}

/**
 * Fetch a customer by E.164 phone — uses the dedup hash, never decrypts.
 * The inbound WhatsApp webhook (M4.T3) is the primary caller: it needs to
 * map a sender to an existing customer before falling back to a stub create.
 */
export async function getCustomerByPhone(
  db: Database,
  e164: string,
): Promise<CustomerOutput | null> {
  const hash = hashPII(e164);
  if (!hash) return null;
  const [row] = await db.select().from(customers).where(eq(customers.phoneHash, hash)).limit(1);
  if (!row) return null;
  return decryptCustomerRow(row);
}

// ---------------------------------------------------------------------------
// Bank details for souscription prélèvement (M8.T7 closing).
// Same AES-256-GCM at-rest pattern as the PII block. The plaintext NEVER
// appears in logs or error messages — only maskIban() forms.
// ---------------------------------------------------------------------------

/** Plaintext bank details collected at closing. */
export interface CustomerBankDetailsInput {
  iban: string;
  bic: string;
  accountHolder: string;
  /** Lieu de naissance — Ville. Plaintext column (same tier as dob). */
  birthPlaceCity: string;
}

/** Decrypted bank details, or nulls where never collected. */
export interface CustomerBankDetails {
  iban: string | null;
  bic: string | null;
  accountHolder: string | null;
  birthPlaceCity: string | null;
}

/**
 * Persist the closing bank details encrypted on the customer row. The IBAN is
 * checksum-validated (mod-97) and normalized before encryption so the Maxance
 * Operator always reads a fill-ready value. Throws on an invalid IBAN with a
 * MASKED reference only.
 */
export async function saveCustomerBankDetails(
  db: Database,
  customerId: string,
  input: CustomerBankDetailsInput,
): Promise<void> {
  const iban = normalizeIban(input.iban);
  if (!validateIban(iban)) {
    throw new Error(`saveCustomerBankDetails: invalid IBAN checksum (${maskIban(iban)})`);
  }
  const bic = input.bic.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) {
    throw new Error('saveCustomerBankDetails: invalid BIC format');
  }
  const accountHolder = input.accountHolder.trim();
  if (!accountHolder) {
    throw new Error('saveCustomerBankDetails: accountHolder is required');
  }
  const birthPlaceCity = input.birthPlaceCity.trim();
  if (!birthPlaceCity) {
    throw new Error('saveCustomerBankDetails: birthPlaceCity is required');
  }

  const [row] = await db
    .update(customers)
    .set({
      bankIbanEnc: encryptPII(iban),
      bankBicEnc: encryptPII(bic),
      bankAccountHolderEnc: encryptPII(accountHolder),
      birthPlaceCity,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, customerId))
    .returning({ id: customers.id });

  if (!row) throw new Error(`saveCustomerBankDetails: no customer with id=${customerId}`);
}

/**
 * Decrypt the closing bank details for the Maxance Operator. Returns null when
 * the customer doesn't exist; null fields when never collected. Callers MUST
 * NOT log the returned values (maskIban only).
 */
export async function getCustomerBankDetails(
  db: Database,
  customerId: string,
): Promise<CustomerBankDetails | null> {
  const [row] = await db
    .select({
      bankIbanEnc: customers.bankIbanEnc,
      bankBicEnc: customers.bankBicEnc,
      bankAccountHolderEnc: customers.bankAccountHolderEnc,
      birthPlaceCity: customers.birthPlaceCity,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!row) return null;

  return {
    iban: decryptPII(row.bankIbanEnc),
    bic: decryptPII(row.bankBicEnc),
    accountHolder: decryptPII(row.bankAccountHolderEnc),
    birthPlaceCity: row.birthPlaceCity,
  };
}

/** Reverse the encryption applied at insert. Exported for tests + adjacent repos. */
export function decryptCustomerRow(row: Customer): CustomerOutput {
  const fullName = decryptPII(row.fullName);
  if (fullName === null) {
    // Same defensive check as the writer side — the column is NOT NULL.
    throw new Error('decryptCustomerRow: full_name decrypted to null');
  }

  const addressJson = decryptPII(row.address);
  const address = addressJson ? (JSON.parse(addressJson) as Record<string, unknown>) : null;

  return {
    id: row.id,
    fullName,
    email: decryptPII(row.email),
    phone: decryptPII(row.phone),
    address,
    iban: decryptPII(row.ibanCiphertext),
    // Drizzle `date()` returns ISO date strings (YYYY-MM-DD), not Date objects.
    dob: row.dob ? new Date(row.dob) : null,
    civility: row.civility,
    vehicle: row.vehicle ?? null,
    driver: row.driver ?? null,
    preferences: row.preferences ?? null,
    consent: row.consent ?? null,
    hubspotId: row.hubspotId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toIsoDate(d: Date): string {
  // `date` in pg expects YYYY-MM-DD. Strip the time portion deterministically.
  return d.toISOString().slice(0, 10);
}
