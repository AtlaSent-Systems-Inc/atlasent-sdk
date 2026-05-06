/**
 * Budgetary Governance — policy and constraint infrastructure for
 * organizational financial limits.
 *
 * Prevents budget overruns, unauthorized escalations, and hidden approvals
 * by enforcing declared spending constraints before financial actions
 * are authorized.
 *
 * Wire-stable as `budget_governance.v1`.
 */

import type { CurrencyCode, FinancialActionType, FinancialRiskTier } from "./financialAction.js";

/** Scope a budget limit applies to. */
export type BudgetScope =
  | "org"           // Entire organization
  | "department"    // Named department
  | "team"          // Named team within a department
  | "environment"   // Deployment environment (prod, staging, etc.)
  | "action_class"  // Specific financial action class
  | "project"       // Project or cost center code
  | "time_bounded"; // Time-bounded budget (sprint, quarter, etc.)

/** A declared budget limit for a scope. */
export interface BudgetLimit {
  readonly limit_id: string;
  readonly org_id: string;
  readonly scope_type: BudgetScope;
  readonly scope_id: string;
  readonly limit_amount: number;
  readonly currency: CurrencyCode;
  /** Hard limits block execution; soft limits warn only. */
  readonly enforcement: "hard" | "soft";
  readonly period_start: string | null;
  readonly period_end: string | null;
  readonly active: boolean;
  readonly created_by: string;
  readonly created_at: string;
}

/** Current spending state against a budget limit. */
export interface BudgetSpendingState {
  readonly limit_id: string;
  readonly spent_amount: number;
  readonly remaining_amount: number;
  readonly exceeded: boolean;
  /** Utilization percentage (0–100+). */
  readonly utilization_pct: number;
  readonly updated_at: string;
}

/** A spending constraint on a financial action class or type. */
export interface SpendingConstraint {
  readonly constraint_id: string;
  readonly org_id: string;
  /** "*" matches all action types. */
  readonly action_type: FinancialActionType | "*";
  readonly max_single_transaction: number;
  readonly max_daily_aggregate: number | null;
  readonly max_monthly_aggregate: number | null;
  readonly currency: CurrencyCode;
  readonly applies_to_tier_gte: FinancialRiskTier | null;
  readonly allow_anonymous_agents: boolean;
  readonly active: boolean;
}

/** A specific budget violation. */
export interface BudgetViolation {
  readonly violation_type:
    | "limit_exceeded"
    | "single_transaction_exceeds"
    | "daily_aggregate_exceeds"
    | "monthly_aggregate_exceeds"
    | "anonymous_agent_blocked"
    | "period_expired";
  readonly limit_id?: string;
  readonly constraint_id?: string;
  readonly description: string;
  readonly overage_amount?: number;
}

/** Result of checking an action against budget constraints. */
export interface BudgetConstraintCheckResult {
  readonly permitted: boolean;
  readonly hard_blocks: readonly BudgetViolation[];
  readonly soft_warnings: readonly BudgetViolation[];
  readonly limits_checked: readonly string[];
  readonly constraints_checked: readonly string[];
}

/** A complete budget policy document for an organization. */
export interface BudgetPolicy {
  readonly policy_id: string;
  readonly org_id: string;
  readonly name: string;
  readonly limits: readonly BudgetLimit[];
  readonly constraints: readonly SpendingConstraint[];
  readonly override_requires_exception: boolean;
  readonly allow_approved_escalation: boolean;
  readonly version: string;
  readonly effective_from: string;
  readonly expires_at: string | null;
}

/**
 * Check an action value against applicable budget limits and constraints.
 *
 * Hard limits block execution; soft limits surface as warnings.
 */
