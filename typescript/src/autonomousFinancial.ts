/**
 * Autonomous Financial Execution — governance for AI-driven financial actions.
 *
 * Defines bounded authority, execution ceilings, and runtime verification
 * requirements for autonomous agents performing financial operations:
 * refunds, procurement, cloud-cost optimization, vendor payments, etc.
 *
 * Wire-stable as `autonomous_financial.v1`.
 */

import type { CurrencyCode, FinancialActionType, FinancialRiskTier } from "./financialAction.js";

/** Authority bounds for an autonomous financial agent. */
export interface AutonomousExecutionBounds {
  readonly bounds_id: string;
  readonly org_id: string;
  readonly agent_id: string;
  readonly agent_name: string;
  /** Action types this agent is permitted to execute autonomously. */
  readonly permitted_action_types: readonly FinancialActionType[];
  readonly ceilings: readonly ExecutionCeiling[];
  readonly daily_aggregate_ceiling: number;
  readonly aggregate_currency: CurrencyCode;
  /** Maximum risk tier the agent may autonomously execute. */
  readonly max_risk_tier: FinancialRiskTier;
  readonly require_runtime_verification: boolean;
  readonly anomaly_detection_enabled: boolean;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly active: boolean;
}

/** Per-action-type execution ceiling. */
export interface ExecutionCeiling {
  readonly action_type: FinancialActionType;
  readonly per_execution_max: number;
  readonly currency: CurrencyCode;
  readonly max_daily_count: number | null;
  readonly require_permit: boolean;
}

/** Record of an autonomous execution attempt. */
export interface AutonomousExecutionRecord {
  readonly record_id: string;
  readonly agent_id: string;
  readonly org_id: string;
  readonly action_type: FinancialActionType;
  readonly action_value: number;
  readonly currency: CurrencyCode;
  readonly permitted: boolean;
  readonly denial_reason: string | null;
  readonly permit_id: string | null;
  readonly anomaly_detected: boolean;
  readonly anomaly_description: string | null;
  readonly attempted_at: string;
  readonly executed_at: string | null;
}

/** Result of checking whether an autonomous execution is within bounds. */
export interface AutonomousExecutionCheckResult {
  readonly permitted: boolean;
  readonly action_type_permitted: boolean;
  readonly within_execution_ceiling: boolean;
  readonly within_daily_aggregate: boolean;
  readonly within_risk_tier: boolean;
  readonly bounds_active: boolean;
  readonly bounds_not_expired: boolean;
  readonly applicable_ceiling: ExecutionCeiling | null;
  readonly denial_reason: string | null;
  readonly violations: readonly string[];
}

const RISK_TIER_ORDER: Record<FinancialRiskTier, number> = {
  low:      1,
  medium:   2,
  high:     3,
  critical: 4,
};

/**
 * Check whether an autonomous execution is within declared bounds.
 */
export function checkAutonomousBounds(params: {
  bounds: AutonomousExecutionBounds;
  actionType: FinancialActionType;
  actionValue: number;
  currency: CurrencyCode;
  riskTier: FinancialRiskTier;
  currentDailyAggregate: number;
  currentDailyCount: Partial<Record<string, number>>;
  now?: Date;
}): AutonomousExecutionCheckResult {
  const violations: string[] = [];
  const nowIso = (params.now ?? new Date()).toISOString();

  const boundsActive = params.bounds.active;
  if (!boundsActive) violations.push("agent execution bounds are inactive");

  const boundsNotExpired =
    params.bounds.expires_at === null || params.bounds.expires_at > nowIso;
  if (!boundsNotExpired) {
    violations.push(`agent bounds expired at ${params.bounds.expires_at}`);
  }

  const actionTypePermitted = (params.bounds.permitted_action_types as string[]).includes(
    params.actionType,
  );
  if (!actionTypePermitted) {
    violations.push(`action type ${params.actionType} not in agent's permitted set`);
  }

  const applicableCeiling =
    params.bounds.ceilings.find((c) => c.action_type === params.actionType) ?? null;

  let withinExecutionCeiling = true;
  if (applicableCeiling !== null) {
    if (params.actionValue > applicableCeiling.per_execution_max) {
      withinExecutionCeiling = false;
      violations.push(
        `value ${params.actionValue} exceeds per-execution ceiling ${applicableCeiling.per_execution_max} ${applicableCeiling.currency}`,
      );
    }
    if (applicableCeiling.max_daily_count !== null) {
      const todayCount = params.currentDailyCount[params.actionType] ?? 0;
      if (todayCount >= applicableCeiling.max_daily_count) {
        withinExecutionCeiling = false;
        violations.push(
          `daily count ${todayCount} at or exceeds limit ${applicableCeiling.max_daily_count} for ${params.actionType}`,
        );
      }
    }
  }

  const withinDailyAggregate =
    params.currentDailyAggregate + params.actionValue <= params.bounds.daily_aggregate_ceiling;
  if (!withinDailyAggregate) {
    violations.push(
      `daily aggregate ${params.currentDailyAggregate + params.actionValue} would exceed ceiling ${params.bounds.daily_aggregate_ceiling} ${params.bounds.aggregate_currency}`,
    );
  }

  const withinRiskTier =
    RISK_TIER_ORDER[params.riskTier] <= RISK_TIER_ORDER[params.bounds.max_risk_tier];
  if (!withinRiskTier) {
    violations.push(
      `action risk tier ${params.riskTier} exceeds agent max ${params.bounds.max_risk_tier}`,
    );
  }

  const permitted =
    boundsActive &&
    boundsNotExpired &&
    actionTypePermitted &&
    withinExecutionCeiling &&
    withinDailyAggregate &&
    withinRiskTier;

  return {
    permitted,
    action_type_permitted: actionTypePermitted,
    within_execution_ceiling: withinExecutionCeiling,
    within_daily_aggregate: withinDailyAggregate,
    within_risk_tier: withinRiskTier,
    bounds_active: boundsActive,
    bounds_not_expired: boundsNotExpired,
    applicable_ceiling: applicableCeiling,
    denial_reason: permitted ? null : (violations[0] ?? "execution out of bounds"),
    violations,
  };
}

/**
 * Detect a potential anomaly in autonomous execution.
 * Returns a description when an anomaly is detected, or null.
 */
export function detectAutonomousAnomaly(params: {
  actionValue: number;
  historicalMeanValue: number;
  historicalStdDev: number;
  recentExecutionCount: number;
  burstThreshold: number;
  isOffHours: boolean;
}): { anomalyDetected: boolean; description: string | null } {
  const zScore =
    params.historicalStdDev > 0
      ? Math.abs(params.actionValue - params.historicalMeanValue) / params.historicalStdDev
      : 0;

  if (zScore > 3) {
    return {
      anomalyDetected: true,
      description: `action value ${params.actionValue} is ${zScore.toFixed(1)}σ from mean (${params.historicalMeanValue})`,
    };
  }

  if (params.recentExecutionCount > params.burstThreshold) {
    return {
      anomalyDetected: true,
      description: `execution burst: ${params.recentExecutionCount} in window (threshold: ${params.burstThreshold})`,
    };
  }

  if (params.isOffHours && params.actionValue > params.historicalMeanValue * 2) {
    return {
      anomalyDetected: true,
      description: `off-hours execution with above-average value ${params.actionValue}`,
    };
  }

  return { anomalyDetected: false, description: null };
}
