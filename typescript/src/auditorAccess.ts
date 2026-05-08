/**
 * Auditor Portal — external access grants for the auditor portal.
 *
 * Wire surface: `v1-auditor-access` edge function.
 * Supported operations: `list_grants`, `create_grant`, `revoke_grant`,
 * `list_access_events`.
 *
 * Every grant is scoped to an org + auditor principal.  The server
 * enforces that only org admins may create/revoke grants; auditors may
 * only list the events accessible to them.
 *
 * Wire-stable as `auditor_access.v1`.
 */

/** Status of an auditor access grant. */
export type AuditorGrantStatus = "active" | "revoked" | "expired";

/** Scope of data an auditor grant permits read access to. */
export type AuditorAccessScope =
  | "audit_events"          // read audit event stream
  | "policy_versions"       // read policy documents
  | "financial_executions"  // read financial execution records
  | "liability_records"     // read liability attribution records
  | "compliance_runs";      // read compliance evidence runs

/**
 * A single auditor access grant.
 *
 * Stored in `auditor_access_grants`.  Grants are immutable after
 * creation except for the `status` and `revoked_*` fields.
 */
export interface AuditorAccessGrant {
  /** Server-assigned UUID. */
  readonly grant_id: string;
  /** Org the grant belongs to. */
  readonly org_id: string;
  /** Stable identifier for the external auditor (email or SSO subject). */
  readonly auditor_principal: string;
  /** Human-readable label for audit logs. */
  readonly auditor_label: string;
  /** What the auditor is allowed to read. */
  readonly scopes: readonly AuditorAccessScope[];
  readonly status: AuditorGrantStatus;
  /** ISO 8601 — grant expires at this time (null = no expiry). */
  readonly expires_at: string | null;
  /** Who created the grant. */
  readonly created_by: string;
  readonly created_at: string;
  readonly revoked_at: string | null;
  readonly revoked_by: string | null;
  readonly revoke_reason: string | null;
}

/** Response for `list_grants`. */
export interface ListAuditorGrantsResponse {
  readonly grants: readonly AuditorAccessGrant[];
  readonly total: number;
  readonly next_cursor?: string;
}

/** Request body for `create_grant`. */
export interface CreateAuditorGrantRequest {
  /** Stable identifier (email or SSO subject) for the external auditor. */
  readonly auditor_principal: string;
  /** Human-readable label shown in audit logs. */
  readonly auditor_label: string;
  /** At least one scope must be supplied. */
  readonly scopes: readonly AuditorAccessScope[];
  /** ISO 8601 — omit for a non-expiring grant. */
  readonly expires_at?: string;
}

/** Response for `create_grant`. */
export interface CreateAuditorGrantResponse {
  readonly grant: AuditorAccessGrant;
}

/** Response for `revoke_grant`. */
export interface RevokeAuditorGrantResponse {
  readonly grant: AuditorAccessGrant;
}

/** One event in the auditor access event stream. */
export interface AuditorAccessEvent {
  readonly event_id: string;
  readonly grant_id: string;
  readonly org_id: string;
  readonly auditor_principal: string;
  /** Action the auditor performed (e.g. `"read_audit_events"`). */
  readonly action: string;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
  readonly occurred_at: string;
}

/** Response for `list_access_events`. */
export interface ListAuditorAccessEventsResponse {
  readonly events: readonly AuditorAccessEvent[];
  readonly total: number;
  readonly next_cursor?: string;
}

/** Query parameters for listing access events. */
export interface ListAuditorAccessEventsQuery {
  readonly grant_id?: string;
  readonly auditor_principal?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
