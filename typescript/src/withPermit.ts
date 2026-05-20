/**
 * `atlasent.withPermit(...)` — the lexically-scoped form of
 * {@link protect}. TypeScript mirror of the Python SDK's
 * ``atlasent.with_permit(...)``.
 *
 * Same execution-boundary contract as {@link protect}: evaluate +
 * verifyPermit run end-to-end before the executor is invoked, and the
 * executor cannot run unless a verified {@link Permit} was returned.
 * The difference is purely lexical — `withPermit` binds the execution
 * to the permit's lifetime via a callback, so the call site reads as
 * "execute this body under a permit" rather than "fetch a permit and
 * run code under it manually."
 *
 * ```ts
 * import atlasent from "@atlasent/sdk";
 *
 * const ok = await atlasent.withPermit(
 *   {
 *     agent: "deploy-bot",
 *     action: "production.deploy",
 *     context: { commit, approver },
 *   },
 *   async (permit) => {
 *     const result = await runDeploy(commit);
 *     return { ok: true, permitId: permit.permitId, result };
 *   },
 * );
 * ```
 *
 * Pick the form that fits the call site:
 *
 * - {@link protect} when the caller wants the verified permit as a
 *   value (e.g. to pass it across a process boundary, persist it
 *   alongside their own record, or interleave it with non-trivial
 *   control flow).
 * - {@link withPermit} when the action body is a single lexical scope
 *   and "no permit, no execution" is the only thing the call site
 *   needs to express.
 *
 * Both surfaces use the same underlying primitive and produce the
 * same audit-chain entry.
 */

import { protect, type Permit, type ProtectRequest } from "./protect.js";

/**
 * Authorize a request end-to-end and invoke `fn` only on a verified
 * permit.
 *
 * @param request Same shape as {@link ProtectRequest}.
 * @param fn Invoked with the verified {@link Permit}. Its return
 *   value (awaited if it is a promise) is propagated to the caller.
 *
 * @returns Whatever `fn` returns.
 *
 * @throws {AtlaSentDeniedError} Policy denied, hold/escalate, or
 *   permit failed verification. `fn` is never invoked.
 * @throws {AtlaSentError} Transport, timeout, auth, rate-limit, or
 *   server error. `fn` is never invoked.
 *
 * Errors thrown inside `fn` propagate untouched — the permit is
 * already consumed by the verify step in v1, so there is no
 * compensating revoke.
 */
export async function withPermit<T>(
  request: ProtectRequest,
  fn: (permit: Permit) => Promise<T> | T,
): Promise<T> {
  const permit = await protect(request);
  return await fn(permit);
}
