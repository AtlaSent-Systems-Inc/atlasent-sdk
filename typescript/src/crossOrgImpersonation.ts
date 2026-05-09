/**
 * Cross-Org Impersonation.
 *
 * Allows a service account in one organization to impersonate a role in
 * another organization under explicit, audited grants. Supports bounded
 * token issuance, grant revocation, and token validation.
 *
 * Wire-stable as `cross_org_impersonation.v1`.
 */

/** An explicit grant allowing one org's service account to impersonate a role in another org. */
export interface CrossOrgImpersonationGrant {
  id: string;
  grantor_org_id: string;
  grantee_org_id: string;
  grantee_service_account_id: string;
  impersonated_role: string;
  allowed_actions: string[];
  allowed_resource_types: string[];
  max_token_duration_seconds: number;
  is_active: boolean;
  created_by: string;
  created_at: string;
  expires_at?: string;
  revoked_at?: string;
}

/** Request body for creating a new impersonation grant. */
export interface CreateImpersonationGrantRequest {
  grantee_org_id: string;
  grantee_service_account_id: string;
  impersonated_role: string;
  allowed_actions: string[];
  allowed_resource_types: string[];
  max_token_duration_seconds?: number;
  expires_at?: string;
}

/** A short-lived impersonation token issued under a grant. */
export interface ImpersonationToken {
  token: string;
  expires_at: string;
  grant_id: string;
}

/** Result of validating an impersonation token. */
export interface ImpersonationValidationResult {
  valid: boolean;
  grant?: CrossOrgImpersonationGrant;
  impersonated_role?: string;
  allowed_actions?: string[];
  allowed_resource_types?: string[];
  error?: string;
}

/**
 * Returns true when an impersonation grant is currently usable:
 * - is_active is true
 * - not yet expired
 * - not revoked
 */
export function isImpersonationGrantUsable(
  grant: CrossOrgImpersonationGrant,
  now?: Date,
): boolean {
  if (!grant.is_active) return false;
  if (grant.revoked_at) return false;
  const ts = (now ?? new Date()).toISOString();
  if (grant.expires_at && ts > grant.expires_at) return false;
  return true;
}

/**
 * Clamp a requested token duration to the grant's maximum.
 * Returns the minimum of the requested duration and the grant ceiling.
 */
export function clampTokenDuration(
  grant: CrossOrgImpersonationGrant,
  requestedSeconds: number,
): number {
  return Math.min(requestedSeconds, grant.max_token_duration_seconds);
}
