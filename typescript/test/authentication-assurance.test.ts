import { describe, expect, it } from "vitest";

import {
  isAuthenticationAssuranceOutcomeCode,
  isAuthenticationAssuranceRequirement,
  matchesResourceContextCondition,
  validateAuthenticationAssuranceEvidence,
  validateAuthenticationAssuranceRequirement,
  type AuthenticationAssuranceEvidence,
  type AuthenticationAssuranceRequirement,
} from "../src/index.js";

describe("AuthenticationAssuranceEvidence (CROSS-016 / proposal 0003)", () => {
  it("accepts a well-formed evidence record", () => {
    const evidence: AuthenticationAssuranceEvidence = {
      methods: [{ method: "webauthn", issuer: "https://idp.example.com", verified: true }],
      factor_count: 2,
      phishing_resistant: true,
      auth_time: "2026-08-20T00:00:00Z",
      issuer: "https://idp.example.com",
      verification_status: "verified",
      capability_summary: ["mfa"],
    };
    expect(validateAuthenticationAssuranceEvidence(evidence)).toEqual([]);
  });

  it("rejects malformed evidence", () => {
    expect(validateAuthenticationAssuranceEvidence("nope").length).toBeGreaterThan(0);
    expect(validateAuthenticationAssuranceEvidence(null).length).toBeGreaterThan(0);
    expect(
      validateAuthenticationAssuranceEvidence({
        methods: [],
        factor_count: -1,
        phishing_resistant: "yes",
        auth_time: "not-a-time",
        issuer: "",
        verification_status: "maybe",
        capability_summary: {},
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe("AuthenticationAssuranceRequirement (CROSS-016 / proposal 0003)", () => {
  it("accepts one well-formed requirement per layer", () => {
    const externalObligation: AuthenticationAssuranceRequirement = {
      layer: "external_obligation",
      source_type: "regime_profile",
      source_id: "regime_1",
      predicates: [{ predicate_id: "mfa_required", value: true }],
      effective_from: "2026-01-01T00:00:00Z",
    };
    const organization: AuthenticationAssuranceRequirement = {
      layer: "organization",
      source_id: "org_1",
      predicates: [],
      effective_from: "2026-01-01T00:00:00Z",
      effective_until: null,
    };
    const actionClass: AuthenticationAssuranceRequirement = {
      layer: "action_class",
      source_id: "ac_1",
      predicates: [{ predicate_id: "phishing_resistant", value: true }],
      when: [{ field: "environment", operator: "eq", value: "production" }],
      effective_from: "2026-01-01T00:00:00Z",
    };
    const resourceContext: AuthenticationAssuranceRequirement = {
      layer: "resource_context",
      source_id: "rc_1",
      predicates: [],
      when: [{ field: "target.tier", operator: "in", value: ["gold", "platinum"] }],
      effective_from: "2026-01-01T00:00:00Z",
    };
    for (const req of [externalObligation, organization, actionClass, resourceContext]) {
      expect(validateAuthenticationAssuranceRequirement(req)).toEqual([]);
      expect(isAuthenticationAssuranceRequirement(req)).toBe(true);
    }
  });

  it("rejects source_type on a non-external_obligation layer", () => {
    const bad = {
      layer: "organization",
      source_type: "regime_profile",
      source_id: "org_1",
      predicates: [],
      effective_from: "2026-01-01T00:00:00Z",
    };
    expect(validateAuthenticationAssuranceRequirement(bad)).toContain(
      "source_type must be absent when layer is organization",
    );
    expect(isAuthenticationAssuranceRequirement(bad)).toBe(false);
  });

  it("rejects a missing source_type on external_obligation", () => {
    const bad = {
      layer: "external_obligation",
      source_id: "regime_1",
      predicates: [],
      effective_from: "2026-01-01T00:00:00Z",
    };
    expect(isAuthenticationAssuranceRequirement(bad)).toBe(false);
  });

  it("rejects an empty or missing when on resource_context", () => {
    const missing = {
      layer: "resource_context",
      source_id: "rc_1",
      predicates: [],
      effective_from: "2026-01-01T00:00:00Z",
    };
    const empty = { ...missing, when: [] };
    expect(isAuthenticationAssuranceRequirement(missing)).toBe(false);
    expect(isAuthenticationAssuranceRequirement(empty)).toBe(false);
  });

  it("rejects an invalid effective_from / effective_until", () => {
    const badFrom = {
      layer: "organization",
      source_id: "org_1",
      predicates: [],
      effective_from: "not-a-date",
    };
    const badUntil = {
      layer: "organization",
      source_id: "org_1",
      predicates: [],
      effective_from: "2026-01-01T00:00:00Z",
      effective_until: "not-a-date",
    };
    expect(isAuthenticationAssuranceRequirement(badFrom)).toBe(false);
    expect(isAuthenticationAssuranceRequirement(badUntil)).toBe(false);
  });

  it("rejects a non-object input and a non-array 'when' on action_class", () => {
    expect(validateAuthenticationAssuranceRequirement("nope")).toEqual(["input must be an object"]);
    expect(validateAuthenticationAssuranceRequirement(null)).toEqual(["input must be an object"]);
    const badWhen = {
      layer: "action_class",
      source_id: "ac_1",
      predicates: [],
      when: "not-an-array",
      effective_from: "2026-01-01T00:00:00Z",
    };
    expect(validateAuthenticationAssuranceRequirement(badWhen)).toContain(
      "when, when present, must be an array",
    );
  });

  it("rejects an unrecognized layer", () => {
    expect(
      isAuthenticationAssuranceRequirement({
        layer: "planet",
        source_id: "x",
        predicates: [],
        effective_from: "2026-01-01T00:00:00Z",
      }),
    ).toBe(false);
  });
});

describe("isAuthenticationAssuranceOutcomeCode", () => {
  it("accepts every registered ASSURANCE_* code and rejects anything else", () => {
    const codes = [
      "ASSURANCE_APPLICABILITY_UNDETERMINED",
      "ASSURANCE_EVIDENCE_MISSING",
      "ASSURANCE_ISSUER_UNTRUSTED",
      "ASSURANCE_EVIDENCE_UNVERIFIED",
      "ASSURANCE_EVIDENCE_SOURCE_CONFLICT",
      "ASSURANCE_EVIDENCE_STALE",
      "ASSURANCE_POLICY_CONFLICT",
      "ASSURANCE_RESOLUTION_INDETERMINATE",
      "ASSURANCE_REQUIREMENT_UNMET",
    ];
    for (const code of codes) {
      expect(isAuthenticationAssuranceOutcomeCode(code)).toBe(true);
    }
    expect(isAuthenticationAssuranceOutcomeCode("ASSURANCE_MADE_UP")).toBe(false);
    expect(isAuthenticationAssuranceOutcomeCode(123)).toBe(false);
  });
});

describe("matchesResourceContextCondition (tri-state)", () => {
  it("matches / no-matches eq and in conditions", () => {
    const context = { environment: "production", tier: "gold" };
    expect(
      matchesResourceContextCondition({ field: "environment", operator: "eq", value: "production" }, context),
    ).toBe("match");
    expect(
      matchesResourceContextCondition({ field: "environment", operator: "eq", value: "staging" }, context),
    ).toBe("no_match");
    expect(
      matchesResourceContextCondition({ field: "tier", operator: "in", value: ["gold", "platinum"] }, context),
    ).toBe("match");
    expect(
      matchesResourceContextCondition({ field: "tier", operator: "in", value: ["bronze"] }, context),
    ).toBe("no_match");
  });

  it("is undetermined — never a silent no_match — on a missing field or a malformed 'in' value", () => {
    const context = { environment: "production" };
    expect(
      matchesResourceContextCondition({ field: "missing_field", operator: "eq", value: "x" }, context),
    ).toBe("undetermined");
    expect(
      // `in` operator but a scalar `value` (should be an array) — can't be evaluated.
      matchesResourceContextCondition(
        { field: "environment", operator: "in", value: "production" as unknown as string[] },
        context,
      ),
    ).toBe("undetermined");
  });
});
