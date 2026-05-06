/**
 * Financial Quorum — extends the AtlaSent approval quorum model with
 * monetary thresholds, dynamic escalation, and emergency freeze support.
 *
 * Builds on the base QuorumPolicy in approvalQuorum.ts. Every financial
 * quorum check MUST first satisfy base quorum requirements before
 * financial-layer policy is evaluated.
 *
 * Wire-stable as `financial_quorum.v1`.
 */

import type { QuorumPolicy, QuorumProof } from "./approvalQuorum.js";
import type { CurrencyCode, FinancialRiskTier } from "./financialAction.js";

/** A financial role requirement with optional monetary and tier filters. */
export interface FinancialRoleRequirement {
  readonly role: string;
  readonly min: number;
  /** Only apply this requirement when action value >= this amount. */
  readonly applies_above?: number;
  /** Only apply when the action's risk_tier is in this set. */
  readonly applies_to_tiers?: readonly FinancialRiskTier[];
}

/** Amount-based threshold that triggers additional quorum requirements. */
export interface AmountThreshold {
  readonly value: number;
  readonly currency: CurrencyCode;
  readonly additional_approvals: number;
  readonly additional_roles: readonly FinancialRoleRequirement[];
  readonly senior_review_required: boolean;
}

/**
 * Financial quorum policy.
 *
 * Extends the base QuorumPolicy with amount thresholds, financial role
 * requirements, regulator approval thresholds, and emergency freeze.
 */
export interface FinancialQuorumPolicy extends QuorumPolicy {
  readonly financial_role_requirements: readonly FinancialRoleRequirement[];
  readonly amount_thresholds: readonly AmountThreshold[];
  readonly reference_currency: CurrencyCode;
  readonly emergency_freeze_active: boolean;
  /** Regulator approval required above this value (null = not required). */
  readonly regulator_approval_threshold: number | null;
  /** Customer + vendor dual-release required above this value. */
  readonly dual_release_threshold: number | null;
}

/** Emergency freeze record — applied org-wide or per scope. */
export interface EmergencyFreeze {
  readonly freeze_id: string;
  readonly scope_id: string;
  readonly scope_type: "org" | "department" | "action_class";
  readonly triggered_by: string;
  readonly reason: string;
  readonly triggered_at: string;
  readonly expires_at: string | null;
  readonly lifted: boolean;
  readonly lifted_at: string | null;
  readonly lifted_by: string | null;
}

/** Result of evaluating a financial quorum. */
export interface FinancialQuorumResult {
  readonly passed: boolean;
  readonly base_quorum_passed: boolean;
  readonly amount_threshold_satisfied: boolean;
  readonly financial_roles_satisfied: boolean;
  readonly regulator_approval_missing: boolean;
  readonly blocked_by_freeze: boolean;
  readonly base_quorum_proof: QuorumProof | null;
  readonly denial_reason: string | null;
  readonly unmet_requirements: readonly string[];
}

/** Input to financial quorum evaluation. */
export interface FinancialQuorumInput {
  readonly policy: FinancialQuorumPolicy;
  readonly action_value: number;
  readonly risk_tier: FinancialRiskTier;
  /** Roles present in the approval set (role → count). */
  readonly present_roles: Record<string, number>;
  readonly approval_count: number;
  readonly regulator_approval_present: boolean;
  readonly base_quorum_proof: QuorumProof | null;
  readonly active_freezes: readonly EmergencyFreeze[];
}

/**
 * Evaluate a financial quorum policy.
 *
 * Checks in order: emergency freeze → base count → amount thresholds
 * → financial roles → regulator approval.
 */
export function evaluateFinancialQuorum(input: FinancialQuorumInput): FinancialQuorumResult {
  const unmet: string[] = [];

  // Hard block: emergency freeze
  const activeFreeze = input.active_freezes.find((f) => !f.lifted);
  if (activeFreeze) {
    return {
      passed: false,
      base_quorum_passed: false,
      amount_threshold_satisfied: false,
      financial_roles_satisfied: false,
      regulator_approval_missing: false,
      blocked_by_freeze: true,
      base_quorum_proof: null,
      denial_reason: `action blocked by emergency freeze (${activeFreeze.freeze_id}): ${activeFreeze.reason}`,
      unmet_requirements: [`emergency_freeze:${activeFreeze.freeze_id}`],
    };
  }

  // Base quorum
  const baseQuorumPassed =
    input.base_quorum_proof !== null ||
    input.approval_count >= input.policy.required_count;
  if (!baseQuorumPassed) {
    unmet.push(
      `base quorum requires ${input.policy.required_count} approvals, have ${input.approval_count}`,
    );
  }

  // Amount threshold escalation
  let amountThresholdSatisfied = true;
  for (const threshold of input.policy.amount_thresholds) {
    if (input.action_value >= threshold.value) {
      const needed = input.policy.required_count + threshold.additional_approvals;
      if (input.approval_count < needed) {
        amountThresholdSatisfied = false;
        unmet.push(
          `amount threshold ${threshold.value} ${threshold.currency} requires ${needed} approvals`,
        );
      }
      for (const req of threshold.additional_roles) {
        const present = input.present_roles[req.role] ?? 0;
        if (present < req.min) {
          amountThresholdSatisfied = false;
          unmet.push(`amount threshold requires ${req.min} ${req.role} approver(s), have ${present}`);
        }
      }
      if (threshold.senior_review_required && !(input.present_roles["senior_finance"] ?? 0)) {
        amountThresholdSatisfied = false;
        unmet.push("amount threshold requires senior_finance review");
      }
    }
  }

  // Financial role requirements
  let financialRolesSatisfied = true;
  for (const req of input.policy.financial_role_requirements) {
    if (req.applies_to_tiers && !req.applies_to_tiers.includes(input.risk_tier)) continue;
    if (req.applies_above !== undefined && input.action_value < req.applies_above) continue;
    const present = input.present_roles[req.role] ?? 0;
    if (present < req.min) {
      financialRolesSatisfied = false;
      unmet.push(`financial role ${req.role} requires ${req.min} approver(s), have ${present}`);
    }
  }

  // Regulator approval
  const regulatorMissing =
    input.policy.regulator_approval_threshold !== null &&
    input.action_value >= input.policy.regulator_approval_threshold &&
    !input.regulator_approval_present;
  if (regulatorMissing) {
    unmet.push("regulator approval required for this action value");
  }

  const passed =
    baseQuorumPassed &&
    amountThresholdSatisfied &&
    financialRolesSatisfied &&
    !regulatorMissing;

  return {
    passed,
    base_quorum_passed: baseQuorumPassed,
    amount_threshold_satisfied: amountThresholdSatisfied,
    financial_roles_satisfied: financialRolesSatisfied,
    regulator_approval_missing: regulatorMissing,
    blocked_by_freeze: false,
    base_quorum_proof: input.base_quorum_proof,
    denial_reason: passed ? null : (unmet[0] ?? "financial quorum not satisfied"),
    unmet_requirements: unmet,
  };
}

/**
 * Determine the escalated minimum approval count for a given action value.
 * Returns base count plus the largest additional_approvals from matching thresholds.
 */
export function computeEscalatedApprovalCount(
  baseCount: number,
  actionValue: number,
  thresholds: readonly AmountThreshold[],
): number {
  let additional = 0;
  for (const t of thresholds) {
    if (actionValue >= t.value) {
      additional = Math.max(additional, t.additional_approvals);
    }
  }
  return baseCount + additional;
}
