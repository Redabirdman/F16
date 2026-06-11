/**
 * HubSpot activity-map (Phase 3) — pure F16 event → HubSpot engagement spec.
 *
 * Takes a typed F16ActivityEvent and returns an EngagementSpec that the
 * activity worker hands directly to the right HubSpotClient method.
 *
 * No IO, no side effects, no logger calls — trivially unit-testable.
 * PII note: `body` fields carry message content. The caller (activity worker)
 * is responsible for not logging them; this layer just maps them faithfully.
 */

// ---------------------------------------------------------------------------
// Input event union (one variant per F16 hook point)
// ---------------------------------------------------------------------------

/** A voice call ended. transcriptSummary is a brief human-readable recap. */
export interface VoiceCallEndedEvent {
  kind: 'voice-call-ended';
  customerId: string;
  leadId?: string;
  /** Duration of the call in milliseconds. */
  durationMs?: number;
  /** Short LLM-generated or concatenated transcript summary (no raw PII log). */
  transcriptSummary: string;
  timestamp: Date;
}

/** A WhatsApp turn (inbound message from customer OR outbound from agent). */
export interface WhatsAppTurnEvent {
  kind: 'whatsapp-turn';
  customerId: string;
  leadId?: string;
  /** The message body (customer or agent text). */
  body: string;
  direction: 'inbound' | 'outbound';
  timestamp: Date;
}

/** The engagement agent sent a follow-up nudge to the customer. */
export interface EngagementFollowupEvent {
  kind: 'engagement-followup';
  customerId: string;
  leadId?: string;
  /** The nudge text that was sent. */
  nudgeText: string;
  /** Which cadence step fired (0 = 24 h, 1 = 72 h, 2 = 7 d escalation). */
  step: 0 | 1 | 2;
  timestamp: Date;
}

/** A human-action was resolved (via admin UI or WhatsApp group). */
export interface HumanActionResolvedEvent {
  kind: 'human-action-resolved';
  customerId: string;
  leadId?: string;
  humanActionId: string;
  /** The chosen option id / label for the note body. */
  chosenOptionId: string;
  source: 'admin' | 'whatsapp';
  timestamp: Date;
}

export type F16ActivityEvent =
  | VoiceCallEndedEvent
  | WhatsAppTurnEvent
  | EngagementFollowupEvent
  | HumanActionResolvedEvent;

// ---------------------------------------------------------------------------
// Output spec union (one variant per HubSpot engagement type)
// ---------------------------------------------------------------------------

export interface NoteSpec {
  kind: 'note';
  body: string;
  timestamp: Date;
}

export interface CallSpec {
  kind: 'call';
  title: string;
  body: string;
  durationMs?: number;
  timestamp: Date;
}

export interface CommunicationSpec {
  kind: 'communication';
  channel: 'WHATS_APP' | 'SMS';
  body: string;
  timestamp: Date;
}

export type EngagementSpec = NoteSpec | CallSpec | CommunicationSpec;

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Map an F16 activity event to a HubSpot engagement spec.
 *
 * voice-call-ended   → call engagement (OUTBOUND, with duration + summary)
 * whatsapp-turn      → communication engagement (WHATS_APP channel)
 * engagement-followup → note engagement (cadence step + nudge text)
 * human-action-resolved → note engagement (resolution summary)
 */
export function mapActivityToEngagement(event: F16ActivityEvent): EngagementSpec {
  switch (event.kind) {
    case 'voice-call-ended': {
      const title = 'Appel sortant Assuryal';
      const body = event.transcriptSummary.trim() || 'Appel terminé (pas de résumé disponible).';
      const spec: CallSpec = {
        kind: 'call',
        title,
        body,
        timestamp: event.timestamp,
      };
      if (typeof event.durationMs === 'number') {
        spec.durationMs = event.durationMs;
      }
      return spec;
    }

    case 'whatsapp-turn': {
      const prefix = event.direction === 'inbound' ? '[Client] ' : '[Agent Assuryal] ';
      return {
        kind: 'communication',
        channel: 'WHATS_APP',
        body: prefix + event.body,
        timestamp: event.timestamp,
      };
    }

    case 'engagement-followup': {
      const stepLabel =
        event.step === 0
          ? 'Relance J+1 (24 h)'
          : event.step === 1
            ? 'Relance J+3 (72 h)'
            : 'Relance J+7 — escalade dormant';
      return {
        kind: 'note',
        body: `${stepLabel}\n\n${event.nudgeText}`,
        timestamp: event.timestamp,
      };
    }

    case 'human-action-resolved': {
      return {
        kind: 'note',
        body: `Action humaine résolue via ${event.source}.\nOption choisie : ${event.chosenOptionId}\nID action : ${event.humanActionId}`,
        timestamp: event.timestamp,
      };
    }
  }
}
