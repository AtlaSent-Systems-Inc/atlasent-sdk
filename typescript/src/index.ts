/**
 * @atlasent/sdk — execution-time authorization for AI agents.
 *
 * Three methods on {@link AtlaSentClient}:
 *   - {@link AtlaSentClient.evaluate}      → POST /v1-evaluate
 *   - {@link AtlaSentClient.verifyPermit}  → POST /v1-verify-permit
 *   - {@link AtlaSentClient.evaluateStream} → POST /v1-evaluate-stream (SSE)
 *
 * Offline audit verification (no network):
 *   - {@link verifyBundle} — validate an Ed25519-signed audit export
 */

export { AtlaSentClient } from "./client.js";
export { verifyBundle } from "./audit.js";
export {
  AtlaSentError,
  type AtlaSentErrorCode,
  type AtlaSentErrorInit,
} from "./errors.js";
export type {
  AtlaSentClientOptions,
  AuditEvent,
  BundleVerifyResult,
  Decision,
  EvaluateRequest,
  EvaluateResponse,
  EvaluateStreamEvent,
  StreamEventType,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";
