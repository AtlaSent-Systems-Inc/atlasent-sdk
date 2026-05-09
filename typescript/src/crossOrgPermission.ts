/**
 * Cross-Org Permission Negotiation.
 *
 * Evaluates whether an identity in one organization is permitted to
 * perform an action on resources owned by another organization.
 * Resolves trust paths, conditions, and cross-org trust levels.
 *
 * Wire-stable as `cross_org_permission.v1`.
 */

/** A single hop in the cross-org trust path. */
export interface CrossOrgTrustHop {
  org_id: string;
  trust_type: string;
  trust_level: string;
}

/** Request payload for a cross-org permission check. */
export interface CrossOrgPermissionCheckRequest {
  source_org_id: string;
  target_org_id: string;
  identity_id?: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
}

/** Result of a cross-org permission evaluation. */
export interface CrossOrgPermissionCheckResult {
  check_id: string;
  allowed: boolean;
  reason: string;
  trust_path: Array<CrossOrgTrustHop>;
  conditions: string[];
  checked_at: string;
}

/** Parameters for listing previous cross-org permission checks. */
export interface CrossOrgPermissionCheckListParams {
  source_org_id?: string;
  target_org_id?: string;
  allowed?: boolean;
  limit?: number;
}

/**
 * Summarize whether a cross-org check result is unconditionally allowed,
 * conditionally allowed, or denied.
 */
export function summarizeCrossOrgPermission(
  result: CrossOrgPermissionCheckResult,
): "allowed" | "conditional" | "denied" {
  if (!result.allowed) return "denied";
  if (result.conditions.length > 0) return "conditional";
  return "allowed";
}
