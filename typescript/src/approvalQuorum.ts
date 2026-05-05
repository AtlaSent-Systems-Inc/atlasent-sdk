/**
 * Public types for the AtlaSent **Approval Quorum** — the additive
 * layer that lets multiple individually-trustworthy approvals be
 * combined into a single quorum package.
 *
 * Wire-stable as `approval_quorum.v1`. The contract lives in
 * `contract/schemas/approval-quorum.schema.json`. Verification is
 * server-side inside `/v1-evaluate`; the SDK exposes the types so
 * callers can construct a quorum payload before submitting.
 *
 * Important invariant (locked): quorum does NOT relax artifact
 * verification. Every approval inside a quorum package must first
 * pass the locked single-approval verifier (artifact signature +
 * identity assertion + every binding) BEFORE quorum-level policy is
 * evaluated. If any single approval fails, the whole package is
 * denied with that approval's exact reason — no fallthrough.
 */

import type { ApprovalArtifactV1 } from "./approvalArtifact.js";

/** Independence constraints on a quorum policy. Duplicate
 *  `reviewer.principal_id` is ALWAYS rejected regardless of these
 *  flags; these strengthen the requirement further. */
export interface QuorumIndependence {
  /** When true, requires distinct *approval-issuer* identities so
   *  two tokens minted by the same QA system don't count separately
   *  even if signed for different reviewers. */
  distinct_approval_issuers?: boolean;
  /** When true, requires distinct *identity-issuer* identities so
   *  collusion between IdPs vouching for the same effective
   *  reviewer pool is harder. */
  distinct_identity_issuers?: boolean;
}

/** A single role × count requirement in a quorum policy. */
export interface QuorumRoleRequirement {
  role: string;
  /** Minimum number of approvals carrying this role. */
  min: number;
}

/** Quorum policy describing what counts as passing. */
export interface QuorumPolicy {
  /** Minimum total approvals (regardless of role). */
  required_count: number;
  /** OPTIONAL role-mix requirements; each is checked independently. */
  required_role_mix?: QuorumRoleRequirement[];
  /** Independence constraints. Duplicate principal_id is always
   *  rejected; these flags additionally require distinct issuers. */
  independence?: QuorumIndependence;
  /** OPTIONAL package-level staleness window in seconds. Layered on
   *  top of each artifact's own `expires_at` — both must be in the
   *  future. */
  max_age_seconds?: number;
}

/** A signed quorum package carrying multiple approvals. */
export interface ApprovalQuorumV1 {
  version: "approval_quorum.v1";
  tenant_id: string;
  /** Canonical action hash. Must match every approval's action_hash
   *  and the verifier's expected_action_hash. */
  action_hash: string;
  environment: string;
  issued_at: string;
  policy: QuorumPolicy;
  /** The approvals being counted. Each is a full ApprovalArtifactV1
   *  carrying its own identity_assertion. */
  approvals: ApprovalArtifactV1[];
}

/** Cryptographic proof material returned on a passing quorum.
 *  Persisted on the audit row so external auditors can reconstruct
 *  WHO approved together without per-approval row joins. */
export interface QuorumProof {
  /** sha256(canonical({ version, tenant_id, action_hash, environment,
   *  issued_at, policy, sorted approval_hashes })). */
  quorum_hash: string;
  /** approval_id of every counted approval, in the order they were
   *  submitted. */
  approval_ids: string[];
}
