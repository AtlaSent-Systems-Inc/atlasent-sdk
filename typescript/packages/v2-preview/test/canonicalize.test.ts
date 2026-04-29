/**
 * Canonicalization test suite.
 *
 * Covers the deterministic-JSON rules documented in
 * `src/canonicalize.ts` and locked-in by the v2 schemas: sorted keys
 * at every depth, no whitespace, null/undefined/non-finite numbers
 * rendered as `"null"`, strings escaped via `JSON.stringify`.
 *
 * The `v1 parity` block below imports the v1 implementation of
 * `canonicalJSON` and asserts byte-for-byte agreement across a set
 * of tricky vectors. If this ever fails, one of the two has drifted
 * and must be fixed before any further Pillar 9 work lands.
 */

import { describe, expect, it } from "vitest";

import { canonicalizePayload } from "../src/canonicalize.js";
import { canonicalJSON as v1CanonicalJSON } from "../../../src/auditBundle.js";

describe("canonicalizePayload — rules", () => {
  it("renders primitives explicitly", () => {
    expect(canonicalizePayload(null)).toBe("null");
    expect(canonicalizePayload(undefined)).toBe("null");
    expect(canonicalizePayload(true)).toBe("true");
    expect(canonicalizePayload(false)).toBe("false");
    expect(canonicalizePayload("hi")).toBe('"hi"');
    expect(canonicalizePayload(42)).toBe("42");
    expect(canonicalizePayload(0)).toBe("0");
    expect(canonicalizePayload(-1.5)).toBe("-1.5");
  });

  it("collapses non-finite numbers to null", () => {
    expect(canonicalizePayload(Number.NaN)).toBe("null");
    expect(canonicalizePayload(Number.POSITIVE_INFINITY)).toBe("null");
    expect(canonicalizePayload(Number.NEGATIVE_INFINITY)).toBe("null");
  });

  it("sorts object keys lexicographically at every depth", () => {
    const obj = {
      b: 1,
      a: 2,
      nested: {
        zebra: true,
        alpha: { delta: 4, beta: 3 },
      },
    };
    expect(canonicalizePayload(obj)).toBe(
      '{"a":2,"b":1,"nested":{"alpha":{"beta":3,"delta":4},"zebra":true}}',
    );
  });

  it("preserves array order but canonicalizes elements", () => {
    const arr = [{ b: 1, a: 2 }, null, [3, 2, 1]];
    expect(canonicalizePayload(arr)).toBe('[{"a":2,"b":1},null,[3,2,1]]');
  });

  it("emits no whitespace", () => {
    const out = canonicalizePayload({ a: 1, b: [2, 3], c: { d: 4 } });
    expect(out).not.toMatch(/\s/);
  });

  it("escapes strings using JSON.stringify rules", () => {
    expect(canonicalizePayload('he said "hi"')).toBe('"he said \\"hi\\""');
    expect(canonicalizePayload("tab\there")).toBe('"tab\\there"');
    expect(canonicalizePayload("line\nbreak")).toBe('"line\\nbreak"');
  });

  it("handles an empty object and empty array", () => {
    expect(canonicalizePayload({})).toBe("{}");
    expect(canonicalizePayload([])).toBe("[]");
  });

  it("renders arbitrary objects with unicode content", () => {
    // Unicode strings round-trip through JSON.stringify.
    const out = canonicalizePayload({ "é": "π", "漢": ["字", null] });
    expect(out).toBe('{"é":"π","漢":["字",null]}');
  });

  it("treats functions and symbols as null (unreachable via proper JSON)", () => {
    // Neither function nor symbol round-trips through JSON; the SDK
    // canonicalizer normalizes them to "null" so the hash doesn't
    // silently blow up on bad input.
    expect(canonicalizePayload(() => 1)).toBe("null");
    expect(canonicalizePayload(Symbol("x"))).toBe("null");
  });
});

describe("canonicalizePayload — v1 parity", () => {
  // If any of these break, v2-preview and v1 have drifted on the
  // canonicalization algorithm — a silent proof-signature failure in
  // the making. Fix before shipping.
  const vectors: unknown[] = [
    null,
    undefined,
    true,
    42,
    -0.001,
    "hello",
    "with \"quote\" and \n newline",
    [],
    {},
    { z: 1, a: 2 },
    { a: { c: 3, b: 2 }, nested: [true, false, null] },
    { mixed: [1, "two", { three: 3 }, [4, 5]] },
    { empty_arr: [], empty_obj: {} },
    Number.NaN,
    Number.POSITIVE_INFINITY,
    { unicode: "漢字 é π" },
  ];

  it.each(vectors.map((v, i) => [i, v]))(
    "matches v1 canonicalJSON on vector %d",
    (_, vector) => {
      expect(canonicalizePayload(vector)).toBe(v1CanonicalJSON(vector));
    },
  );
});
