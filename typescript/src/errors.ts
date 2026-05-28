/**
 * Error types for the AtlaSent TypeScript SDK.
 *
 * The SDK follows a fail-closed design: a clean policy DENY is
 * returned as `EvaluateResponse.decision === "deny"` (not thrown),
 * but any failure to confirm authorization — network, timeout,
 * bad response, invalid key, rate limit — throws an
 * {@link AtlaSentError}.
 */

// ── Streaming-specific errors ─────────────────────────────────────────────────

/**
 * Thrown when no SSE event arrives within the configured timeout window.
 *
 * Callers can catch this specifically to distinguish a stalled stream
 * from other network or parse failures:
 *
 * ```ts
 * catch (e) {
 *   if (e instanceof StreamTimeoutError) { // reconnect or alert }
 * }
 * ```
 */
export class StreamTimeoutError extends Error {
  override name: string = "StreamTimeoutError";
  /** Timeout that was exceeded, in milliseconds. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`AtlaSent stream timed out after ${timeoutMs}ms with no event`);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when the SSE stream closes with a partial / malformed JSON payload.
 *
 * This is a recoverable condition — the stream closed mid-JSON. The
 * caller can reconnect using the last received `Last-Event-ID` and
 * resume from where the server left off.
 *
 * ```ts
 * catch (e) {
 *   if (e instanceof StreamParseError) { // log raw data, maybe reconnect }
 * }
 * ```
 */
export class StreamParseError extends Error {
  override name: string = "StreamParseError";
  /** The raw data string that failed to parse. */
  readonly rawData: string;

