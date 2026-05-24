/**
 * Customer Engagement Agent (M11) — re-engages WhatsApp-silent leads.
 *
 * Locked design (memory/project_m11_engagement_design.md):
 *   - 24h after last activity → nudge 1 (friendly check-in).
 *   - 72h after last activity → nudge 2 (softer, offers to close).
 *   - 7d after last activity  → mark lead `dormant` + escalate to
 *     Ridaa/Achraf via the Reporter Agent (HUMAN_ACTION.REQUESTED).
 *
 * Consumes one envelope intent: `ENGAGEMENT.TICK` with `{leadId}`. The
 * scheduler (scheduler.ts) is responsible for emitting these — it scans
 * `findEngagementCandidates`, enqueues a tick per match, and trusts the
 * agent to enforce every gate authoritatively:
 *
 *   1. lead status still in {scored, qualifying, quoting, negotiating}
 *   2. quiet hours (no sends 21:00-08:00 Europe/Paris, no weekends)
 *   3. cadence step + threshold (24h / 72h / 7d since last activity)
 *   4. anti-spam: the last outbound (any agent) must be older than the
 *      threshold being evaluated, so a Sales Agent reply 1h ago suppresses
 *      the 24h tick — we don't pile nudges on top of an active conversation
 *
 * Cadence step is DERIVED, not stored:
 *   step = count of conversation_turns where direction='outbound' AND
 *          agent_role='engagement-agent' AND occurredAt > anchor
 *   anchor = max(occurredAt) of inbound turns; if there are none, the
 *   step counts every engagement-agent outbound for the lead.
 *
 * This makes the agent migration-free (no new columns) and idempotent — a
 * tick that arrives while the lead is already at step 2 with <7d elapsed is
 * just a no-op, no second nudge.
 */
import { eq } from 'drizzle-orm';
import { BaseAgent } from '../base.js';
import type { AgentMessageEnvelope, MessageHandlerResult } from '../../messaging/dispatcher.js';
import { logger } from '../../logger.js';
import { customers, leads } from '../../db/schema/index.js';
import { decryptPII } from '../../db/crypto.js';
import { listTurns } from '../../db/repositories/conversation-turns.js';
import { sendViaChannel } from '../../channels/send.js';
import type { ChannelId, ContactRef } from '../../channels/types.js';
import { sendMessage } from '../../messaging/dispatcher.js';
import * as humanActions from '../../db/repositories/human-actions.js';
import { isQuietNow } from './quiet-hours.js';
import { generateNudgeText, type EngagementStep, type NudgeGenInput } from './messaging.js';
import { ELIGIBLE_LEAD_STATUSES } from './candidate.js';

/** Hours between last activity and each cadence step trigger. */
const THRESHOLD_HOURS: Record<0 | 1 | 2, number> = {
  0: 24, // step 0 → nudge 1
  1: 72, // step 1 → nudge 2
  2: 24 * 7, // step 2 → escalate + dormant
};

/** How many recent turns to skim for tone context handed to the LLM. */
const SNIPPET_TURN_LIMIT = 6;

const HOUR_MS = 3_600_000;

/** Role attribution recorded on every outbound nudge — also the step detector. */
const ENGAGEMENT_AGENT_ROLE = 'engagement-agent';

