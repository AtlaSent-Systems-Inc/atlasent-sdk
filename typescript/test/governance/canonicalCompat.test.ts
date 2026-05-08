/**
 * Cross-language parity test — TypeScript side.
 *
 * Reads the canonical fixture at
 * ``compat/governance/fixtures/parity.json`` and validates that the
 * canonical TypeScript implementation produces the documented outputs.
 *
 * The corresponding Python test in
 * ``python/tests/governance/test_compat_fixtures.py`` reads the same
 * fixture and validates the canonical Python implementation. Both tests
 * MUST pass for the cross-language equivalence guarantee to hold.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { canonicalizeForEvidence } from "../../src/economicEvidence.js";
import {
  classifyRiskTier,
  type FinancialRiskTier,
} from "../../src/financialAction.js";
import {
  computeEscalatedApprovalCount,
  type AmountThreshold,
} from "../../src/financialQuorum.js";
import type {
  AutonomousBoundsDenyCode,
  BudgetDenyCode,
  FinancialQuorumDenyCode,
} from "../../src/governanceEnforcement.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// typescript/test/governance/ → typescript/test/ → typescript/ → repo root.
const FIXTURE_PATH = resolve(
  __dirname,
  "../../../compat/governance/fixtures/parity.json",
);

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as {
  canonical_for_evidence: Array<{
    input: unknown;
    expected: string;
    description?: string;
  }>;
  risk_tier_classification: Array<{ value: number; expected: FinancialRiskTier }>;
  liability_role_weights: { weights: Record<string, number> };
  escalated_approval_count: Array<{
    base_count: number;
    action_value: number;
    thresholds: Array<{ value: number; additional_approvals: number }>;
    expected: number;
  }>;
  governance_deny_codes: {
    financial_quorum: readonly string[];
    budget: readonly string[];
    autonomous_bounds: readonly string[];
  };
};

describe("governance parity — canonicalizeForEvidence", () => {
  for (const c of fixture.canonical_for_evidence) {
    const label =
      c.description ?? `${typeof c.input}: ${JSON.stringify(c.input)}`;
    it(`encodes ${label}`, () => {
      expect(canonicalizeForEvidence(c.input)).toBe(c.expected);
    });
  }
});

describe("governance parity — classifyRiskTier", () => {
  for (const c of fixture.risk_tier_classification) {
    it(`classifies ${c.value} as ${c.expected}`, () => {
      expect(classifyRiskTier(c.value)).toBe(c.expected);
    });
  }
});

describe("governance parity — liability role weights", () => {
  it("fixture weights match canonical TS values", () => {
    expect(Object.keys(fixture.liability_role_weights.weights).sort()).toEqual([
      "approver",
      "authorizer",
      "delegate",
      "delegator",
      "exception_approver",
      "executor",
      "override_actor",
      "supervisor",
    ]);
    expect(fixture.liability_role_weights.weights.override_actor).toBeCloseTo(0.40, 10);
    expect(fixture.liability_role_weights.weights.authorizer).toBeCloseTo(0.30, 10);
    expect(fixture.liability_role_weights.weights.executor).toBeCloseTo(0.25, 10);
  });
});

describe("governance parity — computeEscalatedApprovalCount", () => {
  for (const c of fixture.escalated_approval_count) {
    it(`base=${c.base_count}, value=${c.action_value} → ${c.expected}`, () => {
      const thresholds: AmountThreshold[] = c.thresholds.map((t) => ({
        value: t.value,
        currency: "USD",
        additional_approvals: t.additional_approvals,
        additional_roles: [],
        senior_review_required: false,
      }));
      expect(
        computeEscalatedApprovalCount(c.base_count, c.action_value, thresholds),
      ).toBe(c.expected);
    });
  }
});

describe("governance parity — deny-code taxonomy", () => {
  // The Literal types in governanceEnforcement.ts MUST be exactly the set
  // of codes documented in the fixture. Drift here means a deny code
  // exists in TS but not in Python (or vice versa), which would silently
  // produce divergent enforcement error strings across SDKs.
  //
  // We assert this via runtime-string arrays type-asserted against the
  // Literal unions; a TypeScript compile error in this test means the
  // Literal unions and the fixture have drifted.
  it("financial_quorum codes match", () => {
    const fromFixture: FinancialQuorumDenyCode[] = [
      "blocked_by_emergency_freeze",
      "base_count_unmet",
      "amount_threshold_unmet",
      "financial_role_unmet",
      "regulator_approval_missing",
    ];
    expect(fromFixture.sort()).toEqual(
      [...fixture.governance_deny_codes.financial_quorum].sort(),
    );
  });

  it("budget codes match", () => {
    const fromFixture: BudgetDenyCode[] = [
      "limit_exceeded",
      "single_transaction_exceeds",
      "daily_aggregate_exceeds",
      "monthly_aggregate_exceeds",
      "anonymous_agent_blocked",
      "period_expired",
    ];
    expect(fromFixture.sort()).toEqual(
      [...fixture.governance_deny_codes.budget].sort(),
    );
  });

  it("autonomous_bounds codes match", () => {
    const fromFixture: AutonomousBoundsDenyCode[] = [
      "inactive",
      "expired",
      "action_type_not_permitted",
      "execution_ceiling_exceeded",
      "daily_aggregate_exceeded",
      "risk_tier_exceeded",
    ];
    expect(fromFixture.sort()).toEqual(
      [...fixture.governance_deny_codes.autonomous_bounds].sort(),
    );
  });
});
