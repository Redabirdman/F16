import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptPII, decryptPII, hashPII } from '../../src/db/crypto.js';

let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.PII_ENCRYPTION_KEY;
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
  else process.env.PII_ENCRYPTION_KEY = savedKey;
});

describe('encryptPII / decryptPII', () => {
  it('roundtrips utf-8 strings including accents', () => {
    const samples = ['Hello', 'éàçñü 漢字 🚗', 'a'.repeat(10_000), ''];
    for (const s of samples) {
      const enc = encryptPII(s);
      expect(enc).not.toBe(s);
      expect(decryptPII(enc)).toBe(s);
    }
  });

  it('returns null for null/undefined input', () => {
    expect(encryptPII(null)).toBeNull();
    expect(encryptPII(undefined)).toBeNull();
    expect(decryptPII(null)).toBeNull();
    expect(decryptPII(undefined)).toBeNull();
  });

  it('produces a different ciphertext each call (random IV)', () => {
    const a = encryptPII('same input');
    const b = encryptPII('same input');
    expect(a).not.toBe(b);
    expect(decryptPII(a)).toBe('same input');
    expect(decryptPII(b)).toBe('same input');
  });

  it('throws on tampering (modified ciphertext)', () => {
    const enc = encryptPII('important data')!;
    const tampered = Buffer.from(enc, 'base64');
    // Flip one byte in the middle of the ciphertext region (past the 12-byte IV)
    tampered.writeUInt8(tampered.readUInt8(20) ^ 0x01, 20);
    expect(() => decryptPII(tampered.toString('base64'))).toThrow();
  });

  it('throws on wrong key', () => {
    const enc = encryptPII('secret data')!;
    const original = process.env.PII_ENCRYPTION_KEY;
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    try {
      expect(() => decryptPII(enc)).toThrow();
    } finally {
      process.env.PII_ENCRYPTION_KEY = original;
    }
  });

  it('throws on missing env', () => {
    const original = process.env.PII_ENCRYPTION_KEY;
    delete process.env.PII_ENCRYPTION_KEY;
    try {
      expect(() => encryptPII('x')).toThrow(/PII_ENCRYPTION_KEY not set/);
      expect(() => decryptPII('x')).toThrow(/PII_ENCRYPTION_KEY not set/);
    } finally {
      process.env.PII_ENCRYPTION_KEY = original;
    }
  });

  it('throws on wrong-length key', () => {
    const original = process.env.PII_ENCRYPTION_KEY;
    process.env.PII_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64'); // too short
    try {
      expect(() => encryptPII('x')).toThrow(/must decode to 32 bytes/);
    } finally {
      process.env.PII_ENCRYPTION_KEY = original;
    }
  });

  it('throws on ciphertext too short', () => {
    expect(() => decryptPII('YWJj')).toThrow(/too short/);
  });
});

describe('hashPII', () => {
  it('is deterministic for same input + same key', () => {
    expect(hashPII('IBAN-FOO')).toBe(hashPII('IBAN-FOO'));
  });

  it('is different for different input', () => {
    expect(hashPII('IBAN-FOO')).not.toBe(hashPII('IBAN-BAR'));
  });

  it('returns null for null/undefined', () => {
    expect(hashPII(null)).toBeNull();
    expect(hashPII(undefined)).toBeNull();
  });

  it('changes when key changes (HMAC keyed)', () => {
    const original = process.env.PII_ENCRYPTION_KEY;
    const a = hashPII('IBAN-FOO');
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    try {
      const b = hashPII('IBAN-FOO');
      expect(a).not.toBe(b);
    } finally {
      process.env.PII_ENCRYPTION_KEY = original;
    }
  });
});
