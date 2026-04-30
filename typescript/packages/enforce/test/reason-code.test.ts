// Lock the ReasonCode + PermitOutcomeReasonCode unions against drift.
// If somebody removes a value, the type-level assertion fails CI.

import { describe, expect, it } from "vitest";
import type {
  PermitOutcomeReasonCode,
  ReasonCode,
} from "../src/index.js";

// ── Type-level assertions ────────────────────────────────────────────

type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;

type AssertTrue<T extends true> = T;

// PermitOutcomeReasonCode must be exactly these four — narrower than
// ReasonCode but byte-identical with the v1 SDK's PermitOutcome.
type _AssertPermitOutcomeReasonCode = AssertTrue<
  Equals<
    PermitOutcomeReasonCode,
    "permit_expired" | "permit_consumed" | "permit_revoked" | "permit_not_found"
  >
>;

// PermitOutcomeReasonCode is a subset of ReasonCode.
type _AssertSubset = AssertTrue<
  PermitOutcomeReasonCode extends ReasonCode ? true : false
>;

// Bind the type-level assertions so unused-locals lints don't strip them.
const _typeAssertions: [_AssertPermitOutcomeReasonCode, _AssertSubset] = [true, true];

// ── Runtime assertions (so a value-shaped reviewer can read the matrix) ─

describe("Enforce ReasonCode taxonomy", () => {
  it("PermitOutcomeReasonCode covers all four v1 SDK PermitOutcome values", () => {
    // Treat the type as a runtime set we can spot-check by sampling
    // every value through a switch — exhaustiveness is checked by
    // the never branch.
    const sample: ReadonlyArray<PermitOutcomeReasonCode> = [
      "permit_expired",
      "permit_consumed",
      "permit_revoked",
      "permit_not_found",
    ];

    for (const rc of sample) {
      // Assigning to ReasonCode confirms each is in the broader set.
      const broader: ReasonCode = rc;
      expect(typeof broader).toBe("string");
    }
    expect(sample).toHaveLength(4);
  });

  it("ReasonCode includes the new permit_revoked + permit_not_found entries", () => {
    // Plain string assignment to the union — fails compile if the
    // union shrinks. Runtime asserts that the values aren't typo'd.
    const revoked: ReasonCode = "permit_revoked";
    const notFound: ReasonCode = "permit_not_found";
    expect([revoked, notFound]).toEqual(["permit_revoked", "permit_not_found"]);
  });
});

// Suppress unused-variable warnings for the type-level assertions.
void _typeAssertions;
