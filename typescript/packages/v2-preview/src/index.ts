/**
 * `@atlasent/sdk-v2-preview` — PREVIEW.
 *
 * DO NOT USE IN PRODUCTION. Exports here are subject to change
 * without semver discipline until v2 GA. See `./README.md`.
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
export {
  replayProofBundle,
  signedBytesForProof,
  verifyProof,
  type ProofBundleVerificationResult,
  type ProofVerificationEntry,
  type ReplayProofBundleOptions,
  type VerifyKey,
} from "./verifyProof.js";
export {
  EVALUATE_BATCH_MAX_ITEMS,
  type BatchEvaluateAllowItem,
  type BatchEvaluateDenyItem,
  type BatchEvaluateItem,
  type BatchEvaluateResponseItem,
  type BatchProofStatus,
  type EvaluateBatchRequest,
  type EvaluateBatchResponse,
} from "./batch.js";
export {
  buildEvaluateBatchRequest,
  parseEvaluateBatchResponse,
} from "./buildBatch.js";
export {
  evaluateBatchPolyfilled,
  type BatchPolyfillClient,
  type EvaluateBatchPolyfillOptions,
} from "./evaluateBatchPolyfill.js";
// PR #77 plans `@atlasent/sdk/graphql` as a sub-path import at v2 GA.
// While v2-preview is private:true, we re-export from the top level so
// existing test infra keeps working without a package.json `exports`
// map. Migration to the sub-path is a one-line README update at GA.
export {
  buildGraphQLRequest,
  GraphQLClient,
  GraphQLClientError,
  type GraphQLClientOptions,
  type GraphQLError,
  type GraphQLRequest,
  type GraphQLResponse,
} from "./graphql/index.js";
