/**
 * Tests for Budgetary Governance — constraint checking and enforcement.
 *
 * Covers: limit exceeded, single-transaction limit, daily/monthly aggregate,
 * anonymous agent blocking, period expiry, and soft-warn enforcement.
 */
import { describe, expect, it } from "vitest";
import {
  budgetUtilizationSeverity,
  checkBudgetConstraints,
  type BudgetLimit,
  type BudgetSpendingState,
  type SpendingConstraint,
} from "../src/budgetaryGovernance.js";

function makeLimit(
  overrides: Partial<BudgetLimit & { spending: BudgetSpendingState }> = {},
): BudgetLimit & { spending: BudgetSpendingState } {
  const limit: BudgetLimit = {
    limit_id:    "lim-001",
    org_id:      "org-abc",
    scope_type:  "org",
    scope_id:    "org-abc",
    limit_amount: 100_000,
    currency:    "USD",
    enforcement: "hard",
    period_start: null,
    period_end:  null,
    active:      true,
    created_by:  "user-cfo",
    created_at:  "2026-01-01T00:00:00Z",
    ...overrides,
  };
  const spending: BudgetSpendingState = {
    limit_id:         limit.limit_id,
    spent_amount:     overrides["spent_amount" as keyof typeof overrides] as number ?? 0,
    remaining_amount: limit.limit_amount,
    exceeded:         false,
    utilization_pct:  0,
    updated_at:       "2026-01-01T00:00:00Z",
    ...(overrides as Partial<BudgetSpendingState>),
  };
  return { ...limit, spending };
}

const BASE_PARAMS = {
  actionValue:          5_000,
  currency:             "USD" as const,
  actionType:           "wire_transfer" as const,
  riskTier:             "medium" as const,
  isAnonymousAgent:     false,
  currentDailySpend:    0,
  currentMonthlySpend:  0,
  applicableLimits:     [] as (BudgetLimit & { spending: BudgetSpendingState })[],
  applicableConstraints: [] as SpendingConstraint[],
};

