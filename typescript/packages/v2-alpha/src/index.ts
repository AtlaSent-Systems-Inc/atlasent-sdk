/**
 * `@atlasent/sdk-v2-alpha` — alpha release of the v2 AtlaSent SDK.
 *
 * Surfaces are usable and tested. The API is subject to change between
 * alpha releases as the v2 wire contract stabilises — pin to an exact
 * version (e.g. `2.0.0-alpha.0`) if you depend on this package from
 * production code. See `./README.md`.
 */

export { canonicalizePayload } from "./canonicalize.js";
export { hashPayload } from "./hash.js";
export type {
  ConsumeExecutionStatus,
  ConsumeRequest,
  ConsumeResponse,
  Proof,
  ProofCheckName,
  ProofDecision,
  ProofExecutionStatus,
  ProofFailureReason,
  ProofVerificationCheck,
  ProofVerificationResult,
  ProofVerificationStatus,
} from "./types.js";
