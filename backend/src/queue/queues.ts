/**
 * Logical named queues for F16. Each maps to a Redis stream namespace under
 * the BULLMQ_PREFIX. Names are stable strings — do NOT change without a
 * migration plan: jobs already in Redis are keyed by the queue name.
 *
 * One queue per intent domain. Handlers are wired in M3.T3.
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
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
