/**
 * @atlasent/sdk — execution-time authorization for AI agents.
 *
 * Two canonical endpoints:
 *   - {@link AtlaSentClient.evaluate}     → POST /v1-evaluate
 *   - {@link AtlaSentClient.verifyPermit} → POST /v1-verify-permit
 *
 * Plus convenience methods that compose them:
 *   - {@link AtlaSentClient.gate}      — evaluate + verify (throws on deny)
 *   - {@link AtlaSentClient.authorize} — evaluate (+ optional verify), result-based
 *
 * And module-level helpers backed by a lazily-initialized default
 * client — see {@link configure}, {@link authorize}, {@link gate}.
 */

export { AtlaSentClient } from "./client.js";
export { TTLCache, type TTLCacheOptions } from "./cache.js";
export {
  AtlaSentError,
  PermissionDeniedError,
  type AtlaSentErrorCode,
  type AtlaSentErrorInit,
  type PermissionDeniedErrorInit,
} from "./errors.js";
export type {
  AtlaSentClientOptions,
  AuthorizationResult,
  AuthorizeRequest,
  Decision,
  EvaluateCache,
  EvaluateRequest,
  EvaluateResponse,
  GateResult,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";
export {
  authorize,
  configure,
  evaluate,
  gate,
  resetDefaultClient,
  verifyPermit,
} from "./authorize.js";
