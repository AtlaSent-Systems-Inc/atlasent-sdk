/**
 * Cross-Org Permission Negotiation.
 *
 * Checks whether an active federation trust relationship covers a proposed
 * cross-org action. Resolves trust paths, conditions, and cross-org trust
 * levels.
 *
 * SEMANTIC SAFETY (CROSS-028, ratified 2026-08-22): this is a FEDERATION
 * TRUST PRECHECK, not an authorization decision. `trust_precheck_passed`
 * (and the deprecated `allowed`) mean only "an active trust relationship
 * covers this action/resource" — never "this specific action is authorized
 * to execute." `authorizes_execution` is always `false` and
 * `requires_local_authority_evaluation` is always `true` on every real
 * result: local authorization must still go through the runtime evaluate
 * path. Do not gate execution on this result alone.
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

/** Result of a cross-org trust precheck. See the module header — this is a
 * precheck result, never an authorization decision or permit. */
export interface CrossOrgPermissionCheckResult {
  check_id: string;
  /** Canonical field (CROSS-028). Does an active trust relationship cover
   * this action/resource? Nothing more. */
  trust_precheck_passed: boolean;
  /** Always `false`. This result never authorizes execution of anything —
   * route the actual authorization decision through `/v1-evaluate`. */
  authorizes_execution: false;
  /** Always `true`. Local `/v1-evaluate` authorization is still required
   * regardless of `trust_precheck_passed`. */
  requires_local_authority_evaluation: true;
  /** Always `false` today — `conditions` below is returned unevaluated. */
  conditions_evaluated: false;
  /** @deprecated Mirrors `trust_precheck_passed` exactly. Retained only for
   * backward compatibility with existing `cross_org_permission.v1` callers —
   * never treat as an authorization decision. Prefer `trust_precheck_passed`. */
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
 * Summarize whether a cross-org trust precheck passed unconditionally, with
 * conditions attached (unevaluated — see `conditions_evaluated`), or failed.
 *
 * Deliberately does NOT use "allowed"/"denied" vocabulary — those read as an
 * authorization outcome, which this precheck result is not. Prefer this over
 * the deprecated `summarizeCrossOrgPermission()`.
 */
export function summarizeTrustPrecheck(
  result: CrossOrgPermissionCheckResult,
): "trust_established" | "trust_established_with_unevaluated_conditions" | "no_trust" {
  if (!result.trust_precheck_passed) return "no_trust";
  if (result.conditions.length > 0) return "trust_established_with_unevaluated_conditions";
  return "trust_established";
}

/**
 * @deprecated Use `summarizeTrustPrecheck()`. This name and its
 * `"allowed"`/`"denied"` return values read as an authorization outcome,
 * which a cross-org trust precheck result is not (CROSS-028) — retained
 * only for backward compatibility, and defined to always agree with
 * `summarizeTrustPrecheck()`'s underlying boolean.
 */
export function summarizeCrossOrgPermission(
  result: CrossOrgPermissionCheckResult,
): "allowed" | "conditional" | "denied" {
  if (!result.allowed) return "denied";
  if (result.conditions.length > 0) return "conditional";
  return "allowed";
}
