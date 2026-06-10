/**
 * HubSpot integration barrel — REST client + dual-write worker (M5.T2) +
 * Phase 3 activity timeline.
 */
export {
  HubSpotClient,
  HubSpotApiError,
  type HubSpotClientOptions,
  type UpsertContactInput,
  type UpsertContactOutput,
  type CreateDealInput,
  type CreateDealOutput,
  type DefaultPipelineAndStage,
} from './client.js';

export {
  startHubSpotSyncWorker,
  handleLeadNew,
  reconcileLead,
  type HubSpotSyncWorkerOptions,
} from './dual-write.js';

export { ensureSchema, ASSURYAL_PIPELINE_LABEL, type ResolvedSchema } from './schema.js';

export {
  stageKeyForStatus,
  buildContactProps,
  buildDealProps,
  type LeadStatus,
  type StageKey,
  type MirrorInput,
} from './mirror-map.js';

export {
  mapActivityToEngagement,
  type F16ActivityEvent,
  type VoiceCallEndedEvent,
  type WhatsAppTurnEvent,
  type EngagementFollowupEvent,
  type HumanActionResolvedEvent,
  type EngagementSpec,
  type NoteSpec,
  type CallSpec,
  type CommunicationSpec,
} from './activity-map.js';

export {
  emitHubSpotActivity,
  isActivityEnabled,
  handleLogActivity,
  type EmitHubSpotActivityInput,
  type ActivityWorkerOptions,
} from './activity-worker.js';
