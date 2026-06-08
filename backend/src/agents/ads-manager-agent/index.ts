/**
 * Ads Manager Agent (M12 Phase 2) — barrel.
 *
 * The "Ad Expert": syncs the Meta mirror, detects fatigue, and runs the daily
 * leads-per-spend learning loop. Phase 3 adds campaign drafting + the WhatsApp
 * approval gate + Graph launch on top of this.
 */
export { syncAdAccount, type SyncResult, type SyncOptions } from './sync.js';
export { scanAndFlagFatigue, type FatigueOptions, type FatigueScanResult } from './fatigue.js';
export {
  computeAdPerformance,
  runLearningSnapshot,
  type AdPerformance,
  type LearningSnapshotResult,
} from './learning.js';
export {
  startAdsPoller,
  startAdsLearningScheduler,
  type AdsPollerOptions,
  type AdsPollerHandle,
  type AdsLearningOptions,
  type AdsLearningHandle,
} from './poller.js';
export { assembleCampaignDraft, type AssembleDraftOptions, type DraftResult } from './drafting.js';
export { launchCampaignDraft, type LaunchOptions, type LaunchResult } from './launch.js';
export {
  scanDraftApprovals,
  startDraftApprovalScanner,
  type DraftApprovalOptions,
  type DraftApprovalSchedulerHandle,
  type ApprovalScanResult,
} from './approval.js';
