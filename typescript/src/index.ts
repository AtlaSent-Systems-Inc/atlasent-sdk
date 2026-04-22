/**
 * @atlasent/sdk — execution-time authorization for AI agents.
 *
 * Three methods:
 *   - {@link AtlaSentClient.evaluate}     → POST /v1-evaluate
 *   - {@link AtlaSentClient.verifyPermit} → POST /v1-verify-permit
 *   - {@link AtlaSentClient.exportAudit}  → POST /v1-export-audit
 *
 * Plus {@link verifyBundle}, an offline Ed25519 verifier for exports
 * returned by `exportAudit`.
 */

export { AtlaSentClient } from "./client.js";
export {
  AtlaSentError,
  type AtlaSentErrorCode,
  type AtlaSentErrorInit,
} from "./errors.js";
export type {
  AtlaSentClientOptions,
  Decision,
  EvaluateRequest,
  EvaluateResponse,
  ExportAuditHead,
  ExportAuditRequest,
  ExportAuditResponse,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";
export {
  verifyBundle,
  type VerifyBundleOptions,
  type VerifyBundleResult,
} from "./verify-export.js";
