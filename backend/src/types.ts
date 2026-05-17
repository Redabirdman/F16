/**
 * Shared backend types.
 *
 * As the backend grows (Drizzle schemas, BullMQ job types, agent message envelopes),
 * this file will host cross-cutting types that don't belong to a single module.
 * For now it carries only the health endpoint's response shape so the HTTP layer
 * and the smoke test can agree on a contract.
 */

export type HealthResponse = {
  ok: true;
  service: 'f16-backend';
  version: string;
  uptime: number;
};
