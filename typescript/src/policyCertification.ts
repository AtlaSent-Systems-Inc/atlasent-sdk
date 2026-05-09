/**
 * Policy Certification Lifecycle.
 *
 * Wire surface: `v1-certifications` edge function (POST only).
 * Supported operations: `list_policy_versions`, `create_approval`,
 * `list_attestations`.
 *
 * The certification flow:
 * 1. A policy version is published — a `PolicyVersion` row is created.
 * 2. Designated certifiers submit `PolicyApproval` records via
 *    `create_approval`.
 * 3. Once the quorum requirement is met the version transitions to
 *    `certified`; the attestation trail is readable via
 *    `list_attestations`.
 *
 * Wire-stable as `policy_certification.v1`.
 */

/** Lifecycle status of a policy version under certification. */
export type PolicyVersionStatus =
  | "draft"       // not yet submitted for approval
  | "pending"     // submitted; awaiting approvals
  | "certified"   // quorum met; policy is live
  | "rejected"    // blocked by a reject vote
  | "superseded"  // replaced by a newer certified version
  | "archived";   // removed from active use

/** A versioned snapshot of an org's policy. */
export interface PolicyVersion {
  readonly version_id: string;
  readonly org_id: string;
  /** Human-readable policy name. */
  readonly policy_name: string;
  /** Monotonically-increasing integer per `policy_name`. */
  readonly version_number: number;
  readonly status: PolicyVersionStatus;
  /** SHA-256 hex of the policy body. */
  readonly body_hash: string;
  readonly submitted_by: string;
  readonly submitted_at: string;
  /** ISO 8601 when the last approval quorum was met (null while pending). */
  readonly certified_at: string | null;
  /** Number of approvals received so far. */
  readonly approval_count: number;
  /** Minimum approvals required for certification. */
  readonly approval_quorum: number;
}

/** Response for `list_policy_versions`. */
export interface ListPolicyVersionsResponse {
  readonly versions: readonly PolicyVersion[];
  readonly total: number;
  readonly next_cursor?: string;
}

/** Query parameters for listing policy versions. */
export interface ListPolicyVersionsQuery {
  readonly policy_name?: string;
  readonly status?: PolicyVersionStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

/** A single certifier approval record. */
export interface PolicyApproval {
  readonly approval_id: string;
  readonly version_id: string;
  readonly org_id: string;
  readonly approver_id: string;
  readonly approver_label: string;
  readonly decision: "approve" | "reject";
  readonly comment: string | null;
  readonly created_at: string;
}

/** Request body for `create_approval`. */
export interface CreatePolicyApprovalRequest {
  readonly version_id: string;
  readonly approver_id: string;
  readonly approver_label: string;
  readonly decision: "approve" | "reject";
  readonly comment?: string;
}

/** Response for `create_approval`. */
export interface CreatePolicyApprovalResponse {
  /** The recorded approval. */
  readonly approval: PolicyApproval;
  /** Updated policy version (reflects new `approval_count` / `status`). */
  readonly version: PolicyVersion;
}

/**
 * A signed attestation record emitted when a version reaches `certified`
 * status.  Attestations are append-only and immutable.
 */
export interface PolicyAttestation {
  readonly attestation_id: string;
  readonly version_id: string;
  readonly org_id: string;
  readonly policy_name: string;
  readonly version_number: number;
  readonly body_hash: string;
  readonly certified_at: string;
  /** SHA-256 over canonical JSON of the approval records. */
  readonly approval_chain_hash: string;
  /** Ordered list of approver IDs whose votes satisfied the quorum. */
  readonly approver_ids: readonly string[];
}

/** Response for `list_attestations`. */
export interface ListPolicyAttestationsResponse {
  readonly attestations: readonly PolicyAttestation[];
  readonly total: number;
  readonly next_cursor?: string;
}

/** Query parameters for listing attestations. */
export interface ListPolicyAttestationsQuery {
  readonly policy_name?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
