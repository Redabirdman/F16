import { z } from 'zod';
import { registerIntent } from './_registry.js';

export const HumanActionRequestedPayload = registerIntent(
  'HUMAN_ACTION.REQUESTED',
  z.object({
    humanActionId: z.string().uuid(),
    severity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    summary: z.string(),
  }),
);

export const HumanActionResolvedPayload = registerIntent(
  'HUMAN_ACTION.RESOLVED',
  z.object({
    humanActionId: z.string().uuid(),
    choice: z.string(),
    source: z.enum(['admin', 'whatsapp']),
  }),
);

export const SessionHeartbeatPayload = registerIntent(
  'SESSION.HEARTBEAT',
  z.object({
    service: z.enum(['maxance', 'waha', 'pipecat']),
    healthy: z.boolean(),
  }),
);

export const SessionLoggedOutPayload = registerIntent(
  'SESSION.LOGGED_OUT',
  z.object({
    service: z.string(),
  }),
);

export const OrgStateTickPayload = registerIntent(
  'ORG.STATE_TICK',
  z.object({
    timestamp: z.string().datetime(),
  }),
);
