/**
 * Tool: `human.escalate` — push a decision out of the agent loop into the
 * human-in-the-loop queue.
 *
 * Two side effects:
 *   1. Inserts a row into `human_actions` (status='pending') so the admin UI
 *      + WhatsApp escalator surface it.
 *   2. Dispatches a `HUMAN_ACTION.REQUESTED` agent_message via the
 *      dispatcher so subscribers (escalator worker, ops dashboard) wake up.
 *
 * The row is the source of truth; the message is the wakeup. If the dispatch
 * fails the row is still there — the escalator's periodic LISTEN/NOTIFY scan
 * will eventually pick it up anyway, so we don't transactionally couple the
 * two writes.
 *
 * Caller identity:
 *   `created_by_agent` is composed as `<agentRole>#<agentInstance>` so the
 *   admin UI can group escalations by the spawning agent. The
 *   `correlationId` (lead, customer, conversation) flows through to both the
 *   human_actions row and the agent_messages payload so the timeline view
 *   joins them correctly.
 */
import { z } from 'zod';
import { registerTool } from '../registry.js';
import { createAction } from '../../db/repositories/human-actions.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import type { HumanActionOption } from '../../db/schema/agent-runtime.js';

export const humanEscalateToolName = 'human.escalate';

const optionKindEnum = z.enum(['approve', 'reject', 'revise', 'callback', 'custom']);

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: optionKindEnum,
});

const inputSchema = z.object({
  /** Short machine name of the decision being escalated, e.g. 'APPROVE_REFUND'. */
  intent: z.string().min(1),
  /** 1 = critical (red), 2 = standard (yellow), 3 = info (green). */
  severity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  /** Human-readable French summary surfaced in admin UI + WhatsApp. */
  summary: z.string().min(1),
  /** Options offered to the human resolver. At least one is required. */
  options: z.array(optionSchema).min(1).optional(),
  /** Override the ctx correlation id for this specific escalation. */
  correlationId: z.string().optional(),
});

const outputSchema = z.object({
  humanActionId: z.string().uuid(),
});

/** Default options when the agent doesn't supply any. */
const DEFAULT_OPTIONS: HumanActionOption[] = [
  { id: 'approve', label: 'Approuver', kind: 'approve' },
  { id: 'reject', label: 'Refuser', kind: 'reject' },
];

registerTool({
  name: humanEscalateToolName,
  description:
    'Escalate a decision to a human operator. Creates a pending human_action ' +
    'row and dispatches a HUMAN_ACTION.REQUESTED message so the admin UI + ' +
    'WhatsApp escalator wake up. Returns the new humanActionId; the agent ' +
    'should then stop and wait for HUMAN_ACTION.RESOLVED.',
  inputSchema,
  outputSchema,
  handler: async (ctx, input) => {
    const options: HumanActionOption[] = input.options ?? DEFAULT_OPTIONS;
    const correlationId = input.correlationId ?? ctx.correlationId ?? null;

    const action = await createAction(ctx.db, {
      createdByAgent: `${ctx.agentRole}#${ctx.agentInstance}`,
      intent: input.intent,
      severity: input.severity,
      summary: input.summary,
      options,
      correlationId,
    });

    // human_action queue is the routing target for HUMAN_ACTION.REQUESTED
    // (see INTENT_TO_QUEUE in dispatcher.ts). `toRole` is the logical
    // recipient; for human queues we route to the 'human-router' role which
    // the escalator + admin subscribe under.
    //
    // We build the dispatcher input incrementally so that `correlationId`
    // is OMITTED rather than passed as `undefined` (exactOptionalPropertyTypes
    // would reject the latter).
    const sendInput: Parameters<typeof sendMessage>[1] = {
      fromRole: ctx.agentRole,
      fromInstance: ctx.agentInstance,
      toRole: 'human-router',
      intent: 'HUMAN_ACTION.REQUESTED',
      payload: {
        humanActionId: action.id,
        severity: input.severity,
        summary: input.summary,
      },
      requiresHuman: true,
    };
    if (correlationId !== null) {
      sendInput.correlationId = correlationId;
    }
    await sendMessage({ db: ctx.db }, sendInput);

    return { humanActionId: action.id };
  },
});
