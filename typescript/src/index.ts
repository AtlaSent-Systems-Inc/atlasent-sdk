/**
 * @atlasent/sdk — execution-time authorization for AI agents.
 *
 * Primary API is the default export:
 *
 * ```ts
 * import atlasent from "@atlasent/sdk";
 *
 * const permit = await atlasent.protect({
 *   agent: "deploy-bot",
 *   action: "deploy_to_production",
 *   context: { commit, approver },
 * });
 * ```
 *
 * Named exports remain available for the lower-level
 * {@link AtlaSentClient} and the error taxonomy.
 */

import { AtlaSentClient } from "./client.js";
import { verifyBundle } from "./auditBundle.js";
import { AtlaSentDeniedError, AtlaSentError } from "./errors.js";
import { configure, protect } from "./protect.js";
import { withPermit } from "./withPermit.js";

export { AtlaSentClient } from "./client.js";
export {
  AtlaSentDeniedError,
  AtlaSentError,
  type AtlaSentDecision,
  type AtlaSentDeniedErrorInit,
  type AtlaSentErrorCode,
  type AtlaSentErrorInit,
} from "./errors.js";
export {
  configure,
  protect,
  type ConfigureOptions,
  type Permit,
  type ProtectRequest,
} from "./protect.js";
export { withPermit } from "./withPermit.js";
export type {
  ApiKeySelfResponse,
  AtlaSentClientOptions,
  AuditEventsResult,
  AuditExportRequest,
  AuditExportResult,
  Decision,
  EvaluateRequest,
  EvaluateResponse,
  RateLimitState,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";
export {
  canonicalJSON,
  signedBytesFor,
  verifyAuditBundle,
  verifyBundle,
  type AuditBundle,
  type BundleVerificationResult,
  type VerifyBundleOptions,
  type VerifyKey,
} from "./auditBundle.js";
export type {
  AuditDecision,
  AuditEvent,
  AuditEventsPage,
  AuditEventsQuery,
  AuditExport,
  AuditExportSignatureStatus,
} from "./audit.js";
export {
  DEFAULT_RETRY_POLICY,
  computeBackoffMs,
  hasAttemptsLeft,
  isRetryable,
  mergePolicy,
  type RetryPolicy,
} from "./retry.js";

/**
 * Default export. The opinionated, category-defining entry point:
 *
 * ```ts
 * import atlasent from "@atlasent/sdk";
 * await atlasent.protect({ ... });
 * ```
 */
const atlasent = {
  protect,
  withPermit,
  configure,
  verifyBundle,
  AtlaSentClient,
  AtlaSentError,
  AtlaSentDeniedError,
} as const;

export default atlasent;
