/**
 * Hash test suite.
 *
 * Assertions: `hashPayload` returns 64-char lowercase hex, is
 * deterministic, and — critically — hashes the same bytes that
 * `canonicalizePayload` emits so the client- and server-side proof
 * hashes agree.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalizePayload } from "../src/canonicalize.js";
import { hashPayload } from "../src/hash.js";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

describe("hashPayload", () => {
  it("returns 64-char lowercase hex", () => {
    const hex = hashPayload({ a: 1 });
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic on object key order", () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });

  it("differs when a nested value changes", () => {
    const h1 = hashPayload({ a: { b: 1 } });
    const h2 = hashPayload({ a: { b: 2 } });
    expect(h1).not.toBe(h2);
  });

  it("equals sha256 of canonicalizePayload output", () => {
    const payload = {
      commit: "abc123",
      approver: "dr_smith",
      env: "production",
      meta: { ts: "2026-04-24T00:00:00Z" },
    };
    const direct = sha256Hex(canonicalizePayload(payload));
    expect(hashPayload(payload)).toBe(direct);
  });

  it("matches a known fixture for the empty object", () => {
    // sha256("{}") — locked-in so changes to the primitive produce
    // a visible failure rather than silently re-hashing.
    expect(hashPayload({})).toBe(sha256Hex("{}"));
  });

  it("matches a known fixture for null", () => {
    expect(hashPayload(null)).toBe(sha256Hex("null"));
  });

  it("treats NaN / Infinity identically to null (matches canonicalizer)", () => {
    expect(hashPayload(Number.NaN)).toBe(hashPayload(null));
    expect(hashPayload(Number.POSITIVE_INFINITY)).toBe(hashPayload(null));
  });
});
