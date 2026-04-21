import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TTLCache } from "../src/cache.js";
import type { EvaluateResponse } from "../src/index.js";

function permitResponse(permitId = "dec_1"): EvaluateResponse {
  return {
    decision: "ALLOW",
    permitId,
    reason: "ok",
    auditHash: "audit",
    timestamp: "2026-04-17T10:00:00Z",
  };
}

describe("TTLCache.get/put", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined for a missing key", () => {
    const cache = new TTLCache();
    expect(cache.get("nope")).toBeUndefined();
  });

  it("returns a stored value within TTL", () => {
    const cache = new TTLCache({ ttlMs: 1_000 });
    const value = permitResponse();
    cache.put("k", value);
    expect(cache.get("k")).toBe(value);
  });

  it("expires a stored value past TTL", () => {
    const cache = new TTLCache({ ttlMs: 1_000 });
    cache.put("k", permitResponse());
    vi.setSystemTime(new Date(Date.now() + 1_500));
    expect(cache.get("k")).toBeUndefined();
    // Expired entry removed on read.
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entry when maxSize is exceeded", () => {
    const cache = new TTLCache({ ttlMs: 60_000, maxSize: 2 });
    cache.put("a", permitResponse("a"));
    cache.put("b", permitResponse("b"));
    cache.put("c", permitResponse("c"));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.permitId).toBe("b");
    expect(cache.get("c")?.permitId).toBe("c");
    expect(cache.size).toBe(2);
  });

  it("clear() removes all entries", () => {
    const cache = new TTLCache();
    cache.put("a", permitResponse("a"));
    cache.put("b", permitResponse("b"));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("prefers evicting expired entries before the oldest when full", () => {
    const cache = new TTLCache({ ttlMs: 1_000, maxSize: 2 });
    cache.put("a", permitResponse("a"));
    vi.setSystemTime(new Date(Date.now() + 1_500));
    // "a" is now expired.
    cache.put("b", permitResponse("b"));
    cache.put("c", permitResponse("c"));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.permitId).toBe("b");
    expect(cache.get("c")?.permitId).toBe("c");
  });
});

describe("TTLCache.makeKey", () => {
  it("produces a 16-char hex key", () => {
    const key = TTLCache.makeKey("modify_patient_record", "agent-1", {
      patientId: "PT-001",
    });
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable regardless of context key order (parity with Python sort_keys=True)", () => {
    const a = TTLCache.makeKey("act", "agent", { a: 1, b: 2, c: 3 });
    const b = TTLCache.makeKey("act", "agent", { c: 3, b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("differentiates distinct action / agent / context", () => {
    const base = TTLCache.makeKey("act", "agent", { x: 1 });
    expect(TTLCache.makeKey("other", "agent", { x: 1 })).not.toBe(base);
    expect(TTLCache.makeKey("act", "other", { x: 1 })).not.toBe(base);
    expect(TTLCache.makeKey("act", "agent", { x: 2 })).not.toBe(base);
  });

  it("matches a hand-computed sha256 prefix of the canonical JSON", () => {
    // Must match Python: json.dumps({"action_type": ..., "actor_id": ...,
    // "context": ...}, sort_keys=True) → sha256 → [:16]
    const canonical = JSON.stringify({
      action_type: "act",
      actor_id: "agent",
      context: { a: 1, b: 2 },
    });
    const expected = createHash("sha256")
      .update(canonical)
      .digest("hex")
      .slice(0, 16);
    expect(TTLCache.makeKey("act", "agent", { a: 1, b: 2 })).toBe(expected);
  });
});
