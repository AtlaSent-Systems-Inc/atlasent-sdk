/**
 * Retry-policy helpers for the AtlaSent TypeScript SDK.
 *
 * This module is **pure**: no I/O, no network, no globals beyond
 * `Math.random`. The intent is that {@link AtlaSentClient} (and any
 * caller wrapping `protect()` / `evaluate()`) can ask
 * {@link isRetryable} whether to retry a given {@link AtlaSentError},
 * then ask {@link computeBackoffMs} how long to sleep before the next
 * attempt.
 *
 * Wire-up into the client itself is intentionally deferred — see
 * ROADMAP item #7 (Post-GA). Sentry breadcrumb emission is also
 * deferred; both will land together once a transport-level retry
 * loop is wired into `client.ts`.
 *
 * Retry classification (matches the server's documented contract):
 *   - `network` / `timeout`        → retry (transient transport)
 *   - `server_error` (HTTP 5xx)    → retry
 *   - `rate_limited` (HTTP 429)    → retry, honour `retryAfterMs`
 *   - `bad_response`               → retry (likely truncated body)
 *   - `invalid_api_key`/`forbidden`/`bad_request` → never retry
 *
 * Backoff: capped exponential with full jitter.
 *   delay = min(maxDelayMs, baseDelayMs * 2^attempt) * random[0, 1)
 *
 * "Full jitter" is the AWS-recommended scheme — see
 * https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/.
 * It avoids thundering-herd retries from many SDK instances that hit
 * a 429 in the same window.
 */

import { AtlaSentError, type AtlaSentErrorCode } from "./errors.js";

/** Defaults for {@link RetryPolicy}. Conservative — three retries, ~7s ceiling. */
export const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 7_000,
};

/**
 * Caller-tunable retry policy. All fields optional; missing fields
 * fall back to {@link DEFAULT_RETRY_POLICY}.
 */
export interface RetryPolicy {
  /**
   * Total attempts including the first try. `1` disables retries
   * entirely. Must be `>= 1`; values below are clamped to `1`.
   */
  maxAttempts?: number;
  /**
   * Initial backoff for `attempt = 0`. Doubles per attempt up to
   * `maxDelayMs`. Must be `>= 0`.
   */
  baseDelayMs?: number;
  /**
   * Hard ceiling on the per-attempt sleep, applied **before** jitter.
   * The actual sleep is uniformly distributed in `[0, ceiling]`.
   */
  maxDelayMs?: number;
}

/**
 * Error codes the SDK considers transient. A `Set` (rather than a
 * `switch`) keeps callers free to extend the policy in the future
 * without forking this module.
 */
const RETRYABLE_CODES: ReadonlySet<AtlaSentErrorCode> = new Set([
  "network",
  "timeout",
  "rate_limited",
  "server_error",
  "bad_response",
]);

/**
 * Decide whether `err` is worth a retry. Anything that isn't an
 * {@link AtlaSentError} is treated as non-retryable — the SDK's
 * transport layer always wraps fetch failures in `AtlaSentError`,
 * so a non-AtlaSent throwable is by definition a programmer bug
 * (a bad input, an assertion in user code) and should propagate.
 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof AtlaSentError)) return false;
  if (err.code === undefined) return false;
  return RETRYABLE_CODES.has(err.code);
}

/**
 * Compute how long to sleep before retry attempt `attempt`
 * (zero-indexed: `attempt = 0` is the first retry, i.e. the second
 * total request). Uses capped exponential backoff with full jitter.
 *
 * When `err` carries a `retryAfterMs` (server-provided `Retry-After`
 * header), the result is `max(retryAfterMs, jitteredDelay)` — the
 * server's hint is treated as a floor so we never retry sooner than
 * the server asked.
 *
 * @param attempt    Zero-indexed retry attempt (0, 1, 2, ...).
 * @param policy     Optional override of {@link DEFAULT_RETRY_POLICY}.
 * @param err        Optional error whose `retryAfterMs` is honoured.
 * @param random     Injectable RNG, defaults to `Math.random`. Must
 *                   return values in `[0, 1)` to preserve the
 *                   distribution.
 */
export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy = {},
  err?: unknown,
  random: () => number = Math.random,
): number {
  const merged = mergePolicy(policy);
  const safeAttempt = Math.max(0, Math.floor(attempt));
  // 2^attempt grows exponentially; cap before multiplying to keep the
  // intermediate value bounded for very large `attempt`.
  const exp = Math.min(safeAttempt, 30);
  const ceiling = Math.min(merged.maxDelayMs, merged.baseDelayMs * 2 ** exp);
  const jittered = Math.floor(ceiling * clampUnit(random()));

  const retryAfterMs =
    err instanceof AtlaSentError && typeof err.retryAfterMs === "number"
      ? Math.max(0, err.retryAfterMs)
      : 0;

  return Math.max(retryAfterMs, jittered);
}

/**
 * Returns `true` when `attempt` (zero-indexed) is below the policy's
 * `maxAttempts - 1` ceiling — i.e. when there is still budget for at
 * least one more try after this one. Convenience wrapper so retry
 * loops read top-to-bottom:
 *
 * ```ts
 * for (let attempt = 0; ; attempt++) {
 *   try { return await op(); }
 *   catch (err) {
 *     if (!isRetryable(err) || !hasAttemptsLeft(attempt, policy)) throw err;
 *     await sleep(computeBackoffMs(attempt, policy, err));
 *   }
 * }
 * ```
 */
export function hasAttemptsLeft(
  attempt: number,
  policy: RetryPolicy = {},
): boolean {
  const merged = mergePolicy(policy);
  return attempt + 1 < merged.maxAttempts;
}

/**
 * Merge a partial policy with {@link DEFAULT_RETRY_POLICY} and clamp
 * each field into a sensible range. Exported for tests and for
 * callers that want to log the resolved policy.
 */
export function mergePolicy(policy: RetryPolicy): Required<RetryPolicy> {
  const maxAttempts = Math.max(
    1,
    Math.floor(policy.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts),
  );
  const baseDelayMs = Math.max(
    0,
    policy.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    policy.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
  );
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

/**
 * Clamp `n` into `[0, 1)`. Defends against a misbehaving injected
 * RNG returning `NaN`, `Infinity`, or a negative number.
 */
function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n >= 1) return 0.999_999_999;
  return n;
}
