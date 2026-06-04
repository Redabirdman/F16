/**
 * Voice session registry (Redis-backed).
 *
 * When the voice-operator originates a call it mints a sessionId (= the
 * AudioSocket AS_UUID). Pipecat, once bridged, only knows that UUID — it needs
 * to resolve which F16 lead/customer the call belongs to. We stash that mapping
 * here, keyed by sessionId, with a short TTL (the lookup happens within seconds
 * of the call connecting; an hour is generous head-room).
 *
 * Storage: the app's shared ioredis singleton (`getRedis()` from src/queue) —
 * the SAME connection BullMQ uses, so we add no new infra. Values are tiny JSON
 * blobs ({leadId, customerId}); neither field is PII (both are UUIDs), so this
 * is safe to keep in Redis without encryption.
 *
 * The Redis client is injectable for tests (the route/operator pass the real
 * singleton; tests pass a real client pointed at TEST_REDIS_URL).
 */
import { getRedis } from '../queue/index.js';

/** Minimal redis surface we depend on (subset of ioredis) — eases test stubs. */
export interface RedisLike {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

/** The session payload Pipecat resolves from the AudioSocket UUID. */
export interface VoiceSession {
  /** F16 lead id (UUID). */
  leadId: string;
  /** F16 customer id (UUID). */
  customerId: string;
}

/** Default session TTL — 1 hour. Looked up within seconds in practice. */
export const SESSION_TTL_SECONDS = 60 * 60;

/** Redis key namespace for voice sessions. */
function sessionKey(sessionId: string): string {
  return `f16:voice:session:${sessionId}`;
}

/**
 * Store a session mapping. `redis` defaults to the shared app singleton; tests
 * inject a real client bound to TEST_REDIS_URL.
 */
export async function putSession(
  sessionId: string,
  session: VoiceSession,
  redis: RedisLike = getRedis() as unknown as RedisLike,
): Promise<void> {
  if (!sessionId) throw new Error('putSession: sessionId required');
  if (!session.leadId || !session.customerId) {
    throw new Error('putSession: leadId and customerId required');
  }
  await redis.set(
    sessionKey(sessionId),
    JSON.stringify({ leadId: session.leadId, customerId: session.customerId }),
    'EX',
    SESSION_TTL_SECONDS,
  );
}

/**
 * Look up a session by id. Returns null when the session is unknown/expired or
 * the stored blob is corrupt (treated as a miss rather than throwing).
 */
export async function getSession(
  sessionId: string,
  redis: RedisLike = getRedis() as unknown as RedisLike,
): Promise<VoiceSession | null> {
  if (!sessionId) return null;
  const raw = await redis.get(sessionKey(sessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VoiceSession>;
    if (!parsed.leadId || !parsed.customerId) return null;
    return { leadId: parsed.leadId, customerId: parsed.customerId };
  } catch {
    return null;
  }
}

/** Remove a session mapping (e.g. on hangup). Best-effort; safe to no-op. */
export async function deleteSession(
  sessionId: string,
  redis: RedisLike = getRedis() as unknown as RedisLike,
): Promise<void> {
  if (!sessionId) return;
  await redis.del(sessionKey(sessionId));
}
