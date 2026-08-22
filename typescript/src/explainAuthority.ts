/**
 * Authority-lineage explanation — wire shape for
 * `GET /v1-authority-intelligence/explain-authority`.
 *
 * Answers "why may principal P exercise scope/action A in
 * organization O right now?" Read-only and additive: it explains the
 * same facts `/v1-evaluate` and `/v1-verify-permit` already read,
 * without changing any deny/hold/allow semantics.
 *
 * Backed by `authority_intelligence_explain_authority_v1`, composed
 * with direct reads of `authority_grants` and `authority_delegations`.
 * `paths` reports zero or more explicit authority paths, one per
 * mechanism that actually applies (`direct_grant` / `delegation` /
 * `role_capability` are never collapsed into one generic edge type).
 * `unresolved` reports every excluded or ambiguous relationship as an
 * explicit, named finding — never a silent gap, and `authority_found:
 * false` is never inferred from incomplete data.
 */

/** The authority mechanism a {@link AuthorityExplanationPath} represents. */
export type AuthorityPathMechanism =
  | "direct_grant"
  | "delegation"
  | "role_capability";

/**
 * One explicit authority path for a given mechanism.
 *
 * `edges` is an ordered, open-shaped edge chain (e.g. a delegation
 * path is `delegates` → the delegator's own `authority_grant_covers`
 * edge). Fields present on each edge vary by mechanism and are never
 * fabricated when absent — treat each edge as an open object rather
 * than a fixed shape.
 */
export interface AuthorityExplanationPath {
  mechanism: AuthorityPathMechanism;
  matched: boolean;
  edges: Array<Record<string, unknown>>;
}

/**
 * A known finding-type string as of this SDK release. The wire field
 * ({@link AuthorityUnresolvedFinding.finding_type}) is typed as a
 * plain `string`, not this union — the server may add new finding
 * types without a wire-breaking change, so this is documentation,
 * not a runtime constraint.
 */
export type KnownAuthorityUnresolvedFindingType =
  | "AUTHORITY_GRANT_REVOKED"
  | "AUTHORITY_GRANT_EXPIRED"
  | "DELEGATION_REVOKED"
  | "DELEGATION_EXPIRED"
  | "DELEGATION_OUT_OF_SCOPE"
  | "DELEGATION_PENDING_APPROVAL"
  | "DELEGATION_UNACKNOWLEDGED"
  | "DELEGATOR_LOST_AUTHORITY"
  | "DELEGATOR_ROLE_LOST"
  | "COARSE_ROLE_CAPABILITIES_UNEXPANDED"
  | "NO_AUTHORITY_PATH_FOUND";

/**
 * An excluded or ambiguous authority relationship reported as an
 * explicit finding (e.g. an expired or unacknowledged delegation, a
 * revoked grant, a coarse role whose capability mapping can't be
 * expanded in SQL).
 */
export interface AuthorityUnresolvedFinding {
  /**
   * Open string, not a hardcoded enum — new finding types may be
   * added additively. See {@link KnownAuthorityUnresolvedFindingType}
   * for the set known at the time this SDK shipped.
   */
  finding_type: string;
  reason?: string;
}

/**
 * Result of `GET /v1-authority-intelligence/explain-authority`,
 * passed through verbatim from
 * `authority_intelligence_explain_authority_v1` (no client-side
 * interpretation of `paths` / `unresolved` / `authority_found`).
 */
export interface ExplainAuthorityResult {
  organization_id: string;
  principal_id: string;
  requested_scope: string;
  resource_id: string | null;
  authority_found: boolean;
  paths: AuthorityExplanationPath[];
  unresolved: AuthorityUnresolvedFinding[];
}
