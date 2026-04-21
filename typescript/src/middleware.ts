/**
 * Framework-agnostic authorization guards.
 *
 * Parity with Python's `atlasent.guard` (Flask / FastAPI). Each
 * helper runs {@link AtlaSentClient.gate} before the wrapped
 * handler, so on a successful return a verified permit is in hand.
 * On deny, {@link PermissionDeniedError} is either thrown (so the
 * framework's error handler catches it) or passed to `next(err)` in
 * Express' convention.
 *
 * Three entry points:
 *   - {@link guard}          — generic HOF for any handler signature
 *   - {@link expressGuard}   — `(req, res, next) => void` middleware
 *   - {@link fastifyGuard}   — Fastify `preHandler` hook
 *
 * All three accept the same resolver shape so callers can pull
 * agent / context from the request (e.g. from a JWT, a header, or
 * the URL).
 */

import type { AtlaSentClient } from "./client.js";
import type { GateResult } from "./types.js";

export interface GuardOptions<TRequest> {
  /**
   * The policy action being authorized, e.g. `"modify_patient_record"`.
   * Either a string or a function that derives it per-request.
   */
  action: string | ((req: TRequest) => string);
  /**
   * The calling agent's ID. Either a string or a resolver. Defaults
   * to the literal string `"anonymous"` if neither is provided.
   */
  agent?: string | ((req: TRequest) => string);
  /** Optional resolver for the policy context object. */
  context?: (req: TRequest) => Record<string, unknown>;
}

export interface ExpressLikeRequest {
  /** Per-request storage for the verified gate result. */
  atlasent?: GateResult;
}

export type ExpressLikeNext = (err?: unknown) => void;

/**
 * Generic higher-order wrapper: given a handler `(req) => R`, return
 * a guarded version that calls `client.gate()` first and attaches
 * the {@link GateResult} to the request as `req.atlasent`.
 *
 * Throws {@link PermissionDeniedError} on deny. Callers that prefer
 * result-based flow should call `client.authorize()` directly.
 */
export function guard<TRequest extends ExpressLikeRequest, TReturn>(
  client: AtlaSentClient,
  options: GuardOptions<TRequest>,
  handler: (req: TRequest) => TReturn | Promise<TReturn>,
): (req: TRequest) => Promise<TReturn> {
  const resolveAction = toResolver(options.action);
  const resolveAgent = toResolver(options.agent ?? "anonymous");
  const resolveContext = options.context;

  return async (req) => {
    const gateResult = await client.gate({
      action: resolveAction(req),
      agent: resolveAgent(req),
      context: resolveContext ? resolveContext(req) : {},
    });
    req.atlasent = gateResult;
    return handler(req);
  };
}

/**
 * Express-style middleware. Attaches the verified {@link GateResult}
 * as `req.atlasent` and calls `next()`. On deny or transport error,
 * calls `next(err)` so Express' error handler receives it.
 *
 * @example
 * app.post("/modify-record",
 *   expressGuard(client, { action: "modify_patient_record",
 *                          agent: (req) => req.user.id }),
 *   (req, res) => res.json({ permitHash: req.atlasent!.verification.permitHash })
 * );
 */
export function expressGuard<TRequest extends ExpressLikeRequest = ExpressLikeRequest>(
  client: AtlaSentClient,
  options: GuardOptions<TRequest>,
): (req: TRequest, res: unknown, next: ExpressLikeNext) => void {
  const resolveAction = toResolver(options.action);
  const resolveAgent = toResolver(options.agent ?? "anonymous");
  const resolveContext = options.context;

  return (req, _res, next) => {
    client
      .gate({
        action: resolveAction(req),
        agent: resolveAgent(req),
        context: resolveContext ? resolveContext(req) : {},
      })
      .then((gateResult) => {
        req.atlasent = gateResult;
        next();
      })
      .catch((err) => next(err));
  };
}

/**
 * Fastify `preHandler` hook. Attaches the verified
 * {@link GateResult} as `request.atlasent` and returns. On deny or
 * transport error, re-throws so Fastify's `setErrorHandler`
 * receives it.
 *
 * @example
 * fastify.post(
 *   "/modify-record",
 *   { preHandler: fastifyGuard(client, { action: "modify_patient_record" }) },
 *   async (req) => ({ permitHash: req.atlasent!.verification.permitHash })
 * );
 */
export function fastifyGuard<TRequest extends ExpressLikeRequest = ExpressLikeRequest>(
  client: AtlaSentClient,
  options: GuardOptions<TRequest>,
): (req: TRequest) => Promise<void> {
  const resolveAction = toResolver(options.action);
  const resolveAgent = toResolver(options.agent ?? "anonymous");
  const resolveContext = options.context;

  return async (req) => {
    const gateResult = await client.gate({
      action: resolveAction(req),
      agent: resolveAgent(req),
      context: resolveContext ? resolveContext(req) : {},
    });
    req.atlasent = gateResult;
  };
}

function toResolver<T, TRequest>(
  valueOrFn: T | ((req: TRequest) => T),
): (req: TRequest) => T {
  return typeof valueOrFn === "function"
    ? (valueOrFn as (req: TRequest) => T)
    : () => valueOrFn;
}
