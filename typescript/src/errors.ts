/**
 * Error types for the AtlaSent TypeScript SDK.
 *
 * The SDK follows a fail-closed design: a clean policy DENY is
 * returned as `EvaluateResponse.decision === "DENY"` (not thrown),
 * but any failure to confirm authorization — network, timeout,
 * bad response, invalid key, rate limit — throws an
 * {@link AtlaSentError}.
 */

import type { RateLimitState } from "./types.js";

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
  rateLimit?: RateLimitState | null;
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
  // Subclasses override to their own literal (e.g. "AtlaSentDeniedError");
  // keep this assignable rather than pinned to a single literal.
  override name: string = "AtlaSentError";

  /** HTTP status code, when the error originated from an API response. */
  readonly status: number | undefined;
  /** Coarse category — useful for `switch` statements at call sites. */
  readonly code: AtlaSentErrorCode | undefined;
  /** Correlation ID echoed from the `X-Request-ID` header the SDK sent. */
  readonly requestId: string | undefined;
  /** Parsed `Retry-After` header value, in milliseconds. Only set for 429. */
  readonly retryAfterMs: number | undefined;
  /**
   * Per-key rate-limit state from the response's `X-RateLimit-*`
   * headers, when they were emitted. Populated on 429 responses so
   * consumers can inspect which budget was blown (`limit`) and when
   * it resets (`resetAt`) without having to also catch `retryAfterMs`
   * separately. `null` on other status codes or when the server
   * didn't emit the headers.
   */
  readonly rateLimit: RateLimitState | null | undefined;

  constructor(message: string, init: AtlaSentErrorInit = {}) {
    super(
      message,
      init.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
    this.rateLimit = init.rateLimit;
  }
}

/**
 * Outcome of a denied decision.
 *
 * `"deny"` is what the current `/v1-evaluate` API returns. `"hold"`
 * and `"escalate"` are reserved for forthcoming API decisions that
 * put a permit into a pending state requiring human review; the
 * union is declared now so call sites can `switch` exhaustively
 * from the start and adopt new decisions without a breaking change.
 */
export type AtlaSentDecision = "deny" | "hold" | "escalate";

/** Initialization options for {@link AtlaSentDeniedError}. */
export interface AtlaSentDeniedErrorInit {
  decision: AtlaSentDecision;
  evaluationId: string;
  reason?: string;
  requestId?: string;
  auditHash?: string;
}

/**
 * Thrown by {@link atlasent.protect} when the policy engine refuses
 * the action, or when a permit fails end-to-end verification.
 *
 * This is the **fail-closed boundary** of the SDK: every code path
 * that short-circuits an action because authorization was not
 * confirmed raises an `AtlaSentDeniedError`. Callers cannot silently
 * proceed on a denial by forgetting to branch on a return value.
 *
 * Extends {@link AtlaSentError} so `instanceof AtlaSentError`
 * catches denials as part of the SDK's single exception family;
 * use `instanceof AtlaSentDeniedError` to distinguish a policy
 * denial from a transport/auth error.
 */
export class AtlaSentDeniedError extends AtlaSentError {
  override name: string = "AtlaSentDeniedError";

  /** Policy decision — `"deny"` today; `"hold"` / `"escalate"` reserved. */
  readonly decision: AtlaSentDecision;
  /** Opaque permit/decision id from `/v1-evaluate`. */
  readonly evaluationId: string;
  /** Human-readable explanation from the policy engine, if provided. */
  readonly reason: string | undefined;
  /** Hash-chained audit-trail entry associated with the decision. */
  readonly auditHash: string | undefined;

  constructor(init: AtlaSentDeniedErrorInit) {
    const msg = init.reason
      ? `AtlaSent ${init.decision}: ${init.reason}`
      : `AtlaSent ${init.decision}`;
    const errInit: AtlaSentErrorInit = { status: 200 };
    if (init.requestId !== undefined) errInit.requestId = init.requestId;
    super(msg, errInit);
    this.decision = init.decision;
    this.evaluationId = init.evaluationId;
    this.reason = init.reason;
    this.auditHash = init.auditHash;
  }
}
