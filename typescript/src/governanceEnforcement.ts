/**
 * Enforcement-layer helpers for the canonical economic governance primitives.
 *
 * The canonical EGAS modules (`financialQuorum`, `liabilityAttribution`,
 * `economicEvidence`, `budgetaryGovernance`, `autonomousFinancial`) are
 * **advisory**: they produce structured decision objects but never block
 * execution. This module converts "not permitted" advisory results into
 * thrown {@link GovernanceEnforcementError} so callers cannot silently
 * proceed when a governance gate refuses an action.
 *
 * Three gates, layered in this order at consumer call sites:
 *
 * ```ts
 *   enforceFinancialQuorum(quorumResult);
 *   enforceBudgetConstraint(budgetResult);
 *   enforceAutonomousBounds(autonomousResult);
 * ```
 *
 * Each helper is a no-op when its result is permitted; otherwise it throws
 * with a stable {@link GovernanceEnforcementError.denyCode} matching a row
 * in `docs/APPROVAL_DENY_REASONS.md`. The deny-code taxonomy is locked
 * cross-language by the parity fixture at
 * `compat/governance/fixtures/parity.json`.
 */

import { AtlaSentError, type AtlaSentErrorInit } from "./errors.js";
import type { AutonomousExecutionCheckResult } from "./autonomousFinancial.js";
import type { BudgetConstraintCheckResult } from "./budgetaryGovernance.js";
import type { FinancialQuorumResult } from "./financialQuorum.js";

/** Which enforcement gate fired. */
export type GovernanceGate = "financial_quorum" | "budget" | "autonomous_bounds";

/** Stable deny codes for the financial-quorum gate. */
export type FinancialQuorumDenyCode =
  | "blocked_by_emergency_freeze"
  | "base_count_unmet"
  | "amount_threshold_unmet"
  | "financial_role_unmet"
  | "regulator_approval_missing";

/** Stable deny codes for the budget gate. */
export type BudgetDenyCode =
  | "limit_exceeded"
  | "single_transaction_exceeds"
  | "daily_aggregate_exceeds"
  | "monthly_aggregate_exceeds"
  | "anonymous_agent_blocked"
  | "period_expired";

/** Stable deny codes for the autonomous-bounds gate. */
export type AutonomousBoundsDenyCode =
  | "inactive"
  | "expired"
  | "action_type_not_permitted"
  | "execution_ceiling_exceeded"
  | "daily_aggregate_exceeded"
  | "risk_tier_exceeded";

/** Initialization options for {@link GovernanceEnforcementError}. */
export interface GovernanceEnforcementErrorInit {
  gate: GovernanceGate;
  denyCode: string;
  reason: string;
  details: unknown;
  requestId?: string;
}

/**
 * Thrown when an EGAS advisory result fails an enforcement gate.
 *
 * Extends {@link AtlaSentError} so `instanceof AtlaSentError` catches
 * these too. Use `instanceof GovernanceEnforcementError` to distinguish
 * a governance refusal from a transport / config error.
 */
export class GovernanceEnforcementError extends AtlaSentError {
  override name: string = "GovernanceEnforcementError";

  /** Which gate fired (`financial_quorum` / `budget` / `autonomous_bounds`). */
  readonly gate: GovernanceGate;
  /** Stable taxonomy code; maps to a row in `docs/APPROVAL_DENY_REASONS.md`. */
  readonly denyCode: string;
  /** Human-readable explanation. Do NOT branch on this string — branch on `denyCode`. */
  readonly reason: string;
  /** The structured advisory result that produced the denial. */
  readonly details: unknown;

  constructor(init: GovernanceEnforcementErrorInit) {
    const errInit: AtlaSentErrorInit = { code: "forbidden" };
    if (init.requestId !== undefined) errInit.requestId = init.requestId;
    super(`[${init.gate}/${init.denyCode}] ${init.reason}`, errInit);
    this.gate = init.gate;
    this.denyCode = init.denyCode;
    this.reason = init.reason;
    this.details = init.details;
  }

  /** Combined `<gate>/<denyCode>` string used in audit records. */
  get fullyQualifiedCode(): string {
    return `${this.gate}/${this.denyCode}`;
  }
}

