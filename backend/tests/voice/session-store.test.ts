/**
 * Voice session-store tests (real Redis via TEST_REDIS_URL).
 *
 * Gated on TEST_REDIS_URL — the store reads/writes the app's ioredis singleton.
 * We point a real ioredis client at TEST_REDIS_URL and pass it in via the
 * injectable `redis` param (no app singleton, no env mutation). Covers
 * put → get round-trip, TTL set, unknown/expired → null, corrupt blob → null,
 * and delete.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  putSession,
  getSession,
  deleteSession,
  SESSION_TTL_SECONDS,
  type RedisLike,
} from '../../src/voice/session-store.js';

const redisUrl = process.env.TEST_REDIS_URL;
const d = describe.skipIf(!redisUrl);

d('voice session-store', () => {
  let redis: Redis;
  let asLike: RedisLike;

  beforeEach(() => {
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: null, enableReadyCheck: false });
    asLike = redis as unknown as RedisLike;
  });

  afterAll(async () => {
    await redis?.quit().catch(() => {});
  });

  function newSessionId(): string {
    return `test-${randomBytes(8).toString('hex')}`;
  }

  it('round-trips a session (put → get)', async () => {
    const sessionId = newSessionId();
    await putSession(sessionId, { leadId: 'lead-1', customerId: 'cust-1' }, asLike);
    const got = await getSession(sessionId, asLike);
    expect(got).toEqual({ leadId: 'lead-1', customerId: 'cust-1' });
    await deleteSession(sessionId, asLike);
  });

  it('sets a TTL on the stored key', async () => {
    const sessionId = newSessionId();
    await putSession(sessionId, { leadId: 'l', customerId: 'c' }, asLike);
    const ttl = await redis.ttl(`f16:voice:session:${sessionId}`);
    // TTL is positive and within the configured window.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS);
    await deleteSession(sessionId, asLike);
  });

  it('returns null for an unknown session', async () => {
    expect(await getSession(newSessionId(), asLike)).toBeNull();
  });

  it('returns null for a corrupt blob', async () => {
    const sessionId = newSessionId();
    await redis.set(`f16:voice:session:${sessionId}`, 'not-json', 'EX', 60);
    expect(await getSession(sessionId, asLike)).toBeNull();
    await deleteSession(sessionId, asLike);
  });

  it('deletes a session', async () => {
    const sessionId = newSessionId();
    await putSession(sessionId, { leadId: 'l', customerId: 'c' }, asLike);
    await deleteSession(sessionId, asLike);
    expect(await getSession(sessionId, asLike)).toBeNull();
  });

  it('rejects an incomplete session payload', async () => {
    await expect(
      putSession(newSessionId(), { leadId: '', customerId: 'c' }, asLike),
    ).rejects.toThrow('leadId and customerId required');
  });
});
