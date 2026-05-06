/**
 * Tests for the Financial Quorum layer.
 *
 * Covers: base quorum enforcement, amount threshold escalation, financial
 * role requirements, regulator approval thresholds, emergency freeze
 * blocking, and lifted-freeze pass-through.
 */
import { describe, expect, it } from "vitest";
import {
  computeEscalatedApprovalCount,
  evaluateFinancialQuorum,
  type EmergencyFreeze,
  type FinancialQuorumInput,
  type FinancialQuorumPolicy,
} from "../src/financialQuorum.js";

const BASE_POLICY: FinancialQuorumPolicy = {
  required_count: 2,
  financial_role_requirements: [],
  amount_thresholds: [],
  reference_currency: "USD",
  emergency_freeze_active: false,
  regulator_approval_threshold: null,
  dual_release_threshold: null,
};

const BASE_INPUT: FinancialQuorumInput = {
  policy: BASE_POLICY,
  action_value: 5_000,
  risk_tier: "medium",
  present_roles: { finance_manager: 2 },
  approval_count: 2,
  regulator_approval_present: false,
  base_quorum_proof: null,
  active_freezes: [],
};

function makeFreezeRecord(overrides: Partial<EmergencyFreeze> = {}): EmergencyFreeze {
  return {
    freeze_id:    "frz-001",
    scope_id:     "org-abc",
    scope_type:   "org",
    triggered_by: "cso-001",
    reason:       "security incident",
    triggered_at: "2026-01-01T00:00:00Z",
    expires_at:   null,
    lifted:       false,
    lifted_at:    null,
    lifted_by:    null,
    ...overrides,
  };
}

