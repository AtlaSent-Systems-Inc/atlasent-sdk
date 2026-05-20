/**
 * Express middleware for AtlaSent execution-time authorization.
 *
 * ```ts
 * import express from "express";
 * import { atlaSentGuard, atlaSentErrorHandler } from "@atlasent/sdk/express";
 *
 * const app = express();
 *
 * // One-line drop-in protection for a sensitive route.
 * app.post(
 *   "/deploy",
 *   atlaSentGuard({
 *     action: "production.deploy",
 *     agent: (req) => (req.headers["x-agent-id"] as string) ?? "anonymous",
 *     context: async (req) => ({ commit: req.body?.commit }),
 *   }),
 *   (req, res) => {
 *     // Permit is on req.atlasent (cast to AtlaSentRequest).
 *     const permit = (req as AtlaSentRequest).atlasent;
 *     res.json({ ok: true, permitId: permit.permitId });
 *   },
 * );
 *
 * // One place to map AtlaSent errors to HTTP responses.
 * app.use(atlaSentErrorHandler());
 * ```
 *
 * Mirrors the Hono guard contract: fail-closed, uses {@link protect} under
 * the hood, stores the {@link Permit} on `req[key]` (default `"atlasent"`).
 * `express` is an optional peer dependency — this module is only pulled
 * in when you import from the `@atlasent/sdk/express` subpath.
 */

import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { AtlaSentDeniedError, AtlaSentError } from "./errors.js";
import { protect, type Permit, type ProtectRequest } from "./protect.js";

/** Resolver: a literal string, or a function deriving one from the request. */
type Resolver<T extends string | Record<string, unknown>> =
  | T
  | ((req: Request) => T | Promise<T>);

/** Options for {@link atlaSentGuard}. */
export interface AtlaSentGuardOptions {
  /**
   * Action being authorized (e.g. `"production.deploy"`). A string
   * fixes the action; a function derives it per-request (e.g. from
   * route params or the HTTP method).
   */
  action: Resolver<string>;
  /**
   * Agent identifier. A function lets you read it from an auth header,
   * JWT claim, session store, etc.
   */
  agent: Resolver<string>;
  /**
   * Build the policy context dict for the decision. Defaults to `{}`.
   * Receives the Express request so you can reach into headers, body,
   * route params, or previously-set middleware values.
   */
  context?: (
    req: Request,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Property name used to attach the resulting {@link Permit} to the
   * request object. Read it back with `(req as AtlaSentRequest)[key]`.
   * Default: `"atlasent"`.
   */
  key?: string;
}

/** An Express Request extended with the AtlaSent permit. */
export interface AtlaSentRequest extends Request {
  atlasent: Permit;
}

async function resolve<T>(
  value: T | ((req: Request) => T | Promise<T>),
  req: Request,
): Promise<T> {
  return typeof value === "function"
    ? await (value as (req: Request) => T | Promise<T>)(req)
    : value;
}

/**
 * Express middleware that calls {@link protect} before the wrapped
 * handler runs. On allow, attaches the {@link Permit} to `req[key]`
 * and calls `next()`. On deny or transport error, calls `next(err)`
 * so the Express error-handling chain picks it up. Attach
 * {@link atlaSentErrorHandler} via `app.use(...)` to convert those
 * errors to HTTP responses once at the app level.
 */
export function atlaSentGuard(options: AtlaSentGuardOptions): RequestHandler {
  const contextKey = options.key ?? "atlasent";
  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const [agent, action, ctx] = await Promise.all([
        resolve(options.agent, req),
        resolve(options.action, req),
        options.context ? options.context(req) : Promise.resolve(undefined),
      ]);
      const request: ProtectRequest = { agent, action };
      if (ctx !== undefined) request.context = ctx;
      const permit: Permit = await protect(request);
      (req as unknown as Record<string, unknown>)[contextKey] = permit;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Options for {@link atlaSentErrorHandler}. */
export interface AtlaSentErrorHandlerOptions {
  /** HTTP status returned on policy denial. Default: 403. */
  denyStatus?: 401 | 403 | 409 | 422;
  /** HTTP status returned on transport / auth / server failure. Default: 503. */
  errorStatus?: 500 | 502 | 503;
  /**
   * Customize the JSON body on denial. Receives the error; must return
   * a JSON-serializable object. Defaults to
   * `{ error, decision, evaluationId, reason?, requestId? }`.
   */
  renderDeny?: (err: AtlaSentDeniedError) => Record<string, unknown>;
  /** Customize the JSON body on transport/auth/server errors. */
  renderError?: (err: AtlaSentError) => Record<string, unknown>;
}

function defaultRenderDeny(err: AtlaSentDeniedError): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: "denied",
    decision: err.decision,
    evaluationId: err.evaluationId,
  };
  if (err.reason !== undefined) body.reason = err.reason;
  if (err.requestId !== undefined) body.requestId = err.requestId;
  return body;
}

function defaultRenderError(err: AtlaSentError): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: "unavailable",
    code: err.code ?? "unknown",
  };
  if (err.requestId !== undefined) body.requestId = err.requestId;
  return body;
}

/**
 * Express error-handler that converts AtlaSent exceptions into
 * appropriate HTTP responses. Install once at the app level:
 *
 * ```ts
 * app.use(atlaSentErrorHandler());
 * ```
 *
 * Non-AtlaSent errors are forwarded to the next error handler via
 * `next(err)` so other error-handling middleware still sees them.
 */
export function atlaSentErrorHandler(
  options: AtlaSentErrorHandlerOptions = {},
): ErrorRequestHandler {
  const denyStatus = options.denyStatus ?? 403;
  const errorStatus = options.errorStatus ?? 503;
  const renderDeny = options.renderDeny ?? defaultRenderDeny;
  const renderError = options.renderError ?? defaultRenderError;

  // Express requires exactly 4 parameters for error-handler middleware.
  return (
    err: unknown,
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (err instanceof AtlaSentDeniedError) {
      res.status(denyStatus).json(renderDeny(err));
      return;
    }
    if (err instanceof AtlaSentError) {
      res.status(errorStatus).json(renderError(err));
      return;
    }
    next(err);
  };
}

// Re-export the types callers need so the subpath is self-contained.
export type { Permit, ProtectRequest } from "./protect.js";
export { AtlaSentDeniedError, AtlaSentError } from "./errors.js";
