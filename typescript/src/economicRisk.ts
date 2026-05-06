/**
 * Economic Risk Engine.
 *
 * Computes financial exposure, approval concentration risk, override
 * frequency risk, budgetary drift, and execution anomaly risk for an
 * organization's financial governance posture.
 *
 * All computation is pure (no I/O). Inputs are derived from the
 * financial_execution_records and liability_attribution_records tables.
 *
 * Wire-stable as `economic_risk.v1`.
 */

import type { FinancialExecutionRecord, FinancialRiskTier } from "./financialAction.js";

/** Aggregate financial risk score for an organization or scope. */
export interface FinancialRiskScore {
  readonly scope_id: string;
  /** Overall risk score (0–100; higher = riskier). */
  readonly overall_score: number;
  readonly exposure_score: number;
  readonly concentration_score: number;
  readonly override_score: number;
  readonly drift_score: number;
  readonly anomaly_score: number;
  readonly implied_tier: FinancialRiskTier;
  readonly computed_at: string;
  readonly factors: readonly RiskFactor[];
}

/** A single contributing risk factor. */
export interface RiskFactor {
  readonly name: string;
  readonly score: number;
  readonly weight: number;
  readonly description: string;
  readonly evidence?: readonly string[];
}

/** Alert raised when approval authority is too concentrated. */
export interface ConcentrationAlert {
  readonly approver_id: string;
  /** Percentage of total approvals (0–100). */
  readonly approval_share_pct: number;
  readonly total_value_approved: number;
  readonly approval_count: number;
  readonly severity: "warn" | "critical";
  readonly window_start: string;
  readonly window_end: string;
}

/** Per-approver breakdown within a concentration analysis. */
export interface ApproverBreakdown {
  readonly approver_id: string;
  readonly approval_count: number;
  readonly total_value: number;
  /** Share as a percentage (0–100). */
  readonly share_pct: number;
}

/** Result of approval concentration analysis. */
export interface ApprovalConcentrationAnalysis {
  readonly scope_id: string;
  readonly analysis_window_days: number;
  readonly total_approvals: number;
  readonly total_value: number;
  readonly approver_breakdown: readonly ApproverBreakdown[];
  readonly alerts: readonly ConcentrationAlert[];
  /** Herfindahl-Hirschman Index (0–10000). */
  readonly concentration_hhi: number;
  readonly computed_at: string;
}

/** Budgetary drift analysis for a scope/period. */
export interface BudgetaryDriftAnalysis {
  readonly scope_id: string;
  readonly department_id: string | null;
  readonly period_start: string;
  readonly period_end: string;
  readonly budgeted_amount: number;
  readonly actual_amount: number;
  readonly variance_amount: number;
  readonly variance_pct: number;
  readonly drift_detected: boolean;
  readonly drift_severity: "none" | "minor" | "moderate" | "severe";
  readonly override_contribution_pct: number;
  readonly unauthorized_escalation_detected: boolean;
}

/** A single execution anomaly signal. */
export interface ExecutionAnomaly {
  readonly anomaly_id: string;
  readonly execution_id: string;
  readonly anomaly_type: AnomalyType;
  readonly description: string;
  readonly severity: "low" | "medium" | "high";
  readonly detected_at: string;
  readonly evidence: Record<string, unknown>;
}

/** Known anomaly types detected by the risk engine. */
export type AnomalyType =
  | "unusual_amount"        // Value significantly outside historical baseline
  | "unusual_frequency"     // Too many executions in a short period
  | "off_hours_execution"   // Outside normal business hours
  | "rapid_sequential"      // Rapid sequential approvals (rubber-stamping signal)
  | "self_approval"         // Initiator and approver are the same party
  | "jurisdiction_mismatch" // Currency/amount inconsistent with counterparty locale
  | "dormant_approver"      // Approver who hasn't approved in a long time
  | "velocity_spike"        // Sudden spike in total daily value
  | string;

/** Sub-score weights for overall risk computation. */
const SCORE_WEIGHTS = {
  exposure:      0.25,
  concentration: 0.25,
  override:      0.20,
  drift:         0.15,
  anomaly:       0.15,
} as const;

/**
 * Compute the overall financial risk score from sub-scores.
 * Returns a value in [0, 100].
 */
export function computeOverallRiskScore(subScores: {
  exposure: number;
  concentration: number;
  override: number;
  drift: number;
  anomaly: number;
}): number {
  return Math.min(
    100,
    Math.max(
      0,
      subScores.exposure      * SCORE_WEIGHTS.exposure +
      subScores.concentration * SCORE_WEIGHTS.concentration +
      subScores.override      * SCORE_WEIGHTS.override +
      subScores.drift         * SCORE_WEIGHTS.drift +
      subScores.anomaly       * SCORE_WEIGHTS.anomaly,
    ),
  );
}

/**
 * Infer a risk tier from an overall score.
 * 0–25: low | 26–55: medium | 56–80: high | 81–100: critical
 */
export function scoreToRiskTier(score: number): FinancialRiskTier {
  if (score <= 25) return "low";
  if (score <= 55) return "medium";
  if (score <= 80) return "high";
  return "critical";
}

/**
 * Compute the Herfindahl-Hirschman Index from a list of shares (0–100 each).
 * HHI > 2500 indicates high concentration.
 */
export function computeHHI(shares: readonly number[]): number {
  return shares.reduce((acc, s) => acc + s * s, 0);
}

/** Map HHI (0–10000) to a concentration score (0–100). */
export function hhiToConcentrationScore(hhi: number): number {
  return Math.min(100, (hhi / 10_000) * 100);
}

/**
 * Compute an exposure score (0–100) from execution records.
 * Total active-state value as a fraction of a reference ceiling.
 */
export function computeExposureScore(
  records: readonly Pick<FinancialExecutionRecord, "action_value" | "status" | "risk_tier">[],
  exposureCeilingUSD = 10_000_000,
): number {
  const activeStatuses = new Set<FinancialExecutionRecord["status"]>(
    ["pending_approval", "approved", "executing"],
  );
  const totalExposure = records
    .filter((r) => activeStatuses.has(r.status))
    .reduce((acc, r) => acc + r.action_value, 0);
  return Math.min(100, (totalExposure / exposureCeilingUSD) * 100);
}

/**
 * Compute an override frequency score (0–100).
 * More than 10% override rate → score = 100.
 */
export function computeOverrideScore(
  totalExecutions: number,
  overriddenExecutions: number,
): number {
  if (totalExecutions === 0) return 0;
  const rate = overriddenExecutions / totalExecutions;
  return Math.min(100, rate * 1000); // 10% rate maps to 100
}

/**
 * Detect self-approval: initiator and approver are the same party.
 */
export function detectSelfApproval(
  initiatorId: string,
  approverIds: readonly string[],
): boolean {
  return approverIds.includes(initiatorId);
}

/** Compute an approval risk score from concentration analysis. */
export function computeApprovalRiskScore(analysis: ApprovalConcentrationAnalysis): number {
  return hhiToConcentrationScore(analysis.concentration_hhi);
}
