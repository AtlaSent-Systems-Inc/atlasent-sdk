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
 * Outcome of a denied decision.
 *
 * `"deny"` is what the current `/v1-evaluate` API returns. `"hold"`
 * and `"escalate"` are reserved for forthcoming API decisions that
 * put a permit into a pending state requiring human review; the
 * union is declared now so call sites can `switch` exhaustively
 * from the start and adopt new decisions without a breaking change.
 */
export type AtlaSentDecision = "deny" | "hold" | "escalate";

/**
 * Reason an already-issued permit failed verification.
 *
 * Surfaced on {@link AtlaSentDeniedError.outcome} so callers can
 * distinguish replay (`permit_consumed`) from revocation
 * (`permit_revoked`) from natural expiry (`permit_expired`) without
 * parsing {@link AtlaSentDeniedError.reason}. The set is defined by
 * `contract/vectors/permit_outcomes.json`; any new outcome MUST be
 * added there first.
 *
 * Mirrors the Python SDK's `PermitOutcome`. See
 * `atlasent/docs/REVOCATION_RUNBOOK.md` for the operator-facing
 * matrix this discriminator drives.
 */
export type PermitOutcome =
  | "permit_consumed"
  | "permit_expired"
  | "permit_revoked"
  | "permit_not_found";

const KNOWN_PERMIT_OUTCOMES: ReadonlySet<string> = new Set([
  "permit_consumed",
  "permit_expired",
  "permit_revoked",
  "permit_not_found",
]);

/**
 * Map a server-supplied `outcome` string to {@link PermitOutcome}.
 *
 * Returns `undefined` for `undefined`, `""`, `"verified"`, or any
 * unrecognized value. Used at the SDK's deny boundary so we don't
 * surface mis-typed outcomes — when the server adds a new outcome
 * string, callers branching on {@link AtlaSentDeniedError.outcome}
 * see `undefined` and fall through to their generic deny path
 * rather than match an unknown literal.
 */
export function normalizePermitOutcome(raw: string | undefined): PermitOutcome | undefined {
  if (raw !== undefined && KNOWN_PERMIT_OUTCOMES.has(raw)) {
    return raw as PermitOutcome;
  }
  return undefined;
}

/** Initialization options for {@link AtlaSentDeniedError}. */
export interface AtlaSentDeniedErrorInit {
  decision: AtlaSentDecision;
  evaluationId: string;
  reason?: string;
  requestId?: string;
  auditHash?: string;
  /**
   * When the denial came from permit verification (not policy
   * evaluation), the discriminator that distinguishes replay,
   * expiry, revocation, and missing-record failures. `undefined`
   * for evaluate-time denials.
   */
  outcome?: PermitOutcome;
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
  /**
   * Discriminator for permit-side denial reasons. Populated only
   * when the server reported `verified=false` from `/v1-verify-permit`;
   * `undefined` for evaluate-time denials. See {@link PermitOutcome}.
   */
  readonly outcome: PermitOutcome | undefined;

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
    this.outcome = init.outcome;
  }

  // ── Outcome discriminators ───────────────────────────────────────
  // Convenience predicates that mirror the operator runbook's matrix.
  // Callers can compare `outcome` directly; these are sugar so the
  // common cases are explicit at the call site.

  /** `true` when the permit was explicitly revoked (D3 endpoint). */
  get isRevoked(): boolean {
    return this.outcome === "permit_revoked";
  }

  /** `true` when the permit's TTL passed before verification. */
  get isExpired(): boolean {
    return this.outcome === "permit_expired";
  }

  /**
   * `true` when the permit was already consumed by a prior verify
   * (v1 single-use replay protection).
   */
  get isConsumed(): boolean {
    return this.outcome === "permit_consumed";
  }

  /**
   * `true` when the permit id wasn't recognized server-side
   * (typo, cross-tenant lookup, or pre-issuance race).
   */
  get isNotFound(): boolean {
    return this.outcome === "permit_not_found";
  }
}
