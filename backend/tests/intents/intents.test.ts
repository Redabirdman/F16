import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

// Import the barrel once to trigger all initial intent registrations.
import * as intents from '../../src/intents/index.js';

const {
  registerIntent,
  getIntentSchema,
  listIntents,
  validateIntentPayload,
  __resetIntentsForTests,
} = intents;

/**
 * After __resetIntentsForTests() the registry Map is empty but the ES-module
 * cache still holds the domain modules — their top-level registerIntent()
 * calls won't run again. We replay them by hand against the same registry
 * via getIntentSchema's underlying Map. The simplest replay is to re-call
 * each domain module's `registerIntent` indirectly by reading the schemas
 * we already imported and re-registering them.
 *
 * Concretely: the barrel re-exports every `<Name>Payload` schema. Pair the
 * intent string with its schema by deriving the name from the export.
 */
const KNOWN_INTENTS: ReadonlyArray<[string, z.ZodTypeAny]> = [
  ['LEAD.NEW', intents.LeadNewPayload],
  ['LEAD.PROFILE_UPDATED', intents.LeadProfileUpdatedPayload],
  ['LEAD.SCORED', intents.LeadScoredPayload],
  ['LEAD.STATUS_CHANGED', intents.LeadStatusChangedPayload],
  ['CUSTOMER.MESSAGE_RECEIVED', intents.CustomerMessageReceivedPayload],
  ['CUSTOMER.MESSAGE_SENT', intents.CustomerMessageSentPayload],
  ['CUSTOMER.OCR_REQUESTED', intents.CustomerOcrRequestedPayload],
  ['CUSTOMER.OCR_READY', intents.CustomerOcrReadyPayload],
  ['CUSTOMER.FOLLOWUP_DUE', intents.CustomerFollowupDuePayload],
  ['CUSTOMER.CHANNEL_SWITCH_REQUESTED', intents.CustomerChannelSwitchRequestedPayload],
  ['QUOTE.REQUESTED', intents.QuoteRequestedPayload],
  ['QUOTE.CONFIRM_REQUESTED', intents.QuoteConfirmRequestedPayload],
  ['QUOTE.READY', intents.QuoteReadyPayload],
  ['QUOTE.PREVIEW_READY', intents.QuotePreviewReadyPayload],
  ['QUOTE.FAILED', intents.QuoteFailedPayload],
  ['QUOTE.DELIVERED', intents.QuoteDeliveredPayload],
  ['QUOTE.ACCEPTED', intents.QuoteAcceptedPayload],
  ['QUOTE.REJECTED', intents.QuoteRejectedPayload],
  ['PAYMENT.PENDING_HUMAN', intents.PaymentPendingHumanPayload],
  ['CONTRACT.PENDING_HUMAN', intents.ContractPendingHumanPayload],
  ['CONTRACT.ISSUED', intents.ContractIssuedPayload],
  ['VOICE.CALL_SCHEDULED', intents.VoiceCallScheduledPayload],
  ['VOICE.CALL_STARTED', intents.VoiceCallStartedPayload],
  ['VOICE.CALL_COMPLETED', intents.VoiceCallCompletedPayload],
  ['VOICE.CALL_FAILED', intents.VoiceCallFailedPayload],
  ['CREATIVE.BRIEF_REQUESTED', intents.CreativeBriefRequestedPayload],
  ['CREATIVE.PROMPT_READY', intents.CreativePromptReadyPayload],
  ['CREATIVE.GENERATED', intents.CreativeGeneratedPayload],
  ['CAMPAIGN.HUMAN_APPROVAL_REQUESTED', intents.CampaignHumanApprovalRequestedPayload],
  ['CAMPAIGN.HUMAN_APPROVAL_RESOLVED', intents.CampaignHumanApprovalResolvedPayload],
  ['CAMPAIGN.LAUNCHED', intents.CampaignLaunchedPayload],
  ['CAMPAIGN.FATIGUE_DETECTED', intents.CampaignFatigueDetectedPayload],
  ['AUDIENCE.REFRESH_REQUESTED', intents.AudienceRefreshRequestedPayload],
  ['AUDIENCE.REFRESHED', intents.AudienceRefreshedPayload],
  ['KNOWLEDGE.REINDEX_REQUESTED', intents.KnowledgeReindexRequestedPayload],
  ['KNOWLEDGE.REINDEXED', intents.KnowledgeReindexedPayload],
  ['KNOWLEDGE.DRIFT_DETECTED', intents.KnowledgeDriftDetectedPayload],
  ['COMPLIANCE.CHECK_REQUESTED', intents.ComplianceCheckRequestedPayload],
  ['COMPLIANCE.PASSED', intents.CompliancePassedPayload],
  ['COMPLIANCE.BLOCKED', intents.ComplianceBlockedPayload],
  ['HUMAN_ACTION.REQUESTED', intents.HumanActionRequestedPayload],
  ['HUMAN_ACTION.RESOLVED', intents.HumanActionResolvedPayload],
  ['SESSION.HEARTBEAT', intents.SessionHeartbeatPayload],
  ['SESSION.LOGGED_OUT', intents.SessionLoggedOutPayload],
  ['ORG.STATE_TICK', intents.OrgStateTickPayload],
  ['ENGAGEMENT.TICK', intents.EngagementTickPayload],
];

