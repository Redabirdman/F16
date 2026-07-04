/**
 * Logical named queues for F16. Each maps to a Redis stream namespace under
 * the BULLMQ_PREFIX. Names are stable strings — do NOT change without a
 * migration plan: jobs already in Redis are keyed by the queue name.
 *
 * One LOGICAL queue per intent domain. Handlers are wired in M3.T3.
 *
 * 2026-07-03: the dispatcher scopes the PHYSICAL BullMQ queue by consumer
 * role — `${category}.${toRole}` (see messaging/dispatcher.ts
 * physicalQueueName) — so roles sharing a category never race for each
 * other's jobs. These names remain the logical categories agents subscribe
 * with; the role suffix is derived inside sendMessage()/consume().
 */
export const QUEUE_NAMES = {
  LEAD: 'lead',
  CUSTOMER: 'customer',
  QUOTE: 'quote',
  VOICE: 'voice',
  ADS: 'ads',
  KNOWLEDGE: 'knowledge',
  COMPLIANCE: 'compliance',
  HUMAN_ACTION: 'human_action',
  OPERATIONS: 'operations',
  ENGAGEMENT: 'engagement',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