describe("checkBudgetConstraints", () => {
  it("permits when no limits or constraints apply", () => {
    const result = checkBudgetConstraints(BASE_PARAMS);
    expect(result.permitted).toBe(true);
    expect(result.hard_blocks).toHaveLength(0);
  });

  it("blocks (hard) when limit would be exceeded", () => {
    const limit = makeLimit({ limit_amount: 10_000 });
    limit.spending.spent_amount = 8_000;
    const result = checkBudgetConstraints({
      ...BASE_PARAMS,
      actionValue: 5_000,
      applicableLimits: [limit],
    });
    expect(result.permitted).toBe(false);
    expect(result.hard_blocks[0]?.violation_type).toBe("limit_exceeded");
  });

  it("warns (soft) when soft-enforcement limit exceeded", () => {
    const limit = makeLimit({ limit_amount: 10_000, enforcement: "soft" });
    limit.spending.spent_amount = 8_000;
    const result = checkBudgetConstraints({
      ...BASE_PARAMS,
      actionValue: 5_000,
      applicableLimits: [limit],
    });
    expect(result.permitted).toBe(true);
    expect(result.soft_warnings[0]?.violation_type).toBe("limit_exceeded");
  });

  it("blocks when single-transaction constraint exceeded", () => {
    const constraint: SpendingConstraint = {
      constraint_id:           "con-001",
      org_id:                  "org-abc",
      action_type:             "*",
      max_single_transaction:  3_000,
      max_daily_aggregate:     null,
      max_monthly_aggregate:   null,
      currency:                "USD",
      applies_to_tier_gte:     null,
      allow_anonymous_agents:  true,
      active:                  true,
    };
    const result = checkBudgetConstraints({
      ...BASE_PARAMS,
      actionValue: 5_000,
      applicableConstraints: [constraint],
    });
    expect(result.permitted).toBe(false);
    expect(result.hard_blocks[0]?.violation_type).toBe("single_transaction_exceeds");
  });

  it("blocks when daily aggregate would be exceeded", () => {
    const constraint: SpendingConstraint = {
      constraint_id:          "con-002",
      org_id:                 "org-abc",
      action_type:            "*",
      max_single_transaction: 100_000,
      max_daily_aggregate:    20_000,
      max_monthly_aggregate:  null,
      currency:               "USD",
      applies_to_tier_gte:    null,
      allow_anonymous_agents: true,
      active:                 true,
    };
    const result = checkBudgetConstraints({
      ...BASE_PARAMS,
      actionValue: 5_000,
      currentDailySpend: 18_000,
      applicableConstraints: [constraint],
    });
    expect(result.permitted).toBe(false);
    expect(result.hard_blocks[0]?.violation_type).toBe("daily_aggregate_exceeds");
  });

  it("blocks when monthly aggregate would be exceeded", () => {
    const constraint: SpendingConstraint = {
      constraint_id:          "con-003",
      org_id:                 "org-abc",
      action_type:            "*",
      max_single_transaction: 100_000,
      max_daily_aggregate:    null,
      max_monthly_aggregate:  50_000,
      currency:               "USD",
      applies_to_tier_gte:    null,
      allow_anonymous_agents: true,
      active:                 true,
    };
    const result = checkBudgetConstraints({
      ...BASE_PARAMS,
      actionValue: 5_000,
      currentMonthlySpend: 48_000,
      applicableConstraints: [constraint],
    });
    expect(result.permitted).toBe(false);
    expect(result.hard_blocks[0]?.violation_type).toBe("monthly_aggregate_exceeds");
  });

  it("blocks anonymous agents when constraint disallows them", () => {
    const constraint: SpendingConstraint = {
      constraint_id:          "con-004",
      org_id:                 "org-abc",
      action_type:            "*",
      max_single_transaction: 100_000,
      max_daily_aggregate:    null,
      max_monthly_aggregate:  null,
      currency:               "USD",
      applies_to_tier_gte:    null,
      allow_anonymous_agents: false,
      active:                 true,
    };
    const result = checkBudgetConstraints({
      ...BASE_PARAMS,
      isAnonymousAgent: true,
      applicableConstraints: [constraint],
    });
    expect(result.permitted).toBe(false);
    expect(result.hard_blocks[0]?.violation_type).toBe("anonymous_agent_blocked");
  });

  it("blocks when limit period has expired", () => {
    const limit = makeLimit({ period_end: "2025-12-31T23:59:59Z", enforcement: "hard" });
    const result = checkBudgetConstraints({
      ...BASE_PARAMS,
      applicableLimits: [limit],
      now: new Date("2026-01-15T12:00:00Z"),
    });
    expect(result.permitted).toBe(false);
    expect(result.hard_blocks[0]?.violation_type).toBe("period_expired");
  });

  it("action-type specific constraint only applies to matching type", () => {
    const constraint: SpendingConstraint = {
      constraint_id:          "con-005",
      org_id:                 "org-abc",
      action_type:            "payroll_execution",
      max_single_transaction: 100,
      max_daily_aggregate:    null,
      max_monthly_aggregate:  null,
      currency:               "USD",
      applies_to_tier_gte:    null,
      allow_anonymous_agents: true,
      active:                 true,
    };
    const result = checkBudgetConstraints({
      ...BASE_PARAMS,
      actionType: "wire_transfer",
      actionValue: 50_000,
      applicableConstraints: [constraint],
    });
    expect(result.permitted).toBe(true);
  });

  it("records checked limit IDs in result", () => {
    const limit = makeLimit({ limit_id: "lim-xyz" });
    const result = checkBudgetConstraints({
      ...BASE_PARAMS,
      applicableLimits: [limit],
    });
    expect(result.limits_checked).toContain("lim-xyz");
  });
});

describe("budgetUtilizationSeverity", () => {
  it("returns normal below 80%", () => {
    expect(budgetUtilizationSeverity(50)).toBe("normal");
  });

  it("returns warn at 80%", () => {
    expect(budgetUtilizationSeverity(80)).toBe("warn");
  });

  it("returns critical at 100%", () => {
    expect(budgetUtilizationSeverity(100)).toBe("critical");
  });

  it("returns critical above 100%", () => {
    expect(budgetUtilizationSeverity(150)).toBe("critical");
  });
});