describe("evaluateFinancialQuorum", () => {
  it("passes when base count met with no special requirements", () => {
    const result = evaluateFinancialQuorum(BASE_INPUT);
    expect(result.passed).toBe(true);
    expect(result.denial_reason).toBeNull();
    expect(result.unmet_requirements).toHaveLength(0);
  });

  it("fails when approval count below required_count", () => {
    const result = evaluateFinancialQuorum({ ...BASE_INPUT, approval_count: 1 });
    expect(result.passed).toBe(false);
    expect(result.base_quorum_passed).toBe(false);
    expect(result.unmet_requirements.length).toBeGreaterThan(0);
  });

  it("passes when base_quorum_proof supplied even if count is low", () => {
    const proof = { quorum_hash: "abc", approval_ids: ["a", "b"] };
    const result = evaluateFinancialQuorum({
      ...BASE_INPUT,
      approval_count: 0,
      base_quorum_proof: proof,
    });
    expect(result.base_quorum_passed).toBe(true);
  });

  it("blocks on active emergency freeze before any other check", () => {
    const result = evaluateFinancialQuorum({
      ...BASE_INPUT,
      active_freezes: [makeFreezeRecord()],
    });
    expect(result.passed).toBe(false);
    expect(result.blocked_by_freeze).toBe(true);
    expect(result.denial_reason).toContain("frz-001");
  });

  it("does not block on a lifted freeze", () => {
    const lifted = makeFreezeRecord({ lifted: true, lifted_at: "2026-01-02T00:00:00Z", lifted_by: "cso-001" });
    const result = evaluateFinancialQuorum({ ...BASE_INPUT, active_freezes: [lifted] });
    expect(result.blocked_by_freeze).toBe(false);
    expect(result.passed).toBe(true);
  });

  it("fails when amount threshold requires additional approvals", () => {
    const policy: FinancialQuorumPolicy = {
      ...BASE_POLICY,
      amount_thresholds: [{
        value: 1_000, currency: "USD",
        additional_approvals: 2, additional_roles: [], senior_review_required: false,
      }],
    };
    const result = evaluateFinancialQuorum({ ...BASE_INPUT, policy, action_value: 10_000, approval_count: 2 });
    expect(result.passed).toBe(false);
    expect(result.amount_threshold_satisfied).toBe(false);
  });

  it("passes amount threshold when adequate approvals present", () => {
    const policy: FinancialQuorumPolicy = {
      ...BASE_POLICY,
      amount_thresholds: [{
        value: 1_000, currency: "USD",
        additional_approvals: 2, additional_roles: [], senior_review_required: false,
      }],
    };
    const result = evaluateFinancialQuorum({ ...BASE_INPUT, policy, action_value: 10_000, approval_count: 4 });
    expect(result.amount_threshold_satisfied).toBe(true);
  });

  it("fails when financial role requirement not met", () => {
    const policy: FinancialQuorumPolicy = {
      ...BASE_POLICY,
      financial_role_requirements: [{ role: "cfo", min: 1 }],
    };
    const result = evaluateFinancialQuorum({
      ...BASE_INPUT, policy, present_roles: { finance_manager: 2 },
    });
    expect(result.passed).toBe(false);
    expect(result.financial_roles_satisfied).toBe(false);
    expect(result.unmet_requirements.some((r) => r.includes("cfo"))).toBe(true);
  });

  it("passes when financial role requirement is met", () => {
    const policy: FinancialQuorumPolicy = {
      ...BASE_POLICY,
      financial_role_requirements: [{ role: "cfo", min: 1 }],
    };
    const result = evaluateFinancialQuorum({
      ...BASE_INPUT, policy, present_roles: { cfo: 1, finance_manager: 1 },
    });
    expect(result.financial_roles_satisfied).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("requires regulator approval when value is above threshold", () => {
    const policy: FinancialQuorumPolicy = {
      ...BASE_POLICY, regulator_approval_threshold: 500_000,
    };
    const result = evaluateFinancialQuorum({
      ...BASE_INPUT, policy, action_value: 1_000_000, regulator_approval_present: false,
    });
    expect(result.passed).toBe(false);
    expect(result.regulator_approval_missing).toBe(true);
  });

  it("passes regulator threshold when approval is present", () => {
    const policy: FinancialQuorumPolicy = {
      ...BASE_POLICY, regulator_approval_threshold: 500_000,
    };
    const result = evaluateFinancialQuorum({
      ...BASE_INPUT, policy, action_value: 1_000_000, regulator_approval_present: true,
    });
    expect(result.regulator_approval_missing).toBe(false);
    expect(result.passed).toBe(true);
  });

  it("role requirement with tier filter skips non-matching tier", () => {
    const policy: FinancialQuorumPolicy = {
      ...BASE_POLICY,
      financial_role_requirements: [{ role: "cfo", min: 1, applies_to_tiers: ["critical"] }],
    };
    const result = evaluateFinancialQuorum({
      ...BASE_INPUT, policy, risk_tier: "medium", present_roles: { finance_manager: 2 },
    });
    expect(result.passed).toBe(true);
  });

  it("amount threshold senior_review block fires correctly", () => {
    const policy: FinancialQuorumPolicy = {
      ...BASE_POLICY,
      amount_thresholds: [{
        value: 1_000, currency: "USD",
        additional_approvals: 0, additional_roles: [], senior_review_required: true,
      }],
    };
    const result = evaluateFinancialQuorum({
      ...BASE_INPUT, policy, action_value: 5_000, present_roles: { finance_manager: 2 },
    });
    expect(result.amount_threshold_satisfied).toBe(false);
    expect(result.unmet_requirements.some((r) => r.includes("senior_finance"))).toBe(true);
  });
});

describe("computeEscalatedApprovalCount", () => {
  it("returns base count when no thresholds apply", () => {
    const thresholds = [{ value: 100_000, currency: "USD" as const, additional_approvals: 2, additional_roles: [], senior_review_required: false }];
    expect(computeEscalatedApprovalCount(2, 50_000, thresholds)).toBe(2);
  });

  it("picks the largest additional_approvals when multiple thresholds crossed", () => {
    const thresholds = [
      { value: 50_000,  currency: "USD" as const, additional_approvals: 1, additional_roles: [], senior_review_required: false },
      { value: 100_000, currency: "USD" as const, additional_approvals: 3, additional_roles: [], senior_review_required: false },
    ];
    expect(computeEscalatedApprovalCount(2, 150_000, thresholds)).toBe(5);
  });

  it("handles empty thresholds array", () => {
    expect(computeEscalatedApprovalCount(2, 999_999, [])).toBe(2);
  });
});
