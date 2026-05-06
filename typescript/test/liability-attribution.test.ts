/**
 * Tests for the Liability Attribution Engine.
 *
 * Covers: chain building, weight computation, primary party detection,
 * chain validation, delegation, supervisory, and emergency override paths.
 */
import { describe, expect, it } from "vitest";
import {
  buildLiabilityChain,
  computeLiabilityWeights,
  findPrimaryLiabilityParties,
  validateLiabilityChain,
  type LiabilityAttributionInput,
} from "../src/liabilityAttribution.js";

const AUTHORIZER = {
  party_id:    "user-cfo",
  party_label: "CFO",
  party_type:  "human" as const,
  acted_at:    "2026-01-01T10:00:00Z",
  permit_id:   "pmt-001",
};

const EXECUTOR = {
  party_id:    "agent-payments",
  party_label: "Payments Agent",
  party_type:  "agent" as const,
  acted_at:    "2026-01-01T10:05:00Z",
  permit_id:   "pmt-002",
};

const BASE_INPUT: LiabilityAttributionInput = {
  execution_id:     "exec-001",
  org_id:           "org-abc",
  classification:   "shared",
  risk_tier:        "medium",
  authorizer:       AUTHORIZER,
  executor:         EXECUTOR,
  approvers: [
    {
      party_id:    "user-fm",
      party_label: "Finance Manager",
      party_type:  "human",
      acted_at:    "2026-01-01T10:02:00Z",
      permit_id:   "pmt-003",
    },
  ],
};

describe("buildLiabilityChain", () => {
  it("includes authorizer, approvers, and executor roles", () => {
    const chain = buildLiabilityChain(BASE_INPUT);
    const roles = chain.map((p) => p.role);
    expect(roles).toContain("authorizer");
    expect(roles).toContain("approver");
    expect(roles).toContain("executor");
  });

  it("weights sum to approximately 1.0 (role_weighted)", () => {
    const chain = buildLiabilityChain(BASE_INPUT);
    const sum = chain.reduce((s, p) => s + p.liability_weight, 0);
    expect(sum).toBeCloseTo(1.0, 4);
  });

  it("weights sum to approximately 1.0 (equal distribution)", () => {
    const chain = buildLiabilityChain(BASE_INPUT, "equal");
    const sum = chain.reduce((s, p) => s + p.liability_weight, 0);
    expect(sum).toBeCloseTo(1.0, 4);
  });

  it("equal distribution gives identical weights to all parties", () => {
    const chain = buildLiabilityChain(BASE_INPUT, "equal");
    const first = chain[0]!.liability_weight;
    expect(chain.every((p) => Math.abs(p.liability_weight - first) < 0.001)).toBe(true);
  });

  it("includes delegator and delegate when delegation is provided", () => {
    const input: LiabilityAttributionInput = {
      ...BASE_INPUT,
      delegations: [{
        delegator_id:    "user-cfo",
        delegate_id:     "user-vp",
        delegator_label: "CFO",
        delegate_label:  "VP Finance",
        delegator_type:  "human",
        delegate_type:   "human",
        permit_id:       "pmt-del-001",
        acted_at:        "2026-01-01T09:00:00Z",
      }],
    };
    const chain = buildLiabilityChain(input);
    const roles = chain.map((p) => p.role);
    expect(roles).toContain("delegator");
    expect(roles).toContain("delegate");
  });

  it("includes override_actor when override is provided", () => {
    const input: LiabilityAttributionInput = {
      ...BASE_INPUT,
      override: {
        actor_id:       "user-ceo",
        actor_label:    "CEO",
        actor_type:     "human",
        justification:  "urgent payment required",
        permit_id:      "pmt-ovr-001",
        acted_at:       "2026-01-01T10:03:00Z",
      },
    };
    const chain = buildLiabilityChain(input);
    expect(chain.map((p) => p.role)).toContain("override_actor");
  });

  it("includes supervisor when supervisors are provided", () => {
    const input: LiabilityAttributionInput = {
      ...BASE_INPUT,
      supervisors: [{
        party_id:    "user-coo",
        party_label: "COO",
        party_type:  "human",
        acted_at:    "2026-01-01T10:00:00Z",
        permit_id:   null,
      }],
    };
    const chain = buildLiabilityChain(input);
    expect(chain.map((p) => p.role)).toContain("supervisor");
  });

  it("override_actor receives the highest per-role weight", () => {
    const input: LiabilityAttributionInput = {
      ...BASE_INPUT,
      override: {
        actor_id:      "user-ceo",
        actor_label:   "CEO",
        actor_type:    "human",
        justification: "urgent",
        permit_id:     null,
        acted_at:      "2026-01-01T10:03:00Z",
      },
    };
    const chain = buildLiabilityChain(input);
    const overrideActor = chain.find((p) => p.role === "override_actor");
    const nonOverride = chain.filter((p) => p.role !== "override_actor");
    if (overrideActor) {
      const maxOther = Math.max(...nonOverride.map((p) => p.liability_weight));
      expect(overrideActor.liability_weight).toBeGreaterThanOrEqual(maxOther);
    }
  });
});

describe("computeLiabilityWeights", () => {
  it("returns empty array for empty parties list", () => {
    expect(computeLiabilityWeights([])).toEqual([]);
  });

  it("sums to 1.0 for role_weighted distribution", () => {
    const parties = [
      { role: "authorizer" as const },
      { role: "executor"   as const },
      { role: "approver"   as const },
    ];
    const weights = computeLiabilityWeights(parties, "role_weighted");
    expect(weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1.0, 4);
  });

  it("sums to 1.0 for equal distribution", () => {
    const parties = Array.from({ length: 5 }, () => ({ role: "approver" as const }));
    const weights = computeLiabilityWeights(parties, "equal");
    expect(weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1.0, 4);
  });
});

describe("findPrimaryLiabilityParties", () => {
  it("returns only parties with weight >= threshold", () => {
    const chain = buildLiabilityChain(BASE_INPUT);
    const primary = findPrimaryLiabilityParties(chain, 0.20);
    expect(primary.every((p) => p.liability_weight >= 0.20)).toBe(true);
  });

  it("returns all parties when threshold is 0", () => {
    const chain = buildLiabilityChain(BASE_INPUT);
    const primary = findPrimaryLiabilityParties(chain, 0);
    expect(primary.length).toBe(chain.length);
  });

  it("returns empty when threshold exceeds all weights", () => {
    const chain = buildLiabilityChain(BASE_INPUT);
    const primary = findPrimaryLiabilityParties(chain, 1.01);
    expect(primary).toHaveLength(0);
  });
});

describe("validateLiabilityChain", () => {
  it("returns valid for a well-formed chain", () => {
    const chain = buildLiabilityChain(BASE_INPUT);
    const result = validateLiabilityChain(chain, false);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("errors on empty chain", () => {
    const result = validateLiabilityChain([], false);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("errors when emergency override is set but no override_actor in chain", () => {
    const chain = buildLiabilityChain(BASE_INPUT);
    const result = validateLiabilityChain(chain, true);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("override_actor"))).toBe(true);
  });

  it("passes when emergency override and override_actor both present", () => {
    const input: LiabilityAttributionInput = {
      ...BASE_INPUT,
      override: {
        actor_id:      "user-ceo",
        actor_label:   "CEO",
        actor_type:    "human",
        justification: "urgent",
        permit_id:     null,
        acted_at:      "2026-01-01T10:03:00Z",
      },
    };
    const chain = buildLiabilityChain(input);
    const result = validateLiabilityChain(chain, true);
    expect(result.valid).toBe(true);
  });
});
