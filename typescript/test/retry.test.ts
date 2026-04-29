import { describe, expect, it } from "vitest";

import { AtlaSentError } from "../src/errors.js";
import {
  DEFAULT_RETRY_POLICY,
  computeBackoffMs,
  hasAttemptsLeft,
  isRetryable,
  mergePolicy,
} from "../src/retry.js";

describe("isRetryable", () => {
  it.each([
    "network",
    "timeout",
    "rate_limited",
    "server_error",
    "bad_response",
  ] as const)("retries %s", (code) => {
    expect(isRetryable(new AtlaSentError("x", { code }))).toBe(true);
  });

  it.each(["invalid_api_key", "forbidden", "bad_request"] as const)(
    "does not retry %s",
    (code) => {
      expect(isRetryable(new AtlaSentError("x", { code }))).toBe(false);
    },
  );

  it("does not retry an AtlaSentError without a code", () => {
    expect(isRetryable(new AtlaSentError("no code"))).toBe(false);
  });

  it("does not retry generic Errors", () => {
    expect(isRetryable(new Error("boom"))).toBe(false);
  });

  it("does not retry non-Error values", () => {
    expect(isRetryable("string error")).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable(42)).toBe(false);
  });
});

describe("computeBackoffMs", () => {
  const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 5_000 };

  it("scales the ceiling exponentially with attempt", () => {
    // random() = 1 (clamped to ~0.999...) ⇒ jittered ≈ ceiling.
    const a0 = computeBackoffMs(0, policy, undefined, () => 0.9999);
    const a1 = computeBackoffMs(1, policy, undefined, () => 0.9999);
    const a2 = computeBackoffMs(2, policy, undefined, () => 0.9999);
    expect(a0).toBeGreaterThanOrEqual(99);
    expect(a0).toBeLessThanOrEqual(100);
    expect(a1).toBeGreaterThanOrEqual(199);
    expect(a1).toBeLessThanOrEqual(200);
    expect(a2).toBeGreaterThanOrEqual(399);
    expect(a2).toBeLessThanOrEqual(400);
  });

  it("caps the ceiling at maxDelayMs", () => {
    const huge = computeBackoffMs(20, policy, undefined, () => 0.9999);
    expect(huge).toBeLessThanOrEqual(5_000);
    expect(huge).toBeGreaterThan(4_000);
  });

  it("returns 0 when random() returns 0 and no retryAfter is set", () => {
    expect(computeBackoffMs(3, policy, undefined, () => 0)).toBe(0);
  });

  it("honours retryAfterMs as a floor", () => {
    const err = new AtlaSentError("rate", {
      code: "rate_limited",
      retryAfterMs: 2_500,
    });
    // random() = 0 ⇒ jittered = 0; floor wins.
    expect(computeBackoffMs(0, policy, err, () => 0)).toBe(2_500);
  });

  it("uses jittered delay when it exceeds retryAfterMs", () => {
    const err = new AtlaSentError("rate", {
      code: "rate_limited",
      retryAfterMs: 50,
    });
    // attempt 2, random() = 0.9999 ⇒ ~400ms > 50ms.
    const got = computeBackoffMs(2, policy, err, () => 0.9999);
    expect(got).toBeGreaterThanOrEqual(399);
  });

  it("ignores retryAfterMs from non-AtlaSent errors", () => {
    const fake = new Error("not ours") as Error & { retryAfterMs: number };
    fake.retryAfterMs = 9_999;
    expect(computeBackoffMs(0, policy, fake, () => 0)).toBe(0);
  });

  it("clamps negative retryAfterMs to zero", () => {
    const err = new AtlaSentError("x", {
      code: "rate_limited",
      retryAfterMs: -100,
    });
    expect(computeBackoffMs(0, policy, err, () => 0)).toBe(0);
  });

  it("treats a NaN RNG output as 0", () => {
    expect(computeBackoffMs(0, policy, undefined, () => Number.NaN)).toBe(0);
  });

  it("treats a >=1 RNG output as ~ceiling, not above", () => {
    const got = computeBackoffMs(0, policy, undefined, () => 1.5);
    expect(got).toBeLessThanOrEqual(100);
  });

  it("clamps negative attempt to 0", () => {
    const got = computeBackoffMs(-3, policy, undefined, () => 0.9999);
    // attempt=0 ⇒ ceiling = baseDelayMs.
    expect(got).toBeGreaterThanOrEqual(99);
    expect(got).toBeLessThanOrEqual(100);
  });
});

describe("hasAttemptsLeft", () => {
  it("returns true while below maxAttempts - 1", () => {
    const policy = { maxAttempts: 3 };
    expect(hasAttemptsLeft(0, policy)).toBe(true);
    expect(hasAttemptsLeft(1, policy)).toBe(true);
    expect(hasAttemptsLeft(2, policy)).toBe(false);
  });

  it("returns false when maxAttempts is 1 (retries disabled)", () => {
    expect(hasAttemptsLeft(0, { maxAttempts: 1 })).toBe(false);
  });

  it("uses the default policy when none is supplied", () => {
    // DEFAULT_RETRY_POLICY.maxAttempts === 3.
    expect(hasAttemptsLeft(1)).toBe(true);
    expect(hasAttemptsLeft(2)).toBe(false);
  });
});

describe("mergePolicy", () => {
  it("falls back to defaults for missing fields", () => {
    expect(mergePolicy({})).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("clamps maxAttempts to >= 1", () => {
    expect(mergePolicy({ maxAttempts: 0 }).maxAttempts).toBe(1);
    expect(mergePolicy({ maxAttempts: -5 }).maxAttempts).toBe(1);
  });

  it("clamps baseDelayMs to >= 0", () => {
    expect(mergePolicy({ baseDelayMs: -10 }).baseDelayMs).toBe(0);
  });

  it("raises maxDelayMs to baseDelayMs when caller inverts them", () => {
    const merged = mergePolicy({ baseDelayMs: 1_000, maxDelayMs: 100 });
    expect(merged.maxDelayMs).toBe(1_000);
  });

  it("preserves explicit values", () => {
    expect(
      mergePolicy({ maxAttempts: 7, baseDelayMs: 50, maxDelayMs: 1_234 }),
    ).toEqual({ maxAttempts: 7, baseDelayMs: 50, maxDelayMs: 1_234 });
  });
});