export class EngagementAgent extends BaseAgent {
  protected async onMessage(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    try {
      if (envelope.intent !== 'ENGAGEMENT.TICK') {
        return {
          ok: true,
          result: { skipped: 'unhandled-intent', intent: envelope.intent },
        };
      }
      return await this.handleTick(envelope);
    } catch (err) {
      logger.error(
        { err, intent: envelope.intent, instanceId: this.instanceId },
        'engagement-agent: onMessage threw',
      );
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async handleTick(envelope: AgentMessageEnvelope): Promise<MessageHandlerResult> {
    const payload = envelope.payload as { leadId: string };
    const now = new Date();

    const [lead] = await this.db.select().from(leads).where(eq(leads.id, payload.leadId)).limit(1);
    if (!lead) {
      logger.warn({ leadId: payload.leadId }, 'engagement-agent: lead not found');
      return { ok: false, error: 'lead_not_found' };
    }
    if (!(ELIGIBLE_LEAD_STATUSES as readonly string[]).includes(lead.status)) {
      return { ok: true, result: { skipped: 'lead-status-ineligible', status: lead.status } };
    }
    if (!lead.customerId) {
      return { ok: true, result: { skipped: 'lead-has-no-customer' } };
    }

    // Pull a small tail of turns — enough to anchor the cadence + give the
    // LLM tone context. We don't need the full history.
    const recentTurnsDesc = await listTurns(this.db, {
      customerId: lead.customerId,
      leadId: lead.id,
      limit: 20,
    });
    if (recentTurnsDesc.length === 0) {
      // No turns at all — the welcome hasn't been logged yet. Sales Agent
      // owns the welcome, so this is a "wait" not a "skip permanently".
      return { ok: true, result: { skipped: 'no-conversation-turns-yet' } };
    }
    const lastActivityAt = recentTurnsDesc[0]?.occurredAt;
    if (!lastActivityAt) {
      return { ok: true, result: { skipped: 'no-conversation-turns-yet' } };
    }

    // Determine cadence step from how many engagement-agent outbound turns
    // have happened SINCE the most-recent inbound (or all of them if the
    // customer has never replied).
    const lastInboundAt = recentTurnsDesc.find((t) => t.direction === 'inbound')?.occurredAt;
    const engagementOutboundsAfterAnchor = recentTurnsDesc.filter(
      (t) =>
        t.direction === 'outbound' &&
        t.agentRole === ENGAGEMENT_AGENT_ROLE &&
        (!lastInboundAt || t.occurredAt > lastInboundAt),
    ).length;
    const cadenceStep: 0 | 1 | 2 | 3 =
      engagementOutboundsAfterAnchor >= 3 ? 3 : (engagementOutboundsAfterAnchor as 0 | 1 | 2);

    if (cadenceStep === 3) {
      // Already nudged twice + escalated once — nothing more to do here. The
      // dormant transition should have happened on the step-2 evaluation;
      // if the lead is still NOT dormant, log and move on (operator will
      // see the divergence in admin).
      return { ok: true, result: { skipped: 'cadence-exhausted' } };
    }

    const threshold = THRESHOLD_HOURS[cadenceStep];
    const elapsedHours = (now.getTime() - lastActivityAt.getTime()) / HOUR_MS;
    if (elapsedHours < threshold) {
      return {
        ok: true,
        result: {
          skipped: 'threshold-not-reached',
          cadenceStep,
          elapsedHours: Math.round(elapsedHours * 10) / 10,
          thresholdHours: threshold,
        },
      };
    }

    // Step 2 → escalation path. No customer message. Done BEFORE the
    // quiet-hours gate: escalations are internal (writes a row + emits to
    // the Reporter Agent's queue, which itself respects WAHA delivery
    // semantics) and should not be deferred past 9am Monday just because
    // a customer hit 7d on a Saturday.
    if (cadenceStep === 2) {
      return this.escalateAndMarkDormant({ lead, now });
    }

    // Steps 0 + 1 → customer-facing nudges. Quiet hours apply.
    if (isQuietNow(now)) {
      return {
        ok: true,
        result: { skipped: 'quiet-hours', cadenceStep },
      };
    }

    // Anti-spam: any outbound (Sales Agent reply, prior nudge, etc.) within
    // the threshold suppresses this tick. Strict — we'd rather skip a tick
    // than pile a nudge on top of an active conversation.
    const lastOutbound = recentTurnsDesc.find((t) => t.direction === 'outbound');
    if (lastOutbound) {
      const outboundElapsedHours = (now.getTime() - lastOutbound.occurredAt.getTime()) / HOUR_MS;
      if (outboundElapsedHours < threshold) {
        return {
          ok: true,
          result: {
            skipped: 'anti-spam-recent-outbound',
            cadenceStep,
            outboundElapsedHours: Math.round(outboundElapsedHours * 10) / 10,
            thresholdHours: threshold,
          },
        };
      }
    }

    return this.sendNudge({
      lead,
      step: (cadenceStep + 1) as EngagementStep, // step 0 → nudge 1; step 1 → nudge 2
      recentTurnsDesc,
    });
  }

  /**
   * Generate + send the nudge for the chosen step, then log the outbound
   * turn (via `sendViaChannel`, which writes conversation_turns for us).
   * The outbound's `agent_role = 'engagement-agent'` is what the next tick
   * uses to derive the new cadence step — closing the loop.
   */
  private async sendNudge(args: {
    lead: typeof leads.$inferSelect;
    step: EngagementStep;
    recentTurnsDesc: Awaited<ReturnType<typeof listTurns>>;
  }): Promise<MessageHandlerResult> {
    const { lead, step, recentTurnsDesc } = args;
    // Channel selection: mirror the Sales Agent's heuristic — most recent
    // turn's channel wins, WhatsApp as the default for fresh leads.
    const channel: ChannelId = (recentTurnsDesc[0]?.channel as ChannelId | undefined) ?? 'whatsapp';
    const resolved = await this.resolveCustomerAndContact(lead, channel);
    if (!resolved.contactRef) {
      logger.warn(
        { leadId: lead.id, channel, instanceId: this.instanceId, step },
        'engagement-agent: no contact address for channel; skipping nudge',
      );
      return {
        ok: true,
        result: { skipped: 'no-contact-address', channel, cadenceStep: step - 1 },
      };
    }

    const recentSnippets = recentTurnsDesc
      .slice(0, SNIPPET_TURN_LIMIT)
      .reverse()
      .map((t) => ({ direction: t.direction, content: t.content }));
    const fullName = decryptPII(resolved.customer.fullName) ?? '';
    const firstName = (fullName.split(' ')[0] ?? '').trim() || null;
    const nudgeInput: NudgeGenInput = {
      step,
      firstName,
      productLine: (lead.productLine ?? 'car') as 'scooter' | 'car',
      recentSnippets,
    };
    const nudge = await generateNudgeText(nudgeInput);

    const send = await sendViaChannel({
      db: this.db,
      customerId: resolved.customer.id,
      leadId: lead.id,
      to: resolved.contactRef,
      body: [{ type: 'text', text: nudge.text }],
      agentRole: this.role,
      agentInstance: this.instanceId,
      correlationId: lead.id,
    });

    logger.info(
      {
        leadId: lead.id,
        customerId: resolved.customer.id,
        instanceId: this.instanceId,
        channel,
        cadenceStep: step,
        nudgeSource: nudge.source,
        externalId: send.receipt.externalId,
      },
      'engagement-agent: nudge sent',
    );

    return {
      ok: true,
      result: {
        sent: true,
        cadenceStep: step,
        channel,
        nudgeSource: nudge.source,
        externalId: send.receipt.externalId,
      },
    };
  }

  /**
   * Step 2 (T+7d): create a human action so Ridaa/Achraf are pinged in
   * both the admin AND the WhatsApp group (Reporter Agent picks up the
   * REQUESTED intent), then mark the lead `dormant` so subsequent ticks
   * exclude it (status filter in the candidate query + the agent's own
   * ineligibility check).
   *
   * Two writes in sequence — we accept the small race window where the
   * status flip lands but the human-action emit fails. In that case the
   * lead is dormant + escalation lost; the BullMQ retry on the
   * HUMAN_ACTION.REQUESTED enqueue limits this, and the admin will still
   * surface the dormant lead in the lead board (option D).
   */
  private async escalateAndMarkDormant(args: {
    lead: typeof leads.$inferSelect;
    now: Date;
  }): Promise<MessageHandlerResult> {
    const { lead, now } = args;
    const action = await humanActions.createAction(this.db, {
      createdByAgent: `${this.role}#${this.instanceId}`,
      correlationId: lead.id,
      intent: 'LEAD_DORMANT',
      severity: 2,
      summary:
        `Lead ${lead.id.slice(0, 8)} silencieux depuis 7 jours malgré 2 relances. ` +
        `Marqué dormant. Souhaitez-vous reprendre contact manuellement ou clôturer ?`,
      options: [
        { id: 'manual_followup', label: 'Reprendre contact manuellement', kind: 'approve' },
        { id: 'close_lost', label: 'Clôturer (lead perdu)', kind: 'reject' },
        { id: 'wait', label: 'Laisser dormant', kind: 'approve' },
      ],
    });

    await this.db
      .update(leads)
      .set({ status: 'dormant', updatedAt: now })
      .where(eq(leads.id, lead.id));

    await sendMessage(
      { db: this.db },
      {
        fromRole: this.role,
        fromInstance: this.instanceId,
        toRole: 'human-router',
        intent: 'HUMAN_ACTION.REQUESTED',
        payload: {
          humanActionId: action.id,
          severity: 2,
          summary: action.summary,
        },
        correlationId: lead.id,
        requiresHuman: true,
        priority: 3,
      },
    );

    logger.info(
      {
        leadId: lead.id,
        instanceId: this.instanceId,
        humanActionId: action.id,
      },
      'engagement-agent: lead marked dormant + escalated to human',
    );

    return {
      ok: true,
      result: {
        escalated: true,
        leadStatus: 'dormant',
        humanActionId: action.id,
      },
    };
  }

  /**
   * Resolve `(customer, ContactRef)` for the given lead + channel. Same
   * shape as the Sales Agent's helper; replicated here to keep the
   * engagement agent free of cross-agent imports. Returns
   * `contactRef: null` when the channel-appropriate address is missing.
   */
  private async resolveCustomerAndContact(
    lead: typeof leads.$inferSelect,
    channel: ChannelId,
  ): Promise<{
    customer: typeof customers.$inferSelect;
    contactRef: ContactRef | null;
  }> {
    if (!lead.customerId) {
      throw new Error(`Lead ${lead.id} has no customer_id`);
    }
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, lead.customerId))
      .limit(1);
    if (!customer) {
      throw new Error(`Customer ${lead.customerId} not found`);
    }
    let address: string | null = null;
    switch (channel) {
      case 'whatsapp':
      case 'sms':
      case 'voice':
        address = decryptPII(customer.phone);
        break;
      case 'email':
        address = decryptPII(customer.email);
        break;
    }
    if (!address) return { customer, contactRef: null };
    const fullName = decryptPII(customer.fullName);
    const contactRef: ContactRef = {
      channel,
      address,
      ...(fullName ? { displayName: fullName } : {}),
    };
    return { customer, contactRef };
  }
}
