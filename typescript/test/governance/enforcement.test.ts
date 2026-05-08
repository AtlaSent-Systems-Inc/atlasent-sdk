import { describe, expect, it } from "vitest";

import { AtlaSentError } from "../../src/errors.js";
import type { AutonomousExecutionCheckResult } from "../../src/autonomousFinancial.js";
import type { BudgetConstraintCheckResult } from "../../src/budgetaryGovernance.js";
import type { FinancialQuorumResult } from "../../src/financialQuorum.js";
import {
  GovernanceEnforcementError,
  enforceAutonomousBounds,
  enforceBudgetConstraint,
  enforceEconomicGovernance,
  enforceFinancialQuorum,
} from "../../src/governanceEnforcement.js";

function quorum(overrides: Partial<FinancialQuorumResult> = {}): FinancialQuorumResult {
  return {
    passed: false,
    base_quorum_passed: true,
    amount_threshold_satisfied: true,
    financial_roles_satisfied: true,
    regulator_approval_missing: false,
    blocked_by_freeze: false,
    base_quorum_proof: null,
    denial_reason: null,
    unmet_requirements: [],
    ...overrides,
  };
}

function budget(
  hardBlocks: BudgetConstraintCheckResult["hard_blocks"] = [],
): BudgetConstraintCheckResult {
  return {
    permitted: hardBlocks.length === 0,
    hard_blocks: hardBlocks,
    soft_warnings: [],
    limits_checked: [],
    constraints_checked: [],
  };
}

function autonomous(
  overrides: Partial<AutonomousExecutionCheckResult> = {},
): AutonomousExecutionCheckResult {
  return {
    permitted: false,
    action_type_permitted: true,
    within_execution_ceiling: true,
    within_daily_aggregate: true,
    within_risk_tier: true,
    bounds_active: true,
    bounds_not_expired: true,
    applicable_ceiling: null,
    denial_reason: null,
    violations: [],
    ...overrides,
  };
}

