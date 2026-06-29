import { describe, expect, it } from "vitest";

import {
  RESOURCE_ASSERTION_TRUST_LEVELS,
  isResourceClassificationAssertion,
  validateResourceClassificationAssertion,
  type ResourceClassificationAssertion,
} from "../src/index.js";

describe("ResourceClassificationAssertion (ADR-041 SDK convenience type)", () => {
  it("accepts a well-formed assertion (full + minimal)", () => {
    const full: ResourceClassificationAssertion = {
      classification: "pci",
      source: "partner:inspect-data",
      trust: "verified",
      confidence: 1,
      asserted_at: "2026-06-29T12:00:00Z",
      valid_until: "2026-07-29T12:00:00Z",
      assertion_id: "insp_xyz",
      content_hash: "sha256:" + "f".repeat(64),
    };
    expect(validateResourceClassificationAssertion(full)).toEqual([]);
    expect(isResourceClassificationAssertion(full)).toBe(true);

    const minimal = { classification: "internal", source: "caller" };
    expect(validateResourceClassificationAssertion(minimal)).toEqual([]);
    expect(isResourceClassificationAssertion(minimal)).toBe(true);

    // Offset and fractional-second timestamp forms are accepted.
    expect(
      isResourceClassificationAssertion({
        classification: "phi",
        source: "s",
        asserted_at: "2026-06-29T12:00:00+00:00",
        valid_until: "2026-06-29T12:00:00.500Z",
      }),
    ).toBe(true);
  });

  it("accepts every declared trust tier and both confidence bounds", () => {
    for (const trust of RESOURCE_ASSERTION_TRUST_LEVELS) {
      expect(isResourceClassificationAssertion({ classification: "x", source: "s", trust })).toBe(true);
    }
    expect(isResourceClassificationAssertion({ classification: "x", source: "s", confidence: 0 })).toBe(true);
    expect(isResourceClassificationAssertion({ classification: "x", source: "s", confidence: 1 })).toBe(true);
  });

  it("rejects malformed provenance", () => {
    const bad: unknown[] = [
      "nope",
      null,
      [],
      { source: "s" }, // missing classification
      { classification: "", source: "s" },
      { classification: "phi" }, // missing source
      { classification: "phi", source: "" },
      { classification: "phi", source: "s", trust: "totally_trusted" },
      { classification: "phi", source: "s", confidence: 1.5 },
      { classification: "phi", source: "s", confidence: -0.1 },
      { classification: "phi", source: "s", confidence: Number.NaN },
      { classification: "phi", source: "s", asserted_at: "last tuesday" },
      { classification: "phi", source: "s", valid_until: 12345 },
      { classification: "phi", source: "s", assertion_id: "" },
      { classification: "phi", source: "s", content_hash: "md5:abc" },
      { classification: "phi", source: "s", content_hash: "sha256:abc" },
      // Explicit null is rejected for optional fields (matches the Python validator).
      { classification: "phi", source: "s", trust: null },
      { classification: "phi", source: "s", confidence: null },
      { classification: "phi", source: "s", valid_until: null },
      { classification: "phi", source: "s", assertion_id: null },
      { classification: "phi", source: "s", content_hash: null },
      // Impossible calendar date (Feb 30) is rejected, not normalized to March.
      { classification: "phi", source: "s", asserted_at: "2026-02-30T00:00:00Z" },
      // Date-only / seconds-less strings are not accepted (full timestamp only).
      { classification: "phi", source: "s", asserted_at: "2026-06-29" },
    ];
    for (const value of bad) {
      expect(validateResourceClassificationAssertion(value).length).toBeGreaterThan(0);
      expect(isResourceClassificationAssertion(value)).toBe(false);
    }
  });

  it("composes into the open `resource` namespace with no envelope-shape change", () => {
    // The SDK envelope's resource namespace is an open record — attaching a
    // provenance-bearing assertion needs no envelope-shape change (the SDK-side
    // guarantee of the additive contract change).
    const assertion: ResourceClassificationAssertion = {
      classification: "phi",
      source: "partner:inspect-data",
      trust: "partner_attested",
      confidence: 0.98,
    };
    const resource = {
      kind: "customer_record",
      ref: "crm:account:A_1",
      classification: ["confidential", "pii"],
      assertions: [assertion],
    };
    const [first] = resource.assertions;
    expect(first?.classification).toBe("phi");
    expect(validateResourceClassificationAssertion(first)).toEqual([]);
  });
});
