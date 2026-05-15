/**
 * ADR-0002 invariant I-6 (atlasent-internal): the SDK has no write methods for
 * governance-policy mutation.
 *
 * The artifact this guards is the policy in the `policies` / `policy_versions`
 * tables, governed by the `v1-policy-lifecycle` edge function and addressable
 * under `/v1/policies/*`. V3 governance lifecycle deliberately keeps the
 * write path Console-only and control-plane-only — the friction is the point.
 *
 * SCOPING NOTE: `connector_enforcement_policies` (per-connector rate limits
 * and IP allow-lists, accessed via `upsertEnforcementPolicy()` and the
 * `/v1/governance/enforcement-policies` endpoint) is a DIFFERENT artifact
 * and is OUT OF SCOPE for I-6. The denylist below is written to exclude it
 * by requiring a bare `Polic(y|ies)` token rather than `EnforcementPolicy`.
 *
 * Linked: atlasent-internal/architecture/ADR-0002, atlasent-sdk#230.
 */

import { describe, expect, it } from "vitest";

import { AtlaSentClient } from "../src/index.js";

const POLICY_MUTATION_PATTERNS: RegExp[] = [
  // Bare mutation verbs immediately followed by Polic(y|ies), optionally with
  // a Version(s) suffix. Catches createPolicy, updatePolicy, publishPolicy,
  // upsertPolicy, createPolicyVersion. Misses (correctly):
  // upsertEnforcementPolicy, listEnforcementPolicies — different artifact.
  /^(create|update|delete|publish|approve|vote|submit|upsert)Polic(y|ies)(Version|Versions)?$/,
  // Anything namespaced under policy lifecycle.
  /^policy[Ll]ifecycle/,
  // Explicit governance-policy qualifier (future namespace).
  /^(create|update|delete|publish|approve|vote|submit|upsert).*GovernancePolic(y|ies)/,
];

function methodsOf(cls: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(cls.prototype)
    .filter((name) => name !== "constructor")
    .filter(
      (name) =>
        typeof (cls.prototype as Record<string, unknown>)[name] === "function",
    );
}

function isPolicyMutation(name: string): boolean {
  return POLICY_MUTATION_PATTERNS.some((re) => re.test(name));
}

describe("ADR-0002 I-6: SDK has no governance-policy mutation methods", () => {
  it("AtlaSentClient does not expose any policy-mutation method", () => {
    const violations = methodsOf(AtlaSentClient).filter(isPolicyMutation);
    expect(
      violations,
      "Adding a policy-mutation method to the SDK violates ADR-0002 I-6. " +
        "Policy lifecycle changes must go through Console + control-plane " +
        "only. If this is a connector-enforcement-policy method (different " +
        "artifact), see the SCOPING NOTE in this test file.",
    ).toEqual([]);
  });

  describe("regex sanity — denylist", () => {
    it.each([
      "createPolicy",
      "updatePolicy",
      "deletePolicy",
      "publishPolicy",
      "submitPolicy",
      "votePolicy",
      "approvePolicy",
      "upsertPolicy",
      "createPolicyVersion",
      "updatePolicyVersions",
      "policyLifecycleSubmit",
      "policyLifecycleVote",
      "createGovernancePolicy",
      "publishGovernancePolicies",
    ])("blocks %s", (name) => {
      expect(isPolicyMutation(name)).toBe(true);
    });
  });

  describe("regex sanity — allowlist", () => {
    it.each([
      "getPolicy",
      "listPolicies",
      "getPolicyVersion",
      "listPolicyVersions",
      "evaluate",
      "verifyPermit",
      // Out of scope (different artifact: per-connector enforcement settings)
      "upsertEnforcementPolicy",
      "listEnforcementPolicies",
    ])("permits %s", (name) => {
      expect(isPolicyMutation(name)).toBe(false);
    });
  });
});
