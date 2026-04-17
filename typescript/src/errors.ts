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
  override readonly name = "AtlaSentError";

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
