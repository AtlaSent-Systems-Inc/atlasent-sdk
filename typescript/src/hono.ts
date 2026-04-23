/**
 * Hono middleware for AtlaSent execution-time authorization.
 *
 * ```ts
 * import { Hono } from "hono";
 * import { atlaSentGuard, atlaSentErrorHandler } from "@atlasent/sdk/hono";
 *
 * const app = new Hono();
 *
 * // One-line drop-in protection for a sensitive route.
 * app.post(
 *   "/deploy",
 *   atlaSentGuard({
 *     action: "deploy_to_production",
 *     agent: (c) => c.req.header("x-agent-id") ?? "anonymous",
 *     context: async (c) => ({ commit: (await c.req.json()).commit }),
 *   }),
 *   (c) => {
 *     // If we got here, AtlaSent allowed the action end-to-end.
 *     const permit = c.get("atlasent");
 *     return c.json({ ok: true, permitId: permit.permitId });
 *   },
 * );
 *
 * // One place to map AtlaSent errors to HTTP responses.
 * app.onError(atlaSentErrorHandler());
 * ```
 *
 * The guard calls {@link protect} under the hood — same fail-closed
 * semantics. On allow, it stashes the {@link Permit} on the Hono
 * context (default key: `"atlasent"`) and calls `next()`. On anything
 * else, it **throws**: {@link AtlaSentDeniedError} for policy denials
 * and verification failures, {@link AtlaSentError} for transport /
 * auth / server failures. Attach {@link atlaSentErrorHandler} via
 * `app.onError(...)` to turn those into HTTP responses once, at the
 * app level, rather than wrap every guarded route.
 *
 * `hono` is an optional peer dependency — this module is only pulled
 * in when you import from the `@atlasent/sdk/hono` subpath.
 */

import type { Context, ErrorHandler, MiddlewareHandler } from "hono";

import {
  AtlaSentDeniedError,
  AtlaSentError,
} from "./errors.js";
import { protect, type Permit, type ProtectRequest } from "./protect.js";

/** Resolver: a literal string, or a function deriving one from the request. */
type Resolver<T extends string | Record<string, unknown>> =
  | T
  | ((c: Context) => T | Promise<T>);

/** Options for {@link atlaSentGuard}. */
export interface AtlaSentGuardOptions {
  /**
   * Action being authorized (e.g. `"deploy_to_production"`). A string
   * fixes the action; a function lets you derive it per-request (e.g.
   * from route params or the HTTP verb).
   */
  action: Resolver<string>;
  /**
   * Agent identifier. A string fixes the caller; a function lets you
   * read it from an auth header, JWT claim, session, etc.
   */
  agent: Resolver<string>;
  /**
   * Build the policy context dict for the decision. Defaults to `{}`.
   * Receives the Hono context so you can reach into headers, body,
   * route params, or previously-set middleware values.
   */
  context?: (c: Context) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Key used to stash the resulting {@link Permit} on the Hono
   * context via `c.set(...)`. Callers read it back with
   * `c.get(options.key)`. Default: `"atlasent"`.
   */
  key?: string;
}

const DEFAULT_CONTEXT_KEY = "atlasent";

async function resolve<T>(
  value: T | ((c: Context) => T | Promise<T>),
  c: Context,
): Promise<T> {
  return typeof value === "function"
    ? await (value as (c: Context) => T | Promise<T>)(c)
    : value;
}

/**
 * Hono middleware that calls {@link protect} before the wrapped
 * handler runs. On allow, stores the {@link Permit} on the context;
 * on deny or error, throws. Use {@link atlaSentErrorHandler} with
 * `app.onError(...)` to turn those throws into HTTP responses.
 */
export function atlaSentGuard(
  options: AtlaSentGuardOptions,
): MiddlewareHandler {
  const contextKey = options.key ?? DEFAULT_CONTEXT_KEY;
  return async (c, next) => {
    const [agent, action, ctx] = await Promise.all([
      resolve(options.agent, c),
      resolve(options.action, c),
      options.context ? options.context(c) : Promise.resolve(undefined),
    ]);

    const request: ProtectRequest = { agent, action };
    if (ctx !== undefined) request.context = ctx;

    const permit: Permit = await protect(request);
    c.set(contextKey, permit);
    await next();
  };
}

/** Options for {@link atlaSentErrorHandler}. */
export interface AtlaSentErrorHandlerOptions {
  /** HTTP status returned on policy denial. Default: 403. */
  denyStatus?: 401 | 403 | 409 | 422;
  /** HTTP status returned on transport / auth / server failure. Default: 503. */
  errorStatus?: 502 | 503 | 500;
  /**
   * Hook to customize the JSON body returned on denial. Receives the
   * error; must return a JSON-serializable object. Defaults to a
   * minimal `{ error, decision, evaluationId, reason?, requestId? }`.
   */
  renderDeny?: (err: AtlaSentDeniedError) => Record<string, unknown>;
  /** Hook for transport/auth/server errors. Defaults to `{ error, code, requestId? }`. */
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
 * Hono error handler that converts AtlaSent exceptions into
 * appropriate HTTP responses. Install once at the app level:
 *
 * ```ts
 * app.onError(atlaSentErrorHandler());
 * ```
 *
 * Non-AtlaSent errors re-throw so other `onError` chains (or Hono's
 * default 500 handler) still see them.
 */
export function atlaSentErrorHandler(
  options: AtlaSentErrorHandlerOptions = {},
): ErrorHandler {
  const denyStatus = options.denyStatus ?? 403;
  const errorStatus = options.errorStatus ?? 503;
  const renderDeny = options.renderDeny ?? defaultRenderDeny;
  const renderError = options.renderError ?? defaultRenderError;

  return (err, c) => {
    if (err instanceof AtlaSentDeniedError) {
      return c.json(renderDeny(err), denyStatus);
    }
    if (err instanceof AtlaSentError) {
      return c.json(renderError(err), errorStatus);
    }
    throw err;
  };
}

// Re-export the types callers need in one place so the subpath is
// self-contained.
export type { Permit, ProtectRequest } from "./protect.js";
export { AtlaSentDeniedError, AtlaSentError } from "./errors.js";
