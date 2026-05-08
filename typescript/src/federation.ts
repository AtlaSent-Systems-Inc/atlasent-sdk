/**
 * Federated Org Trust — federated org trust, observer grants, and
 * cross-org approvals.
 *
 * Wire surface: `v1-federation` edge function.
 * Supported operations:
 *   - `list_federated_orgs`, `register_federated_org`
 *   - `activate_trust`, `suspend_trust`, `revoke_trust`
 *   - `list_observer_grants`, `create_observer_grant`, `revoke_observer_grant`
 *   - `list_federated_approvals`, `submit_federated_approval`
 *
 * The federation model:
 *   - A "home" org registers a "peer" org as a federated partner.
 *   - Trust passes through states: `pending → active → suspended | revoked`.
 *   - Optionally, the home org grants specific peer principals observer
 *     access to its governance events.
 *   - When a high-risk action requires cross-org sign-off, the home org
 *     creates a `FederatedApproval` request; the peer submits a decision.
 *
 * Wire-stable as `federation.v1`.
 */

/** Lifecycle state of a federated trust relationship. */
export type FederationTrustStatus =
  | "pending"    // registered; awaiting activation
  | "active"     // fully trusted
  | "suspended"  // temporarily paused (reactivatable)
  | "revoked";   // permanently terminated

/** A registered federated org relationship. */
export interface FederatedOrg {
  readonly federation_id: string;
  readonly home_org_id: string;
  readonly peer_org_id: string;
  /** Display name for the peer org. */
  readonly peer_org_label: string;
  readonly trust_status: FederationTrustStatus;
  /** Who in the home org registered the relationship. */
  readonly registered_by: string;
  readonly registered_at: string;
  readonly activated_at: string | null;
  readonly suspended_at: string | null;
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
  /**
   * When `true`, the peer org's approval decisions are automatically
   * included in quorum calculations for home-org high-risk actions.
   */
  readonly include_in_quorum: boolean;
}

/** Response for `list_federated_orgs`. */
export interface ListFederatedOrgsResponse {
  readonly orgs: readonly FederatedOrg[];
  readonly total: number;
  readonly next_cursor?: string;
}

/** Request body for `register_federated_org`. */
export interface RegisterFederatedOrgRequest {
  readonly peer_org_id: string;
  readonly peer_org_label: string;
  readonly include_in_quorum?: boolean;
}

/** Response for `register_federated_org`. */
export interface RegisterFederatedOrgResponse {
  readonly org: FederatedOrg;
}

/** Response for `activate_trust`, `suspend_trust`, and `revoke_trust`. */
export interface UpdateFederationTrustResponse {
  readonly org: FederatedOrg;
}

/** Scope of observer access granted to a peer principal. */
export type ObserverAccessScope =
  | "audit_events"
  | "governance_graph"
  | "financial_executions"
  | "compliance_runs";

/** An observer grant allowing a peer principal to read home-org data. */
export interface ObserverGrant {
  readonly observer_grant_id: string;
  readonly federation_id: string;
  readonly home_org_id: string;
  readonly peer_org_id: string;
  /** Principal in the peer org receiving observer access. */
  readonly observer_principal: string;
  readonly observer_label: string;
  readonly scopes: readonly ObserverAccessScope[];
  readonly active: boolean;
  readonly created_by: string;
  readonly created_at: string;
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
}

/** Response for `list_observer_grants`. */
export interface ListObserverGrantsResponse {
  readonly grants: readonly ObserverGrant[];
  readonly total: number;
  readonly next_cursor?: string;
}

/** Request body for `create_observer_grant`. */
export interface CreateObserverGrantRequest {
  readonly federation_id: string;
  readonly observer_principal: string;
  readonly observer_label: string;
  readonly scopes: readonly ObserverAccessScope[];
}

/** Response for `create_observer_grant`. */
export interface CreateObserverGrantResponse {
  readonly grant: ObserverGrant;
}

/** Response for `revoke_observer_grant`. */
export interface RevokeObserverGrantResponse {
  readonly grant: ObserverGrant;
}

/** Status of a cross-org approval request. */
export type FederatedApprovalStatus =
  | "pending"    // awaiting peer decision
  | "approved"   // peer approved
  | "rejected"   // peer rejected
  | "expired"    // no decision before deadline
  | "cancelled"; // withdrawn by home org

/** A cross-org approval request requiring a peer org's sign-off. */
export interface FederatedApproval {
  readonly approval_id: string;
  readonly federation_id: string;
  readonly home_org_id: string;
  readonly peer_org_id: string;
  /** The execution or action requiring peer approval. */
  readonly subject_type: string;
  readonly subject_id: string;
  readonly subject_label: string;
  readonly status: FederatedApprovalStatus;
  readonly requested_by: string;
  readonly requested_at: string;
  /** ISO 8601 — peer must respond before this time. */
  readonly expires_at: string | null;
  readonly decided_by: string | null;
  readonly decided_at: string | null;
  readonly peer_decision: "approve" | "reject" | null;
  readonly peer_comment: string | null;
}

/** Response for `list_federated_approvals`. */
export interface ListFederatedApprovalsResponse {
  readonly approvals: readonly FederatedApproval[];
  readonly total: number;
  readonly next_cursor?: string;
}

/** Query parameters for listing federated approvals. */
export interface ListFederatedApprovalsQuery {
  readonly federation_id?: string;
  readonly status?: FederatedApprovalStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Request body for `submit_federated_approval`. */
export interface SubmitFederatedApprovalRequest {
  readonly peer_decision: "approve" | "reject";
  readonly decided_by: string;
  readonly peer_comment?: string;
}

/** Response for `submit_federated_approval`. */
export interface SubmitFederatedApprovalResponse {
  readonly approval: FederatedApproval;
}
