/**
 * `@atlasent/temporal-preview` — PREVIEW.
 *
 * DO NOT USE IN PRODUCTION. See `./README.md`.
 */

// Activity-side: wraps an Activity function with `protect()`.
export {
  withAtlaSentActivity,
  type AtlaSentActivityOptions,
  type ProtectedActivity,
} from "./withAtlaSentActivity.js";

// Workflow-side: signal handler for bulk revoke. Imports
// `@temporalio/workflow` — only safe in workflow code, NOT
// activity code (Temporal's runtime enforces the split).
export {
  installRevokeHandler,
  RevokeAtlaSentPermitsSignal,
  type BulkRevokeActivities,
  type InstallRevokeHandlerOptions,
  type RevokeAtlaSentPermitsArgs,
} from "./workflowSignals.js";

// Activity-side: stub bulk-revoke activity. v2 server endpoint
// required; customers can override via `installRevokeHandler({
// activities: ... })`.
export {
  bulkRevokeAtlaSentPermits,
  BulkRevokeNotImplementedError,
} from "./bulkRevokeActivity.js";
