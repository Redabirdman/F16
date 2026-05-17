import { z } from 'zod';
import { registerIntent } from './_registry.js';

export const CreativeBriefRequestedPayload = registerIntent(
  'CREATIVE.BRIEF_REQUESTED',
  z.object({
    briefId: z.string().uuid(),
    productLine: z.enum(['scooter', 'car']),
    angle: z.string(),
    psychology: z.string(),
  }),
);

export const CreativePromptReadyPayload = registerIntent(
  'CREATIVE.PROMPT_READY',
  z.object({
    briefId: z.string().uuid(),
    prompt: z.string(),
    brandSpec: z.record(z.string(), z.unknown()),
  }),
);

export const CreativeGeneratedPayload = registerIntent(
  'CREATIVE.GENERATED',
  z.object({
    briefId: z.string().uuid(),
    creativeId: z.string().uuid(),
    fileUrl: z.string().url(),
  }),
);

export const CampaignHumanApprovalRequestedPayload = registerIntent(
  'CAMPAIGN.HUMAN_APPROVAL_REQUESTED',
  z.object({
    campaignId: z.string().uuid(),
    kind: z.enum(['creative', 'budget', 'audience']),
    humanActionId: z.string().uuid(),
  }),
);

export const CampaignHumanApprovalResolvedPayload = registerIntent(
  'CAMPAIGN.HUMAN_APPROVAL_RESOLVED',
  z.object({
    campaignId: z.string().uuid(),
    choice: z.enum(['approve', 'reject', 'revise']),
  }),
);

export const CampaignLaunchedPayload = registerIntent(
  'CAMPAIGN.LAUNCHED',
  z.object({
    campaignId: z.string().uuid(),
    metaCampaignId: z.string(),
  }),
);

export const CampaignFatigueDetectedPayload = registerIntent(
  'CAMPAIGN.FATIGUE_DETECTED',
  z.object({
    adId: z.string().uuid(),
    ctrDropPct: z.number(),
    frequency: z.number().nonnegative(),
  }),
);

export const AudienceRefreshRequestedPayload = registerIntent(
  'AUDIENCE.REFRESH_REQUESTED',
  z.object({
    campaignId: z.string().uuid(),
    seedCohort: z.literal('closed_won_last_90d'),
  }),
);

export const AudienceRefreshedPayload = registerIntent(
  'AUDIENCE.REFRESHED',
  z.object({
    campaignId: z.string().uuid(),
    lookalikeAudienceId: z.string(),
  }),
);
