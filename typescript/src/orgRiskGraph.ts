/**
 * Organizational risk graph types: 5-dimension risk scoring and
 * recompute trigger shapes.
 *
 * Mirrors `v1-risk-graph` (compute_org_risk / get_latest_org_risk ops)
 * and the `organizational_risk_scores` DB table.
 */

import type { RateLimitState } from "./types.js";

// ── Risk level ────────────────────────────────────────────────────────────────

/**
 * Bucketed risk level derived from `overall_score`.
 *
 * | Level | Score range |
 * |---|---|
 * | `"low"` | 0–30 |
 * | `"medium"` | 31–60 |
 * | `"high"` | 61–85 |
 * | `"critical"` | 86–100 |
 */
export type OrgRiskLevel = "low" | "medium" | "high" | "critical";

// ── Risk score row ────────────────────────────────────────────────────────────

/**
 * Full organizational risk score from `organizational_risk_scores`.
 *
 * All sub-scores are 0–100 (higher = more risk). `overall_score` is a
 * weighted composite of the five dimensions; weights are internal and
 * may change between releases without a breaking-change notice.
 */
export interface OrgRiskScore {
  id: string;
  org_id: string;
  /** Composite risk score 0–100. */
  overall_score: number;
  risk_level: OrgRiskLevel;
  /** Actor-level risk: recent overrides, blocked actions by specific actors. */
  actor_risk_score: number;
  /** Connector-level risk: revoked/errored connectors, failed sync cycles. */
  connector_risk_score: number;
  /** Gap between what enforcement policies require and what connectors actually enforce. */
  enforcement_gap_score: number;
  /** Normalized frequency of incidents within the scoring window. */
  incident_frequency_score: number;
  /** Rate of permits that were overridden relative to total permits issued. */
  override_rate_score: number;
  /** Actor IDs flagged as high-risk within the window. */
  risky_actors: string[];
  /** Connector IDs flagged as high-risk within the window. */
  risky_systems: string[];
  /** Execution IDs with repeated overrides in the window. */
  repeated_overrides: string[];
  /** Days of activity included in this score computation. */
  window_days: number;
  computed_at: string;
  created_at: string;
}

// ── Request / response shapes ─────────────────────────────────────────────────

/** Options for triggering an org risk recompute. */
export interface ComputeOrgRiskOptions {
  /** Activity window in days (server default: 30). */
  window_days?: number;
}

/** Response from `computeOrgRisk()`. */
export interface ComputeOrgRiskResponse {
  score: OrgRiskScore;
  rateLimit: RateLimitState | null;
}

/**
 * Response from `getLatestOrgRisk()`.
 * `score` is `null` if no risk computation has been run yet for the org.
 */
export interface GetLatestOrgRiskResponse {
  score: OrgRiskScore | null;
  rateLimit: RateLimitState | null;
}

/** Response from `listOrgRiskHistory()`. */
export interface ListOrgRiskHistoryResponse {
  scores: OrgRiskScore[];
  total: number;
  nextCursor?: string;
  rateLimit: RateLimitState | null;
}