describe("enforceFinancialQuorum", () => {
  it("passes silently when quorum.passed", () => {
    expect(() => enforceFinancialQuorum(quorum({ passed: true }))).not.toThrow();
  });

  it("freeze beats every other failing check (deny order)", () => {
    expect(() =>
      enforceFinancialQuorum(
        quorum({
          blocked_by_freeze: true,
          base_quorum_passed: false,
          amount_threshold_satisfied: false,
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        gate: "financial_quorum",
        denyCode: "blocked_by_emergency_freeze",
      }),
    );
  });

  it("emits base_count_unmet", () => {
    try {
      enforceFinancialQuorum(quorum({ base_quorum_passed: false }));
    } catch (e) {
      expect(e).toBeInstanceOf(GovernanceEnforcementError);
      expect((e as GovernanceEnforcementError).denyCode).toBe("base_count_unmet");
      return;
    }
    throw new Error("expected enforceFinancialQuorum to throw");
  });

  it("emits amount_threshold_unmet", () => {
    try {
      enforceFinancialQuorum(quorum({ amount_threshold_satisfied: false }));
    } catch (e) {
      expect((e as GovernanceEnforcementError).denyCode).toBe("amount_threshold_unmet");
      return;
    }
    throw new Error("expected throw");
  });

  it("emits financial_role_unmet", () => {
    try {
      enforceFinancialQuorum(quorum({ financial_roles_satisfied: false }));
    } catch (e) {
      expect((e as GovernanceEnforcementError).denyCode).toBe("financial_role_unmet");
      return;
    }
    throw new Error("expected throw");
  });

  it("emits regulator_approval_missing", () => {
    try {
      enforceFinancialQuorum(quorum({ regulator_approval_missing: true }));
    } catch (e) {
      expect((e as GovernanceEnforcementError).denyCode).toBe("regulator_approval_missing");
      return;
    }
    throw new Error("expected throw");
  });
});

describe("enforceBudgetConstraint", () => {
  it("passes silently when permitted", () => {
    expect(() => enforceBudgetConstraint(budget())).not.toThrow();
  });

  it("surfaces the first hard block as deny code", () => {
    try {
      enforceBudgetConstraint(
        budget([
          { violation_type: "single_transaction_exceeds", description: "first" },
          { violation_type: "daily_aggregate_exceeds", description: "second" },
        ]),
      );
    } catch (e) {
      expect((e as GovernanceEnforcementError).gate).toBe("budget");
      expect((e as GovernanceEnforcementError).denyCode).toBe(
        "single_transaction_exceeds",
      );
      return;
    }
    throw new Error("expected throw");
  });

  it("period_expired surfaces correctly", () => {
    try {
      enforceBudgetConstraint(
        budget([
          { violation_type: "period_expired", description: "period over" },
        ]),
      );
    } catch (e) {
      expect((e as GovernanceEnforcementError).denyCode).toBe("period_expired");
      return;
    }
    throw new Error("expected throw");
  });
});

describe("enforceAutonomousBounds", () => {
  it("passes silently when permitted", () => {
    expect(() => enforceAutonomousBounds(autonomous({ permitted: true }))).not.toThrow();
  });

  it("inactive beats every other failing check", () => {
    try {
      enforceAutonomousBounds(
        autonomous({
          bounds_active: false,
          bounds_not_expired: false,
          action_type_permitted: false,
          within_risk_tier: false,
        }),
      );
    } catch (e) {
      expect((e as GovernanceEnforcementError).denyCode).toBe("inactive");
      return;
    }
    throw new Error("expected throw");
  });

  it("emits each deny code in canonical order", () => {
    const cases: Array<{
      result: Partial<AutonomousExecutionCheckResult>;
      expected: string;
    }> = [
      { result: { bounds_active: false }, expected: "inactive" },
      { result: { bounds_not_expired: false }, expected: "expired" },
      { result: { action_type_permitted: false }, expected: "action_type_not_permitted" },
      { result: { within_execution_ceiling: false }, expected: "execution_ceiling_exceeded" },
      { result: { within_daily_aggregate: false }, expected: "daily_aggregate_exceeded" },
      { result: { within_risk_tier: false }, expected: "risk_tier_exceeded" },
    ];
    for (const c of cases) {
      try {
        enforceAutonomousBounds(autonomous(c.result));
        throw new Error(`expected throw for ${c.expected}`);
      } catch (e) {
        if (!(e instanceof GovernanceEnforcementError)) throw e;
        expect(e.denyCode).toBe(c.expected);
      }
    }
  });
});

describe("enforceEconomicGovernance", () => {
  it("passes when all gates permit", () => {
    expect(() =>
      enforceEconomicGovernance({
        quorum: quorum({ passed: true }),
        budget: budget(),
        autonomous: autonomous({ permitted: true }),
      }),
    ).not.toThrow();
  });

  it("short-circuits on quorum failure", () => {
    try {
      enforceEconomicGovernance({
        quorum: quorum({ base_quorum_passed: false }),
        budget: budget([
          { violation_type: "limit_exceeded", description: "would also fail" },
        ]),
        autonomous: autonomous({ bounds_active: false }),
      });
    } catch (e) {
      expect((e as GovernanceEnforcementError).gate).toBe("financial_quorum");
      expect((e as GovernanceEnforcementError).denyCode).toBe("base_count_unmet");
      return;
    }
    throw new Error("expected throw");
  });

  it("handles omitted gates", () => {
    expect(() =>
      enforceEconomicGovernance({ quorum: quorum({ passed: true }) }),
    ).not.toThrow();
  });
});

describe("GovernanceEnforcementError", () => {
  it("extends AtlaSentError", () => {
    try {
      enforceFinancialQuorum(quorum({ base_quorum_passed: false }));
    } catch (e) {
      expect(e).toBeInstanceOf(AtlaSentError);
      expect(e).toBeInstanceOf(GovernanceEnforcementError);
      return;
    }
    throw new Error("expected throw");
  });

  it("exposes a stable fully-qualified code", () => {
    try {
      enforceFinancialQuorum(quorum({ blocked_by_freeze: true }));
    } catch (e) {
      const err = e as GovernanceEnforcementError;
      expect(err.fullyQualifiedCode).toBe(
        "financial_quorum/blocked_by_emergency_freeze",
      );
      return;
    }
    throw new Error("expected throw");
  });

  it("sets code='forbidden' on the underlying AtlaSentError", () => {
    try {
      enforceFinancialQuorum(quorum({ base_quorum_passed: false }));
    } catch (e) {
      expect((e as AtlaSentError).code).toBe("forbidden");
      return;
    }
    throw new Error("expected throw");
  });
});