  constructor(rawData: string, cause?: unknown) {
    super(`AtlaSent stream received malformed JSON: ${rawData.slice(0, 200)}`);
    this.rawData = rawData;
    if (cause !== undefined) {
      // ES2022 cause
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** Discriminator for {@link AtlaSentError.code}. */
export type AtlaSentErrorCode =
  | "invalid_api_key"
  | "forbidden"
  | "rate_limited"
  | "timeout"
  | "network"
  | "bad_response"
  | "bad_request"
  | "server_error"
  // Tenant lacks a v2_<feature> flag — server returned 404. Distinct
  // from "forbidden" (403 authorization denial) so callers can branch
  // on the failure mode.
  | "feature_disabled"
  | "claim_evidence_incomplete";

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
  | "permit_not_found"
  | "permit_signing_key_revoked";

const KNOWN_PERMIT_OUTCOMES: ReadonlySet<string> = new Set([
  "permit_consumed",
  "permit_expired",
  "permit_revoked",
  "permit_not_found",
  "permit_signing_key_revoked",
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
export function normalizePermitOutcome(
  raw: string | undefined,
): PermitOutcome | undefined {
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

  /**
   * `true` when the permit's signing key KID appears in the
   * trust-root revocation list (ADR-005 D3 R2/R3 key rotation).
   */
  get isSigningKeyRevoked(): boolean {
    return this.outcome === "permit_signing_key_revoked";
  }
}

// ── Bundle verification error (ADR-005 D3 fail-closed, trust-root Phase 2) ──────

/**
 * Thrown when bundle or permit verification fails due to a trust-root
 * condition: expired snapshot, revoked signing key, or key role mismatch.
 *
 * Extends {@link AtlaSentDeniedError} so `instanceof AtlaSentDeniedError`
 * catches these failures alongside policy denials; use
 * `instanceof BundleVerificationError` to branch specifically.
 *
 * The `reason` field discriminates the failure kind:
 * - `"trust_snapshot_expired"` — the pinned trust snapshot's `valid_until`
 *   has passed; obtain a fresh SDK build or enable `allowExpiredSnapshot`.
 * - `"key_revoked"` — the signing KID appears in `atlasent-revocations.json`.
 * - `"key_role_mismatch"` — the signing key's role does not match the
 *   expected role for this artifact type (e.g. R3_audit for audit bundles).
 */
export class BundleVerificationError extends AtlaSentDeniedError {
  override name: string = "BundleVerificationError";

  /** Discriminator for the trust-root failure kind. */
  readonly bundleReason:
    | "trust_snapshot_expired"
    | "key_revoked"
    | "key_role_mismatch";

  /** `valid_until` of the snapshot that triggered the failure, if applicable. */
  readonly snapshotValidUntil: string | undefined;
  /** `issued_at` of the snapshot (proxy for `fetchedAt`), if applicable. */
  readonly snapshotFetchedAt: string | undefined;
  /** Whether the snapshot came from the pinned vendor file or a live refresh. */
  readonly snapshotSource: "pinned" | "live" | undefined;

  constructor(opts: {
    bundleReason:
      | "trust_snapshot_expired"
      | "key_revoked"
      | "key_role_mismatch";
    evaluationId?: string;
    snapshotValidUntil?: string;
    snapshotFetchedAt?: string;
    snapshotSource?: "pinned" | "live";
  }) {
    super({
      decision: "deny",
      evaluationId: opts.evaluationId ?? "",
      reason: `Bundle verification failed: ${opts.bundleReason}`,
    });
    this.bundleReason = opts.bundleReason;
    this.snapshotValidUntil = opts.snapshotValidUntil;
    this.snapshotFetchedAt = opts.snapshotFetchedAt;
    this.snapshotSource = opts.snapshotSource;
  }
}

/** Initialization options for {@link AtlaSentEscalateError}. */
export interface AtlaSentEscalateErrorInit {
  requestId?: string;
  userId?: string;
  cause?: unknown;
}

/**
 * Thrown when an evaluate response carries `decision: "escalate"`.
 *
 * Distinct from {@link AtlaSentDeniedError} — an escalation does not
 * constitute a hard denial. It signals that the policy engine has
 * deferred the authorization decision to a human review queue.
 * Middleware and agent orchestrators should catch this specifically
 * and route the pending action to the appropriate HITL channel.
 *
 * ```ts
 * catch (e) {
 *   if (e instanceof AtlaSentEscalateError) {
 *     await humanReviewQueue.submit({ userId: e.userId, requestId: e.requestId });
 *   }
 * }
 * ```
 *
 * Extends {@link AtlaSentError} so `instanceof AtlaSentError` catches
 * escalations alongside other SDK errors; use
 * `instanceof AtlaSentEscalateError` to branch specifically.
 */
export class AtlaSentEscalateError extends AtlaSentError {
  override name: string = "AtlaSentEscalateError";

  /** Always `"escalate"` — discriminates this error from other AtlaSent errors. */
  readonly decision = "escalate" as const;

  /** The user whose action triggered the escalation, if available. */
  readonly userId: string | undefined;

  constructor(message: string, opts?: AtlaSentEscalateErrorInit) {
    super(message, {
      ...(opts?.requestId !== undefined ? { requestId: opts.requestId } : {}),
      cause: opts?.cause,
    });
    this.userId = opts?.userId;
  }
}

// ── Permit revocation error (PROD-D9 continuous-authorization) ────────────────

/**
 * Thrown by an SDK guard heartbeat when `GET /v1/permits/:id/valid`
 * returns `status: 'revoked'` during tool execution (PROD-D9
 * continuous-authorization lease model).
 *
 * This error is **always re-thrown** — it is never serialized as a
 * `tool-result` denial because it represents a live enforcement action,
 * not a policy evaluation at request time. Callers should treat it as
 * an immediate halt signal.
 *
 * ```ts
 * catch (e) {
 *   if (e instanceof PermitRevoked) {
 *     // log e.permitId and e.revocationId for incident correlation
 *     await incidentLog.record({ permitId: e.permitId, revocationId: e.revocationId });
 *   }
 * }
 * ```
 *
 * Guard heartbeat is configured via `permitRevalidationIntervalMs` in
 * the guard options (minimum 1000 ms). The heartbeat activates only
 * when the {@link AtlaSentClient} exposes `checkPermitValid` — i.e.
 * when `atlasent-api` has deployed `GET /v1/permits/:id/valid`.
 */
export class PermitRevoked extends AtlaSentError {
  override name: string = 'PermitRevoked';
  /** The id of the permit that was revoked mid-execution. */
  readonly permitId: string;
  /** The `scope_revocations.id` that triggered the revocation, when available. */
  readonly revocationId: string | undefined;

  constructor(permitId: string, revocationId?: string) {
    super(
      revocationId
        ? `AtlaSent: permit ${permitId} revoked (revocation: ${revocationId}) — guard heartbeat halted execution`
        : `AtlaSent: permit ${permitId} revoked — guard heartbeat halted execution`,
    );
    this.permitId = permitId;
    this.revocationId = revocationId;
  }
}

// ── Bundle verification error (ADR-005 D3 fail-closed expiry / revocation) ────

/**
 * Initialization options for {@link BundleVerificationError}.
 */
export interface BundleVerificationErrorInit {
  /**
   * Machine-readable reason code:
   *   - `trust_snapshot_expired`: the snapshot's `valid_until` has passed
   *     and `allowExpiredSnapshot` was not set.
   *   - `key_revoked`: the bundle's `signing_key_id` appears in
   *     `revoked_keys` of the active trust snapshot.
   *   - `key_role_mismatch`: the signing key's `role` is not `"R3_audit"`.
   */
  reason: "trust_snapshot_expired" | "key_revoked" | "key_role_mismatch";
  /** ISO-8601 `valid_until` of the snapshot that caused the failure. */
  snapshotValidUntil?: string;
  /** ISO-8601 `issued_at` of the snapshot (its fetch/pin time). */
  snapshotFetchedAt?: string;
  /** Whether the snapshot came from the bundled vendor files or a live refresh. */
  snapshotSource?: "pinned" | "live";
  /** Which key id was revoked or role-mismatched, when applicable. */
  kid?: string;
}

/**
 * Thrown by {@link verifyAuditBundle} / {@link verifyBundle} when the
 * active trust-root snapshot is expired (ADR-005 D3) or the bundle's
 * signing key is revoked / has the wrong role.
 *
 * This error is **always thrown** — it is never returned as a
 * {@link BundleVerificationResult} because ADR-005 D3 requires that
 * an expired snapshot or revoked key constitutes a hard enforcement
 * action, not a soft verification failure.
 *
 * To opt out of fail-closed expiry (air-gap / offline use), pass
 * `allowExpiredSnapshot: true` to `verifyBundle`.
 */
export class BundleVerificationError extends AtlaSentError {
  override name = "BundleVerificationError";

  readonly reason: BundleVerificationErrorInit["reason"];
  readonly snapshotValidUntil: string | undefined;
  readonly snapshotFetchedAt: string | undefined;
  readonly snapshotSource: "pinned" | "live" | undefined;
  readonly kid: string | undefined;

  constructor(init: BundleVerificationErrorInit) {
    super(`AtlaSent audit bundle verification failed: ${init.reason}`);
    this.reason = init.reason;
    this.snapshotValidUntil = init.snapshotValidUntil;
    this.snapshotFetchedAt = init.snapshotFetchedAt;
    this.snapshotSource = init.snapshotSource;
    this.kid = init.kid;
  }
}