// ─── financial_quorum ─────────────────────────────────────────────────

function financialQuorumDenyCode(
  result: FinancialQuorumResult,
): FinancialQuorumDenyCode {
  // Order matches evaluateFinancialQuorum so first-failing-gate wins
  // produces the same code in TS and Python.
  if (result.blocked_by_freeze) return "blocked_by_emergency_freeze";
  if (!result.base_quorum_passed) return "base_count_unmet";
  if (!result.amount_threshold_satisfied) return "amount_threshold_unmet";
  if (!result.financial_roles_satisfied) return "financial_role_unmet";
  if (result.regulator_approval_missing) return "regulator_approval_missing";
  // Defensive fallback; unreachable when result.passed is false.
  return "base_count_unmet";
}

/**
 * Throw {@link GovernanceEnforcementError} when a quorum result fails.
 * Returns silently when `result.passed` is true.
 */
export function enforceFinancialQuorum(result: FinancialQuorumResult): void {
  if (result.passed) return;
  const denyCode = financialQuorumDenyCode(result);
  throw new GovernanceEnforcementError({
    gate: "financial_quorum",
    denyCode,
    reason: result.denial_reason ?? `financial quorum failed: ${denyCode}`,
    details: result,
  });
}

// ─── budget ─────────────────────────────────────────────────────────────────

/**
 * Throw {@link GovernanceEnforcementError} on a budget hard block.
 *
 * Returns silently when `result.permitted` is true (no hard blocks; soft
 * warnings do not cause enforcement to fire).
 */
export function enforceBudgetConstraint(result: BudgetConstraintCheckResult): void {
  if (result.permitted) return;
  if (result.hard_blocks.length === 0) {
    // Defensive: permitted=false without a hard block is a contract bug.
    throw new GovernanceEnforcementError({
      gate: "budget",
      denyCode: "limit_exceeded",
      reason: "budget enforcement failed without a structured violation",
      details: result,
    });
  }
  const first = result.hard_blocks[0]!;
  throw new GovernanceEnforcementError({
    gate: "budget",
    denyCode: first.violation_type,
    reason: first.description,
    details: result,
  });
}

// ─── autonomous_bounds ────────────────────────────────────────────────────

function autonomousBoundsDenyCode(
  result: AutonomousExecutionCheckResult,
): AutonomousBoundsDenyCode {
  // Order matches checkAutonomousBounds.
  if (!result.bounds_active) return "inactive";
  if (!result.bounds_not_expired) return "expired";
  if (!result.action_type_permitted) return "action_type_not_permitted";
  if (!result.within_execution_ceiling) return "execution_ceiling_exceeded";
  if (!result.within_daily_aggregate) return "daily_aggregate_exceeded";
  if (!result.within_risk_tier) return "risk_tier_exceeded";
  return "inactive";
}

/**
 * Throw {@link GovernanceEnforcementError} when autonomous bounds fail.
 * Returns silently when `result.permitted` is true.
 */
export function enforceAutonomousBounds(
  result: AutonomousExecutionCheckResult,
): void {
  if (result.permitted) return;
  const denyCode = autonomousBoundsDenyCode(result);
  throw new GovernanceEnforcementError({
    gate: "autonomous_bounds",
    denyCode,
    reason:
      result.denial_reason ??
      `autonomous execution out of bounds: ${denyCode}`,
    details: result,
  });
}

/**
 * Convenience: layer all three gates in canonical order.
 *
 * Order: quorum (who approved) → budget (does it fit policy spend) →
 * autonomous_bounds (is the agent allowed to do this autonomously). The
 * first failing gate throws; subsequent gates are not evaluated.
 *
 * Pass `undefined` for gates that don't apply (e.g. omit `autonomous` for
 * human-initiated actions).
 */
export function enforceEconomicGovernance(params: {
  quorum?: FinancialQuorumResult;
  budget?: BudgetConstraintCheckResult;
  autonomous?: AutonomousExecutionCheckResult;
}): void {
  if (params.quorum !== undefined) enforceFinancialQuorum(params.quorum);
  if (params.budget !== undefined) enforceBudgetConstraint(params.budget);
  if (params.autonomous !== undefined) enforceAutonomousBounds(params.autonomous);
}