function repopulateRegistry(): void {
  for (const [name, schema] of KNOWN_INTENTS) {
    registerIntent(name, schema);
  }
}

describe('intent registry', () => {
  it('registerIntent throws on duplicate names', () => {
    expect(() => registerIntent('LEAD.NEW', z.object({ leadId: z.string().uuid() }))).toThrow(
      /already registered/,
    );
  });

  it('getIntentSchema returns the schema for a known intent', () => {
    const schema = getIntentSchema('LEAD.NEW');
    expect(schema).toBeDefined();
    // Spot-check that it actually parses something.
    expect(
      schema?.safeParse({
        leadId: '00000000-0000-4000-8000-000000000000',
        source: 'website',
        productLine: 'scooter',
      }).success,
    ).toBe(true);
  });

  it('getIntentSchema returns undefined for unknown intents', () => {
    expect(getIntentSchema('NOPE.WHAT')).toBeUndefined();
  });

  it('listIntents returns all intent names sorted', () => {
    const names = listIntents();
    expect(names.length).toBeGreaterThanOrEqual(25);

    // Sorted (ascending).
    const copy = [...names].sort();
    expect(names).toEqual(copy);

    // No duplicates.
    expect(new Set(names).size).toBe(names.length);

    // Spot-check coverage across domains.
    for (const expected of [
      'LEAD.NEW',
      'LEAD.PROFILE_UPDATED',
      'LEAD.SCORED',
      'LEAD.STATUS_CHANGED',
      'CUSTOMER.MESSAGE_RECEIVED',
      'CUSTOMER.MESSAGE_SENT',
      'CUSTOMER.OCR_REQUESTED',
      'CUSTOMER.OCR_READY',
      'CUSTOMER.FOLLOWUP_DUE',
      'CUSTOMER.CHANNEL_SWITCH_REQUESTED',
      'QUOTE.REQUESTED',
      'QUOTE.READY',
      'QUOTE.DELIVERED',
      'QUOTE.ACCEPTED',
      'QUOTE.REJECTED',
      'PAYMENT.PENDING_HUMAN',
      'CONTRACT.PENDING_HUMAN',
      'CONTRACT.ISSUED',
      'VOICE.CALL_SCHEDULED',
      'VOICE.CALL_STARTED',
      'VOICE.CALL_COMPLETED',
      'VOICE.CALL_FAILED',
      'CREATIVE.BRIEF_REQUESTED',
      'CREATIVE.PROMPT_READY',
      'CREATIVE.GENERATED',
      'CAMPAIGN.HUMAN_APPROVAL_REQUESTED',
      'CAMPAIGN.HUMAN_APPROVAL_RESOLVED',
      'CAMPAIGN.LAUNCHED',
      'CAMPAIGN.FATIGUE_DETECTED',
      'AUDIENCE.REFRESH_REQUESTED',
      'AUDIENCE.REFRESHED',
      'KNOWLEDGE.REINDEX_REQUESTED',
      'KNOWLEDGE.REINDEXED',
      'KNOWLEDGE.DRIFT_DETECTED',
      'COMPLIANCE.CHECK_REQUESTED',
      'COMPLIANCE.PASSED',
      'COMPLIANCE.BLOCKED',
      'HUMAN_ACTION.REQUESTED',
      'HUMAN_ACTION.RESOLVED',
      'SESSION.HEARTBEAT',
      'SESSION.LOGGED_OUT',
      'ORG.STATE_TICK',
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe('validateIntentPayload', () => {
  it('returns the parsed payload on success', () => {
    const result = validateIntentPayload('LEAD.NEW', {
      leadId: '11111111-1111-4111-8111-111111111111',
      source: 'website',
      productLine: 'scooter',
    }) as { leadId: string; source: string; productLine: string };

    expect(result.leadId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.source).toBe('website');
    expect(result.productLine).toBe('scooter');
  });

  it('throws on invalid payload but does NOT echo the payload', () => {
    const secretEmail = 'leak@example.com';
    let caught: Error | undefined;
    try {
      validateIntentPayload('LEAD.NEW', {
        leadId: 'not-a-uuid',
        source: 'website',
        productLine: 'scooter',
        secret: secretEmail,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toMatch(/LEAD\.NEW/);
    expect(caught?.message).not.toContain(secretEmail);
  });

  it('throws on unknown intent name', () => {
    expect(() => validateIntentPayload('UNKNOWN.INTENT', {})).toThrow(/Unknown intent/);
  });

  it('rejects bad leadId (not uuid) for LEAD.NEW', () => {
    expect(() =>
      validateIntentPayload('LEAD.NEW', {
        leadId: 'definitely-not-uuid',
        source: 'website',
        productLine: 'scooter',
      }),
    ).toThrow();
  });

  it('rejects out-of-range score for LEAD.SCORED', () => {
    expect(() =>
      validateIntentPayload('LEAD.SCORED', {
        leadId: '11111111-1111-4111-8111-111111111111',
        score: 150,
        opening: 'hi',
        channel: 'whatsapp',
      }),
    ).toThrow();
  });

  it('rejects missing required field on QUOTE.REQUESTED', () => {
    expect(() =>
      validateIntentPayload('QUOTE.REQUESTED', {
        quoteId: '11111111-1111-4111-8111-111111111111',
        // customerId intentionally missing
        leadId: '22222222-2222-4222-8222-222222222222',
        product: 'scooter',
        productVariant: 'X',
        formData: {},
      }),
    ).toThrow();
  });

  it('rejects invalid kind enum on CAMPAIGN.HUMAN_APPROVAL_REQUESTED', () => {
    expect(() =>
      validateIntentPayload('CAMPAIGN.HUMAN_APPROVAL_REQUESTED', {
        campaignId: '11111111-1111-4111-8111-111111111111',
        kind: 'something-else',
        humanActionId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toThrow();
  });
});

describe('__resetIntentsForTests', () => {
  // Snapshot current registry contents so we can restore them after this block.
  let snapshot: string[] = [];

  beforeEach(() => {
    snapshot = listIntents();
  });

  afterEach(() => {
    // Restore registry for any subsequent test files.
    if (listIntents().length !== snapshot.length) {
      __resetIntentsForTests();
      repopulateRegistry();
    }
    expect(listIntents().sort()).toEqual(snapshot);
  });

  it('clears the registry and re-population re-registers everything', () => {
    __resetIntentsForTests();
    expect(listIntents()).toEqual([]);

    // The barrel modules already executed once and their side effects don't
    // re-run on a re-import (ESM module cache). Simulate "fresh import" by
    // replaying registration via the same registerIntent() API the modules
    // use at load time.
    repopulateRegistry();

    const after = listIntents();
    expect(after.length).toBe(snapshot.length);
    expect(after.sort()).toEqual(snapshot);
  });
});
