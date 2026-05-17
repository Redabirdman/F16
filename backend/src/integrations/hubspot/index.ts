/**
 * HubSpot integration barrel — REST client + dual-write worker (M5.T2).
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
  type HubSpotSyncWorkerOptions,
} from './dual-write.js';
