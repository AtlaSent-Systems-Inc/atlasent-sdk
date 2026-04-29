/**
 * `atlasent.withPermit(req, fn)` — verify-before-run wrapper.
 *
 * The single-call execution-time authorization boundary, lifted one
 * level higher than {@link protect}. Where `protect()` returns a
 * verified {@link Permit} and leaves the caller to run their own
 * action, `withPermit()` orchestrates the entire lifecycle:
 *
 *   1. evaluate the request → throw {@link AtlaSentDeniedError} on
 *      anything other than ALLOW.
 *   2. verify the resulting permit → throw on `verified: false`
 *      (covers the v1 single-use semantics: a permit consumed by an
 *      earlier verify reports `verified: false` on a replay).
 *   3. invoke the wrapped function with the verified permit.
 *   4. return the function's result.
 *
 * The action cannot run unless steps 1 and 2 succeed. If the wrapped
 * function throws, the error propagates — the permit is already
 * consumed by step 2 in v1, so there is no compensating revoke.
 *
 * ```ts
 * import atlasent from "@atlasent/sdk";
 *
 * const result = await atlasent.withPermit(
 *   { agent: "deploy-bot", action: "deploy_to_production",
 *     context: { commit, approver } },
 *   async (permit) => {
 *     // The permit is verified at this point. Use permit.permitId
 *     // for downstream audit correlation.
 *     return await doDeploy(commit);
 *   },
 * );
 * ```
 *
 * Replay protection: in v1 the server consumes a permit on first
 * `verifyPermit`. A second verify on the same permit id returns
 * `verified: false`, which throws here. This guarantees the wrapped
 * function cannot be invoked twice for the same permit even if a
 * caller stashed and re-used the request — the second `withPermit`
 * call would throw before reaching `fn`.
 */

import {
  protect,
  type Permit,
  type ProtectRequest,
} from "./protect.js";

/**
 * Authorize a request and run `fn` only if AtlaSent issued and
 * verified a permit. Returns whatever `fn` returns.
 *
 * Errors fall into the same fail-closed taxonomy as {@link protect}:
 *
 * - {@link AtlaSentDeniedError} — policy denied, hold/escalate, or
 *   permit failed verification (including the replay case where the
 *   server reports `permit_consumed`). `fn` is never invoked.
 * - {@link AtlaSentError} — transport, timeout, auth, rate-limit,
 *   or server error. `fn` is never invoked.
 *
 * Errors thrown by `fn` itself propagate untouched. The permit is
 * already consumed at the point `fn` runs (v1 semantics), so we
 * cannot meaningfully roll back; surfacing the original exception
 * is the right behaviour.
 */
export async function withPermit<T>(
  request: ProtectRequest,
  fn: (permit: Permit) => Promise<T> | T,
): Promise<T> {
  // Reuse `protect` for the evaluate + verify pair so the two paths
  // never drift in fail-closed semantics or error taxonomy. If
  // `protect` ever grows new pre-action checks (e.g., risk-tier
  // gating), `withPermit` picks them up for free.
  const permit = await protect(request);
  return await fn(permit);
}
