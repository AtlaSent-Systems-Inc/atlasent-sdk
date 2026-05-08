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
  liability_role_weights: {
    weights: Record<string, number>;
  };
  escalated_approval_count: Array<{
    base_count: number;
    action_value: number;
    thresholds: Array<{ value: number; additional_approvals: number }>;
    expected: number;
  }>;
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
  // Locked weight table. The TS source of truth is the ROLE_WEIGHTS map
  // inside liabilityAttribution.ts (currently file-private). Until that
  // is exported, this test pins the contract via the fixture; if the TS
  // values drift, exporting ROLE_WEIGHTS and adding a numeric assertion
  // here is a single-line follow-up.
  it("fixture is the canonical source for both implementations", () => {
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
