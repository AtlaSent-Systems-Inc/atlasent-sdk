/**
 * Public-export smoke test. Guards against an `index.ts` typo or a
 * missing re-export; runtime behaviour is covered by the per-module
 * test files.
 */

import { describe, expect, it } from "vitest";

import * as pkg from "../src/index.js";

describe("@atlasent/sdk-v2-alpha public exports", () => {
  it("re-exports canonicalizePayload and hashPayload", () => {
    expect(typeof pkg.canonicalizePayload).toBe("function");
    expect(typeof pkg.hashPayload).toBe("function");
    // Functional sanity — confirms the barrel points at the real modules.
    expect(pkg.canonicalizePayload({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(pkg.hashPayload({})).toMatch(/^[0-9a-f]{64}$/);
  });
});
