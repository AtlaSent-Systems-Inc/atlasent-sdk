/**
 * Error types for the AtlaSent TypeScript SDK.
 *
 * The SDK follows a fail-closed design: a clean policy DENY is
 * returned as `EvaluateResponse.decision === "DENY"` (not thrown),
 * but any failure to confirm authorization — network, timeout,
 * bad response, invalid key, rate limit — throws an
 * {@link AtlaSentError}.
 */

/** Discriminator for {@link AtlaSentError.code}. */
export type AtlaSentErrorCode =
  | "invalid_api_key"
  | "forbidden"
  | "rate_limited"
  | "timeout"
  | "network"
  | "bad_response"
  | "bad_request"
  | "server_error";

/** Initialization options for {@link AtlaSentError}. */
export interface AtlaSentErrorInit {
  status?: number;
  code?: AtlaSentErrorCode;
  requestId?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * The only error type this SDK throws.
 *
 * Flat top-level properties mirror the convention used by Stripe,
 * Octokit, and Supabase. `cause` is forwarded to the standard
 * ES2022 `Error` constructor.
 */
export class AtlaSentError extends Error {
  override readonly name: string = "AtlaSentError";

  /** HTTP status code, when the error originated from an API response. */
  readonly status: number | undefined;
  /** Coarse category — useful for `switch` statements at call sites. */
  readonly code: AtlaSentErrorCode | undefined;
  /** Correlation ID echoed from the `X-Request-ID` header the SDK sent. */
  readonly requestId: string | undefined;
  /** Parsed `Retry-After` header value, in milliseconds. Only set for 429. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, init: AtlaSentErrorInit = {}) {
    super(
      message,
      init.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
  }
}

/**
 * Initialization options for {@link PermissionDeniedError}.
 */
export interface PermissionDeniedErrorInit {
  /** The permit ID returned in the deny decision, if any. */
  permitId?: string;
  /** Human-readable reason from the policy engine. */
  reason?: string;
  /** Raw response body from the API, for audit / debugging. */
  responseBody?: Record<string, unknown>;
}

/**
 * Thrown by {@link AtlaSentClient.authorize} when called with
 * `raiseOnDeny: true` and the policy engine denies the action.
 *
 * Inherits from {@link AtlaSentError} so a single `catch
 * (err: AtlaSentError)` covers both transport failures and policy
 * denials at call sites that prefer exceptions over result branching.
 */
export class PermissionDeniedError extends AtlaSentError {
  override readonly name: string = "PermissionDeniedError";

  readonly permitId: string;
  readonly reason: string;
  readonly responseBody: Record<string, unknown> | undefined;

  constructor(init: PermissionDeniedErrorInit = {}) {
    super(init.reason || "Action denied by policy", { code: "forbidden" });
    this.permitId = init.permitId ?? "";
    this.reason = init.reason ?? "";
    this.responseBody = init.responseBody;
  }
}
