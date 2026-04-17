/**
 * @atlasent/sdk — execution-time authorization for AI agents.
 *
 * Two methods:
 *   - {@link AtlaSentClient.evaluate}     → POST /v1-evaluate
 *   - {@link AtlaSentClient.verifyPermit} → POST /v1-verify-permit
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
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";
