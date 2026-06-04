/**
 * Voice session-lookup route tests (`GET /v1/voice/session/:sessionId`).
 *
 * Gated on TEST_REDIS_URL — we seed a session in real Redis (injected client)
 * then exercise the Hono router. Covers:
 *   - 200 + {leadId, customerId} with the correct secret + a known session
 *   - 401 on a missing/wrong x-f16-internal-secret
 *   - 404 on an unknown/expired session
 *   - dev mode (no secret configured) skips the gate
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { buildSessionLookupRouter } from '../../src/http/session-lookup.js';
import { putSession, type RedisLike } from '../../src/voice/session-store.js';

const redisUrl = process.env.TEST_REDIS_URL;
const d = describe.skipIf(!redisUrl);

const SECRET = 'super-internal-secret';

d('GET /v1/voice/session/:sessionId', () => {
  let redis: Redis;
  let asLike: RedisLike;

  beforeEach(() => {
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: null, enableReadyCheck: false });
    asLike = redis as unknown as RedisLike;
  });

  afterAll(async () => {
    await redis?.quit().catch(() => {});
  });

  function sid(): string {
    return `lookup-${randomBytes(8).toString('hex')}`;
  }

  it('returns {leadId, customerId} (200) with the secret + a known session', async () => {
    const sessionId = sid();
    await putSession(sessionId, { leadId: 'lead-7', customerId: 'cust-7' }, asLike);
    const app = buildSessionLookupRouter({ lookupSecret: SECRET, redis: asLike });

    const res = await app.request(`/v1/voice/session/${sessionId}`, {
      method: 'GET',
      headers: { 'x-f16-internal-secret': SECRET },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ leadId: 'lead-7', customerId: 'cust-7' });
  });

  it('401s when the secret header is missing', async () => {
    const sessionId = sid();
    await putSession(sessionId, { leadId: 'l', customerId: 'c' }, asLike);
    const app = buildSessionLookupRouter({ lookupSecret: SECRET, redis: asLike });
    const res = await app.request(`/v1/voice/session/${sessionId}`, { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('401s when the secret header is wrong', async () => {
    const sessionId = sid();
    await putSession(sessionId, { leadId: 'l', customerId: 'c' }, asLike);
    const app = buildSessionLookupRouter({ lookupSecret: SECRET, redis: asLike });
    const res = await app.request(`/v1/voice/session/${sessionId}`, {
      method: 'GET',
      headers: { 'x-f16-internal-secret': 'wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('404s for an unknown session (correct secret)', async () => {
    const app = buildSessionLookupRouter({ lookupSecret: SECRET, redis: asLike });
    const res = await app.request(`/v1/voice/session/${sid()}`, {
      method: 'GET',
      headers: { 'x-f16-internal-secret': SECRET },
    });
    expect(res.status).toBe(404);
  });

  it('skips the secret gate in dev (no secret configured)', async () => {
    const sessionId = sid();
    await putSession(sessionId, { leadId: 'l2', customerId: 'c2' }, asLike);
    const app = buildSessionLookupRouter({ redis: asLike });
    const res = await app.request(`/v1/voice/session/${sessionId}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ leadId: 'l2', customerId: 'c2' });
  });
});
