/**
 * PII column encryption helpers (AES-256-GCM + HMAC-SHA256 for dedup hashing).
 *
 * Design (per F16 security section + secrets runbook):
 *   - Single master key, base64-encoded 32 bytes, in env var `PII_ENCRYPTION_KEY`.
 *   - AES-256-GCM with a fresh random 96-bit IV per call (NIST SP 800-38D rec).
 *   - Output is a single base64 blob = IV ‖ ciphertext ‖ 128-bit auth tag, so it
 *     fits in one `text` / `varchar` column without schema gymnastics.
 *   - `hashPII` is an HMAC-SHA256 (keyed with the same master key) for stable
 *     equality lookup / dedup (e.g. IBAN dedup, phone contact lookup) WITHOUT
 *     having to decrypt. It is one-way; not a substitute for encryption.
 *
 * Out of scope (deferred):
 *   - Key rotation tooling (M16).
 *   - HSM / KMS integration, envelope encryption.
 *
 * Performance note: `loadKey()` re-reads the env on every call rather than
 * caching. The cost (one base64 decode + length check) is negligible vs. the
 * AES op itself, and it keeps tests trivial. A future optimization may cache
 * the parsed key behind `__resetCryptoForTests()`.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard (96-bit IV)
const TAG_BYTES = 16; // GCM auth tag (128-bit)

function loadKey(): Buffer {
  const b64 = process.env['PII_ENCRYPTION_KEY'];
  if (!b64) throw new Error('PII_ENCRYPTION_KEY not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `PII_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}); generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

/**
 * Encrypt a UTF-8 string for at-rest storage.
 * Output format: base64(iv ‖ ciphertext ‖ tag). Fits a single text/varchar column.
 * Returns null for null/undefined input so callers can keep DB columns nullable.
 */
export function encryptPII(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString('base64');
}

/**
 * Decrypt a base64(iv ‖ ciphertext ‖ tag) blob produced by `encryptPII`.
 * Throws on tampering (auth tag mismatch) or wrong key.
 */
export function decryptPII(ciphertext: string | null | undefined): string | null {
  if (ciphertext === null || ciphertext === undefined) return null;
  const key = loadKey();
  const raw = Buffer.from(ciphertext, 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error('PII ciphertext too short');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Stable one-way digest for indexing / dedup (e.g. IBAN dedup key, phone
 * contact lookup without decrypting). HMAC-SHA256 keyed with the master key
 * so an attacker who exfiltrates the DB cannot rainbow-table the hashes
 * without also stealing the key.
 *
 * NOT a substitute for encryption — use alongside `encryptPII`, not instead.
 */
export function hashPII(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  const key = loadKey();
  return createHmac('sha256', key).update(plaintext, 'utf8').digest('base64url');
}

/**
 * Test-only: force key reload. Currently a no-op since `loadKey()` reads env
 * on every call; the symbol exists so future caching can be added without
 * breaking test setups that already rely on it.
 */
export function __resetCryptoForTests(): void {
  // intentionally empty — placeholder for future key-cache invalidation
}
