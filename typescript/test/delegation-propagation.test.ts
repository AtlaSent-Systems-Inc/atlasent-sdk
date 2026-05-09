import { describe, expect, it } from "vitest";
import {
  delegationPropagationHadEffect,
  type DelegationPropagationSummary,
} from "../src/index.js";

describe("delegationPropagationHadEffect", () => {
  const base: DelegationPropagationSummary = {
    delegation_id: "del_1",
    principals: ["user_a", "user_b"],
    delegator_role: null,
    hitl_reassigned: 0,
    financial_invalidated: 0,
    policies_flagged: 0,
  };

  it("is false when nothing was touched", () => {
    expect(delegationPropagationHadEffect(base)).toBe(false);
  });

  it("is true when any cascade fired", () => {
    expect(delegationPropagationHadEffect({ ...base, hitl_reassigned: 1 })).toBe(true);
    expect(
      delegationPropagationHadEffect({ ...base, financial_invalidated: 2 }),
    ).toBe(true);
    expect(
      delegationPropagationHadEffect({ ...base, policies_flagged: 1 }),
    ).toBe(true);
  });
});