export function checkBudgetConstraints(params: {
  actionValue: number;
  currency: CurrencyCode;
  actionType: FinancialActionType;
  riskTier: FinancialRiskTier;
  isAnonymousAgent: boolean;
  currentDailySpend: number;
  currentMonthlySpend: number;
  applicableLimits: readonly (BudgetLimit & { spending: BudgetSpendingState })[];
  applicableConstraints: readonly SpendingConstraint[];
  now?: Date;
}): BudgetConstraintCheckResult {
  const hardBlocks: BudgetViolation[] = [];
  const softWarnings: BudgetViolation[] = [];
  const limitsChecked: string[] = [];
  const constraintsChecked: string[] = [];
  const nowIso = (params.now ?? new Date()).toISOString();

  for (const limit of params.applicableLimits) {
    limitsChecked.push(limit.limit_id);

    if (limit.period_end && nowIso > limit.period_end) {
      const v: BudgetViolation = {
        violation_type: "period_expired",
        limit_id: limit.limit_id,
        description: `Budget limit ${limit.limit_id} period expired at ${limit.period_end}`,
      };
      if (limit.enforcement === "hard") hardBlocks.push(v); else softWarnings.push(v);
      continue;
    }

    const projected = limit.spending.spent_amount + params.actionValue;
    if (projected > limit.limit_amount) {
      const v: BudgetViolation = {
        violation_type: "limit_exceeded",
        limit_id: limit.limit_id,
        description: `Action would exceed ${limit.scope_type} limit (${limit.limit_amount} ${limit.currency})`,
        overage_amount: projected - limit.limit_amount,
      };
      if (limit.enforcement === "hard") hardBlocks.push(v); else softWarnings.push(v);
    }
  }

  for (const constraint of params.applicableConstraints) {
    constraintsChecked.push(constraint.constraint_id);

    if (constraint.action_type !== "*" && constraint.action_type !== params.actionType) continue;

    if (!constraint.allow_anonymous_agents && params.isAnonymousAgent) {
      hardBlocks.push({
        violation_type: "anonymous_agent_blocked",
        constraint_id: constraint.constraint_id,
        description: `Anonymous agents are not permitted to execute ${params.actionType}`,
      });
    }

    if (params.actionValue > constraint.max_single_transaction) {
      hardBlocks.push({
        violation_type: "single_transaction_exceeds",
        constraint_id: constraint.constraint_id,
        description: `Value ${params.actionValue} exceeds single-transaction limit ${constraint.max_single_transaction} ${constraint.currency}`,
        overage_amount: params.actionValue - constraint.max_single_transaction,
      });
    }

    if (
      constraint.max_daily_aggregate !== null &&
      params.currentDailySpend + params.actionValue > constraint.max_daily_aggregate
    ) {
      hardBlocks.push({
        violation_type: "daily_aggregate_exceeds",
        constraint_id: constraint.constraint_id,
        description: `Action would exceed daily aggregate limit ${constraint.max_daily_aggregate} ${constraint.currency}`,
        overage_amount: params.currentDailySpend + params.actionValue - constraint.max_daily_aggregate,
      });
    }

    if (
      constraint.max_monthly_aggregate !== null &&
      params.currentMonthlySpend + params.actionValue > constraint.max_monthly_aggregate
    ) {
      hardBlocks.push({
        violation_type: "monthly_aggregate_exceeds",
        constraint_id: constraint.constraint_id,
        description: `Action would exceed monthly aggregate limit ${constraint.max_monthly_aggregate} ${constraint.currency}`,
        overage_amount: params.currentMonthlySpend + params.actionValue - constraint.max_monthly_aggregate,
      });
    }
  }

  return {
    permitted: hardBlocks.length === 0,
    hard_blocks: hardBlocks,
    soft_warnings: softWarnings,
    limits_checked: limitsChecked,
    constraints_checked: constraintsChecked,
  };
}

/**
 * Determine budget utilization severity for dashboard display.
 */
export function budgetUtilizationSeverity(
  utilizationPct: number,
): "normal" | "warn" | "critical" {
  if (utilizationPct >= 100) return "critical";
  if (utilizationPct >= 80)  return "warn";
  return "normal";
}
