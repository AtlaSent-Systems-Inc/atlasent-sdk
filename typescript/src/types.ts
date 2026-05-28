/**
 * Public types for the AtlaSent TypeScript SDK.
 *
 * These shapes are deliberately minimal and 1:1 with the AtlaSent
 * authorization API. Request / response fields are camelCase on the
 * SDK side; the client handles snake_case translation on the wire.
 */

import type { AuditEventsPage, AuditExport } from "./audit.js";

/**
 * Canonical 4-value policy decision, byte-identical to the wire.
 *
 * - `allow`    — action is authorized; a Permit is issued.
 * - `deny`     — action is blocked.
 * - `hold`     — decision deferred (e.g. waiting on an approval signal).
 * - `escalate` — routed to a human reviewer queue.
 *
 * Pin to this type on new code.
 */
export type DecisionCanonical = "allow" | "deny" | "hold" | "escalate";

/**
 * Decision type — unified with the canonical 4-value vocabulary.
 *
 * This type previously emitted `"ALLOW"` / `"DENY"` (uppercase, 2-value).
 * It now reflects the canonical wire values (`"allow" | "deny" | "hold" |
 * "escalate"`) so the `decision` and `decision_canonical` fields on
 * {@link EvaluateResponse} carry identical values and types.
 *
 * Backward compatibility: the SDK normalises API response values to
 * lowercase (`.toLowerCase()`) before returning them, so callers that
 * previously checked `=== "ALLOW"` must update to `=== "allow"`. The
 * canonical field `decision_canonical` is also available and was always
 * lowercase — prefer it on new code.
 *
 * Legacy uppercase input accepted by the SDK is normalised to lowercase
 * output; `"ALLOW"` in → `"allow"` out, `"DENY"` in → `"deny"` out.
 */
export type Decision = DecisionCanonical;

/**
 * Rate-limit state parsed from the server's `X-RateLimit-*` headers.
 *
 * Present on every authenticated response (success and 429) when the
 * server emits the headers. `null` when the server doesn't — older
 * deployments, or internal endpoints that skip per-key rate limiting.
 *
 * Clients should check `remaining` and sleep until `resetAt` to
 * preemptively back off before hitting a 429.
 */
export interface RateLimitState {
  /** Value of `X-RateLimit-Limit` — the per-minute budget. */
  limit: number;
  /** Value of `X-RateLimit-Remaining` — unused budget in the current window. */
  remaining: number;
  /**
   * Parsed `X-RateLimit-Reset` — the UTC instant when the current
   * window's counter zeroes. Accepts either a unix-seconds integer or
   * an ISO 8601 string on the wire.
   */
  resetAt: Date;
}

/**
 * Canonical Deploy Gate V1 protected action.
 *
 * Use this constant (or its string value `"production.deploy"`) on all
 * new code. Server-side `action_classes.slug` was canonicalised to
 * `production.deploy` in atlasent-api PR #662 / atlasent-console
 * PR #432; the SDK default now matches.
 */
export const PRODUCTION_DEPLOY_ACTION = "production.deploy" as const;

/**
 * Legacy alias for {@link PRODUCTION_DEPLOY_ACTION}.
 *
 * @deprecated since 2.3.0 — use {@link PRODUCTION_DEPLOY_ACTION}. The
 * server alias-tolerates `deployment.production` during the V1 alias
 * window, so existing callers continue to work unchanged; please
 * migrate by the next minor release.
 */
export const DEPLOYMENT_PRODUCTION_ACTION = "deployment.production" as const;

// ── Deploy Gate V1 context types ──────────────────────────────────────────────

/**
 * Permit claim for `production.deploy` evaluations (Rule 3).
 *
 * Pass as `permit` inside {@link DeployGateContext}.
 * The `verified` flag is set by the verify-permit service after a
 * successful `/v1-verify-permit` call — do not self-assert it.
 */
export interface DeployPermitClaim {
  permit_id?: string;
  environment?: string;
  action_type?: string;
  /** ISO-8601 timestamp when the permit was issued. */
  issued_at?: string;
  /** Set server-side by the verify-permit service. Do not self-assert. */
  verified?: boolean;
}

/**
 * Override claim for `production.deploy` evaluations (Rule 8).
 *
 * Both `override_reason` and `authority_basis` must be non-empty to
 * receive `OVERRIDE_APPROVED`. Missing or blank fields return `DENY_POLICY`.
 */
export interface DeployOverrideClaim {
  /** Human-readable reason. Required and non-empty. */
  override_reason?: string;
  /** Authoritative basis — runbook section, incident ticket, etc. Required and non-empty. */
  authority_basis?: string;
  /** Approver actor ID (audit record; does not gate the decision). */
  approver_actor_id?: string;
}

/**
 * Typed context shape for `production.deploy` evaluations.
 *
 * Pass as `context` to `protect()`, `deployGate()`, or
 * {@link AtlaSentClient.evaluate} for the Deploy Gate V1 flow.
 *
 * @example
 * ```ts
 * const permit = await atlasent.protect({
 *   agent: "deploy-bot",
 *   action: PRODUCTION_DEPLOY_ACTION,
 *   context: {
 *     environment: "production",
 *     evaluation_confirmed: true,
 *     actorMetadata: { role: "deploy_engineer" },
 *     permit: {
 *       permit_id: permitToken,
 *       environment: "production",
 *       action_type: PRODUCTION_DEPLOY_ACTION,
 *       issued_at: new Date().toISOString(),
 *       verified: true,
 *     },
 *   } satisfies DeployGateContext,
 * });
 * ```
 */
export interface DeployGateContext {
  /** Must be `"production"` for the production gate to apply. */
  environment?: "production" | "staging" | "development";
  /**
   * When `true`, all rule failures are shadowed to `allow` (fail-open).
   * Malformed-timestamp inconsistencies still escalate.
   * Use for initial rollout before locking enforcement.
   */
  pilot_mode?: boolean;
  /** Must be `true` — confirms an evaluation record exists before proceeding. */
  evaluation_confirmed?: boolean;
  /** ISO-8601 timestamp of when evaluation was confirmed. */
  evaluation_confirmed_at?: string;
  /** Actor role metadata. `role` must be one of the approved deploy roles. */
  actorMetadata?: { role?: string };
  /** Signed permit claim — required for non-pilot production deployments. */
  permit?: DeployPermitClaim;
  /** Override claim — short-circuits all rules when both fields are non-empty. */
  override?: DeployOverrideClaim;
  [key: string]: unknown;
}

/**
 * Canonical deploy gate decision codes emitted for `production.deploy`.
 *
 * Appears as `deny_code` / `matchedRuleId` on evaluation responses.
 * Pin dashboards, alerting, and routing logic to these codes — not to
 * `deny_reason` strings, which may change.
 */
export type DeployGateDenyCode =
  | "ALLOW"
  | "DENY_POLICY"
  | "DENY_AUTHORITY"
  | "DENY_ENVIRONMENT"
  | "PERMIT_EXPIRED"
  | "VERIFY_FAILED"
  | "ESCALATE_REQUIRED"
  | "OVERRIDE_APPROVED";

/** Typed constants for {@link DeployGateDenyCode}. */
export const DEPLOY_GATE_CODES = Object.freeze({
  ALLOW: "ALLOW",
  DENY_POLICY: "DENY_POLICY",
  DENY_AUTHORITY: "DENY_AUTHORITY",
  DENY_ENVIRONMENT: "DENY_ENVIRONMENT",
  PERMIT_EXPIRED: "PERMIT_EXPIRED",
  VERIFY_FAILED: "VERIFY_FAILED",
  ESCALATE_REQUIRED: "ESCALATE_REQUIRED",
  OVERRIDE_APPROVED: "OVERRIDE_APPROVED",
} satisfies Record<DeployGateDenyCode, DeployGateDenyCode>);

/** Input to {@link AtlaSentClient.deployGate}. */
export interface DeployGateRequest {
  /** CI/repo actor performing the deployment. Defaults to `ci-deploy-bot`. */
  agent?: string;
  /** Protected action. Defaults to `production.deploy`. */
  action?:
    | typeof PRODUCTION_DEPLOY_ACTION
    | typeof DEPLOYMENT_PRODUCTION_ACTION
    | string;
  /** Typed deploy gate context for `production.deploy`. */
  context?: DeployGateContext | Record<string, unknown>;
}

/** Evidence metadata returned by {@link AtlaSentClient.deployGate}. */
export interface DeployGateEvidence {
  permitId?: string;
  permitHash?: string;
  auditHash?: string;
  verifiedAt?: string;
}

/** Result of the canonical Deploy Gate V1 flow. */
export interface DeployGateResponse {
  /** True only after evaluate allowed AND `/v1-verify-permit` verified server-side. */
  allowed: boolean;
  /** Evaluation response from `POST /v1-evaluate`, when available. */
  evaluation?: EvaluateResponse;
  /** Verification response from `POST /v1-verify-permit`, when evaluation allowed. */
  verification?: VerifyPermitResponse;
  /** Human-readable block/allow reason. */
  reason: string;
  /** Best-effort audit/evidence metadata available to the SDK. */
  evidence: DeployGateEvidence;
}

/**
 * Frozen BVS snapshot wire shape (BI4).
 * Carried in {@link EvaluateRequest}.context.bvsSnapshot when
 * the `behavior_conditioning` flag is enabled for the tenant.
 * Produced by behavior-insights GET /api/patterns/snapshot/:userId
 * and attached via `@atlasent/behavior` attachToEvaluate().
 */
export interface BvsSnapshot {
  user_id: string;
  /** Factor model output — keyed by BVS factor slug, value is score 0-1. */
  factors: Record<string, number>;
  /** Aggregate confidence score (0-1). Decays on a 60-day half-life. */
  confidence: number;
  /** True when the aggregate is fresh-and-thin (too few events to trust). */
  confidence_low: boolean;
  /** ISO-8601 timestamp of the compute run that produced this snapshot. */
  computed_at: string;
}

/**
 * Consent-class projection (BI5) — the privacy-safe aggregate shape that
 * third-party apps (LedgersMe, hiCoach, echobloom) receive when reading a
 * user's behavioral summary. Counts and timestamps only; no raw free-text.
 * Produced by behavior-insights `/api/patterns/summary/:userId` and fetched
 * via `@atlasent/behavior` getStateSummary(). The SDK enforces
 * {@link https://github.com/AtlaSent-Systems-Inc/atlasent-sdk | assertNoRawText}
 * client-side before returning this shape to callers.
 */
export interface ConsentClassProjection {
  user_id: string;
  window_start: string;
  window_end: string;
  event_count: number;
  category_counts: Partial<Record<string, number>>;
}

/** Input to {@link AtlaSentClient.evaluate}. */
export interface EvaluateRequest {
  /** Identifier of the calling agent (e.g. "clinical-data-agent"). */
  agent: string;
  /** The action being authorized (e.g. "modify_patient_record"). */
  action: string;
  /** Arbitrary policy context (user, environment, resource IDs). */
  context?: Record<string, unknown>;
  /**
   * When `true`, the server populates `riskEnvelope.factors` with a
   * per-factor breakdown of the weighted risk score. Omit (or `false`)
   * to keep response payloads small.
   */
  explain?: boolean;
}

/**
 * Slim permit object embedded in {@link EvaluateResponse} when the decision
 * is `"allow"`. Contains the essential fields needed to act on the permit
 * immediately without a separate `GET /v1/permits/:id` round-trip.
 *
 * Mirrors the `Permit` schema in atlasent-control-plane
 * `api/src/schemas/permits.ts`.
 */
export interface EvaluateResponsePermit {
  id: string;
  orgId: string;
  subject: string;
  scope: string;
  status: "active" | "revoked" | "expired";
  /** The evaluation that produced this permit. */
  evaluationId: string | null;
  issuedBy: string;
  revokedBy: string | null;
  /** ISO-8601 issuance timestamp. */
  issuedAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  metadata: Record<string, unknown> | null;
}

/** Result of {@link AtlaSentClient.evaluate}. */
export interface EvaluateResponse {
  /**
   * Policy decision — canonical 4-value lowercase vocabulary:
   * `"allow"`, `"deny"`, `"hold"`, or `"escalate"`.
   *
   * Previously emitted `"ALLOW"` / `"DENY"` (uppercase, 2-value);
   * the SDK now normalises all values to lowercase and passes `hold`
   * and `escalate` through rather than collapsing them to `"DENY"`.
   *
   * The `decision_canonical` field carries the same value and is the
   * recommended field for new code.
   */
  decision: Decision;
  /**
   * Canonical 4-value decision, byte-identical to the wire.
   *
   * One of `"allow"`, `"deny"`, `"hold"`, `"escalate"`. Branch on
   * this field on new code. `hold` and `escalate` are non-terminal
   * states that route to a human reviewer / approval signal — they
   * are not equivalent to a `deny`.
   */
  decision_canonical: DecisionCanonical;
  /**
   * Server-assigned identifier for this evaluation decision.
   *
   * Stable across retries and used as the key for proof retrieval
   * (`GET /v1/proof/:evaluationId`) and override requests. Also
   * available as the legacy `permitId` field for backward compatibility.
   */
  evaluationId: string;
  /** Opaque permit identifier, passed to {@link AtlaSentClient.verifyPermit}.
   *
   * @deprecated Prefer `evaluationId`. This field is kept for backward
   * compatibility and points to the same server-assigned ID.
   */
  permitId: string;
  /**
   * Slim permit object issued when `decision === "allow"`.
   * `null` on deny, hold, or escalate decisions.
   *
   * Mirrors the `Permit` schema from the control-plane.
   */
  permit: EvaluateResponsePermit | null;
  /**
   * Opaque HMAC-signed permit token issued when `decision === "allow"`.
   * Pass to `POST /v1/verify-permit` to verify the permit server-side.
   * `null` on deny, hold, or escalate decisions.
   */
  permitToken: string | null;
  /**
   * Machine-readable reasons emitted by the policy engine.
   *
   * The array may be empty. For deny/hold/escalate decisions the array
   * typically contains a single human-readable explanation; for allow
   * decisions it is often empty. Do not parse these strings — use
   * `decision` for branching.
   */
  reasons: string[];
  /** Human-readable explanation from the policy engine.
   *
   * @deprecated Prefer `reasons[0]` or `reasons`. This field is the
   * first element of `reasons` (or an empty string) for backward compat.
   */
  reason: string;
  /** Hash-chained audit-trail entry (21 CFR Part 11 / GxP-ready). */
  auditHash: string;
  /** ISO 8601 timestamp of the decision. */
  timestamp: string;
  /**
   * Per-key rate-limit state for this request's response, parsed from
   * `X-RateLimit-*` headers. `null` when the server didn't emit them.
   */
  rateLimit: RateLimitState | null;
  /**
   * Risk envelope summary from the policy engine. Present on all responses
   * from engine version wire-v1@1.0.0+. Provides the weighted risk score,
   * the pre/post-promotion decisions, and (when evaluate was called with
   * `explain: true`) a per-factor breakdown.
   *
   * The envelope can only raise severity — it structurally cannot soften
   * a deny to allow. When `promoted` is true the live `decision` was
   * upgraded from `engineDecision` to `envelopeDecision`.
   */
  riskEnvelope?: EvaluateRiskEnvelope;
}

/** Per-factor contribution in a {@link EvaluateRiskEnvelope}. */
export interface EvaluateRiskEnvelopeFactor {
  /** Factor identifier, e.g. `"ACTION_SENSITIVITY"`. */
  factor: string;
  /** Factor score in [0, 1]. Higher = more risk. */
  value: number;
  /** Configured weight for this factor. */
  weight: number;
  /** Human-readable explanation for the score. */
  reason: string;
}

/** Risk envelope summary returned in a top-level {@link EvaluateResponse}. */
export interface EvaluateRiskEnvelope {
  /** Weighted risk score in [0, 1]. Score ≥ 0.70 triggers a hold. */
  weightedScore: number;
  /** Policy engine decision before envelope promotion. */
  engineDecision: Decision;
  /** Decision resolved by the risk envelope. */
  envelopeDecision: Decision;
  /** `true` when the envelope raised the decision's severity (most-restrictive-wins). */
  promoted: boolean;
  /** Deny codes that unconditionally block regardless of score. */
  hardBlocks: string[];
  /** Per-factor breakdown. Present only when `explain: true` was passed. */
  factors?: EvaluateRiskEnvelopeFactor[];
}

/** Input to {@link AtlaSentClient.verifyPermit}. */
export interface VerifyPermitRequest {
  /** The permit ID returned by a prior evaluate() call. */
  permitId: string;
  /** Optional: re-state the action for cross-check with the server. */
  action?: string;
  /** Optional: re-state the agent for cross-check with the server. */
  agent?: string;
  /** Optional: re-state the context for cross-check with the server. */
  context?: Record<string, unknown>;
  /**
   * Environment of the permit being verified. Sourced from the evaluate
   * payload (context.environment → top-level environment → "production").
   * Required by the server for production permits as of 2026-05-14.
   * P1-1 fix: withPermit/protect now always populates this field.
   */
  environment?: string;
  /**
   * SHA-256 hex digest of the recursively key-sorted canonical JSON of the
   * original evaluate payload. Required by the server for production permits
   * as of 2026-05-14.
   * P1-5 fix: withPermit/protect now always computes and sends this field.
   */
  execution_hash?: string;
}

/**
 * Result of {@link AtlaSentClient.verifyPermit}.
 *
 * @deprecated Use {@link VerifyPermitByIdResponse} via
 * {@link AtlaSentClient.verifyPermitById} — the canonical REST surface
 * (`POST /v1/permits/{id}/verify`) returns the unified verification
 * envelope (`valid`, `verification_type`, `reason`, `verified_at`,
 * `evidence`) plus the full {@link PermitRecord} fields. Will be
 * removed in `@atlasent/sdk@3`.
 */
export interface VerifyPermitResponse {
  /** `true` when the permit is valid and un-revoked. */
  verified: boolean;
  /** Verification outcome string from the server. */
  outcome: string;
  /** Verification hash bound to the permit. */
  permitHash: string;
  /** ISO 8601 timestamp of the verification. */
  timestamp: string;
  /**
   * ISO-8601 expiration timestamp of the permit. `null` on pre-rollout
   * server versions that do not yet surface this field.
   */
  expiresAt: string | null;
  /**
   * Per-key rate-limit state for this request's response, parsed from
   * `X-RateLimit-*` headers. `null` when the server didn't emit them.
   */
  rateLimit: RateLimitState | null;
}

/**
 * Result of {@link AtlaSentClient.keySelf} — self-introspection of the API
 * key the client was constructed with. Returned by `GET /v1/api-key-self`.
 *
 * Never includes the raw key or its hash — introspection is intentionally
 * read-only and safe to surface in operator dashboards. Useful for:
 *   - "which key am I?" debugging
 *   - IP_NOT_ALLOWED failures — `clientIp` is the IP the server observed
 *   - proactive expiry warnings — `expiresAt` is the server-stored expiry
 *     (`null` means the key does not auto-expire)
 *   - verifying scopes before attempting a scope-gated action
 */
export interface ApiKeySelfResponse {
  /** Server-side UUID of the api_keys row for this key. */
  keyId: string;
  /** Organization the key belongs to. */
  organizationId: string;
  /** "live" or "test" (or any future environment label the server introduces). */
  environment: string;
  /** Granted scopes — e.g. ["evaluate", "audit.read"]. */
  scopes: string[];
  /**
   * Per-key IP allowlist as CIDR strings (e.g. ["10.0.0.0/8"]). `null`
   * when the key is unrestricted.
   */
  allowedCidrs: string[] | null;
  /** Server-enforced per-minute rate limit for this key. */
  rateLimitPerMinute: number;
  /** Client IP as the server observed it (first hop of X-Forwarded-For). */
  clientIp: string | null;
  /** Server-stored expiry; `null` means the key does not auto-expire. */
  expiresAt: string | null;
  /**
   * Per-key rate-limit state for this request's response, parsed from
   * `X-RateLimit-*` headers. `null` when the server didn't emit them.
   */
  rateLimit: RateLimitState | null;
}

/**
 * Result of {@link AtlaSentClient.listAuditEvents}. Extends the raw
 * wire page with a camelCase `rateLimit` alongside the snake_case
 * wire fields — the wire shape (`events`, `total`, `next_cursor`) is
 * untouched so callers that pass it to the offline verifier get
 * byte-identical behaviour.
 */
export interface AuditEventsResult extends AuditEventsPage {
  /**
   * Per-key rate-limit state for this request's response, parsed from
   * `X-RateLimit-*` headers. `null` when the server didn't emit them.
   */
  rateLimit: RateLimitState | null;
}

/**
 * Filter accepted by {@link AtlaSentClient.createAuditExport}. Fields
 * are snake_case to match the server's `POST /v1-audit/exports`
 * request body; an empty object requests a full-org bundle.
 */
export interface AuditExportRequest {
  /** Comma-joined list of event types to include (e.g. `"evaluate.allow,policy.updated"`). */
  types?: string;
  /** Filter to a single actor. */
  actor_id?: string;
  /** Inclusive lower bound on `occurred_at` (ISO 8601). */
  from?: string;
  /** Inclusive upper bound on `occurred_at` (ISO 8601). */
  to?: string;
}

/**
 * Result of {@link AtlaSentClient.createAuditExport}. Extends the
 * signed bundle shape with a camelCase `rateLimit`. The signed
 * envelope fields (`export_id`, `org_id`, `chain_head_hash`,
 * `event_count`, `signed_at`, `events`, `signature`) are preserved
 * byte-for-byte so the object can be handed straight to
 * `verifyAuditBundle(bundle, keys)`.
 */
export interface AuditExportResult extends AuditExport {
  /**
   * Per-key rate-limit state for this request's response, parsed from
   * `X-RateLimit-*` headers. `null` when the server didn't emit them.
   */
  rateLimit: RateLimitState | null;
}

/** Constructor options for {@link AtlaSentClient}. */
export interface AtlaSentClientOptions {
  /** Required. Your AtlaSent API key. */
  apiKey: string;
  /** API base URL. Defaults to "https://api.atlasent.io". */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
  /**
   * Inject a fetch implementation (primarily for testing).
   * Defaults to `globalThis.fetch`.
   */
  fetch?: typeof fetch;
  /**
   * Retry policy for transient failures (network errors, timeouts,
   * 429 rate-limit, 5xx server errors, malformed responses).
   * Omit to use the default: 4 total attempts, 2 000 ms base, 16 000 ms cap,
   * full-jitter exponential backoff matching the Python SDK schedule
   * (2 s → 4 s → 8 s → 16 s).
   * Pass `{ maxAttempts: 1 }` to disable retries entirely.
   */
  retryPolicy?: import("./retry.js").RetryPolicy;
  /**
   * Base URL for the trust-root host (default: https://keys.atlasent.io/.well-known).
   * Override for air-gapped / enterprise mirror deployments.
   * Per ADR-005 D2.
   */
  trustRootUrl?: string;
  /**
   * Trust-root snapshot refresh interval in milliseconds.
   * Default: 4 hours.  Floor: 5 minutes (ADR-005 D2).
   * Set to 0 to inherit the default.
   */
  trustSnapshotRefreshMs?: number;
}

// ── Permit lifecycle (canonical REST shapes) ──────────────────────────────────

/** Permit lifecycle status. */
export type PermitStatus =
  | "issued"
  | "verified"
  | "consumed"
  | "expired"
  | "revoked";

/**
 * Wire shape of a Permit row, returned by {@link AtlaSentClient.getPermit}
 * and {@link AtlaSentClient.listPermits}. Mirrors the openapi `Permit`
 * schema.
 *
 * Revocation fields (`revoked_at`, `revoked_by`, `revoke_reason`) are
 * populated only when `status === 'revoked'`; null otherwise.
 */
export interface PermitRecord {
  id: string;
  org_id: string;
  actor_id: string;
  action_id: string;
  target_id?: string;
  environment?: string;
  status: PermitStatus;
  issued_at: string;
  expires_at: string;
  consumed_at?: string | null;
  revoked_at?: string | null;
  revoked_by?: string | null;
  revoke_reason?: string | null;
  signature?: string;
  payload_hash?: string | null;
  decision_id?: string | null;
}

/** Optional filters for {@link AtlaSentClient.listPermits}. */
export interface ListPermitsRequest {
  status?: PermitStatus;
  actorId?: string;
  actionType?: string;
  /** ISO-8601 lower bound on `created_at`. */
  from?: string;
  /** ISO-8601 upper bound on `created_at`. */
  to?: string;
  /** Page size. Server max is 500; default 50. */
  limit?: number;
  /** Pass `nextCursor` from a prior response to page forward. */
  cursor?: string;
}

/** Response from {@link AtlaSentClient.listPermits}. */
export interface ListPermitsResponse {
  permits: PermitRecord[];
  /** Total matching rows ignoring `limit`/`cursor`. */
  total: number;
  /** Pass on next call as `cursor`. Absent when no more rows. */
  nextCursor?: string;
  rateLimit: RateLimitState | null;
}

/** Response from {@link AtlaSentClient.getPermit}. */
export interface GetPermitResponse {
  permit: PermitRecord;
  rateLimit: RateLimitState | null;
}

/**
 * Response from {@link AtlaSentClient.checkPermitValid}.
 *
 * Lightweight validity snapshot returned by
 * `GET /v1/permits/{permitId}/valid`. Designed for guard heartbeat
 * polling — returns only the fields needed to determine whether to
 * abort a running permit mid-execution (via {@link PermitRevoked}).
 */
export interface PermitValidResponse {
  /** True iff the permit is currently valid (active). */
  valid: boolean;
  /**
   * Current lifecycle status of the permit.
   * - `"active"` — permit is valid and in-flight.
   * - `"expired"` — TTL elapsed before revocation or consumption.
   * - `"revoked"` — administratively revoked (see `revocation_id`).
   * - `"consumed"` — single-use permit already consumed.
   */
  status: "active" | "expired" | "revoked" | "consumed";
  /** ISO-8601 timestamp when the permit was revoked. Populated only when `status === "revoked"`. */
  revoked_at?: string;
  /** Opaque identifier of the revocation record. Populated only when `status === "revoked"`. */
  revocation_id?: string;
}

// ── Canonical revoke / verify (REST) ──────────────────────────────────────────

/** Input for {@link AtlaSentClient.revokePermitById}. */
export interface RevokePermitByIdInput {
  /** Operator-supplied free-text reason. Recorded on the permit row,
   *  written to the audit trail, and surfaced (truncated) on later
   *  verify responses. Optional but strongly encouraged. */
  reason?: string;
}

/**
 * Response from {@link AtlaSentClient.revokePermitById}.
 *
 * Returns the updated {@link PermitRecord} with `status === 'revoked'`
 * and the populated `revoked_at` / `revoked_by` / `revoke_reason`
 * fields.
 */
export interface RevokePermitByIdResponse {
  permit: PermitRecord;
  rateLimit: RateLimitState | null;
}

/**
 * Response from {@link AtlaSentClient.verifyPermitById}.
 *
 * Returns the canonical verification envelope (`valid`,
 * `verification_type`, `reason`, `verified_at`, `evidence`) plus the
 * legacy {@link PermitRecord} fields preserved at the top level for
 * backward compatibility. The envelope shape matches the unified
 * verify response in atlasent-api PR #352.
 */
export interface VerifyPermitByIdResponse {
  /** `true` iff the permit verified — i.e. unconsumed, unexpired, and signature OK. */
  valid: boolean;
  /** Always `'permit'` on this surface. */
  verification_type: "permit";
  /** Operator-readable explanation when `valid` is `false`; `null` on success. */
  reason: string | null;
  /** Server clock at the moment verification ran. */
  verified_at: string;
  /** Type-specific evidence — same fields as the openapi PermitVerifyEvidence schema. */
  evidence: {
    permit_id: string;
    status: PermitStatus;
    actor_id?: string;
    action_id?: string;
    expires_at?: string;
    payload_hash?: string | null;
    decision_id?: string | null;
  };
  /** Legacy: full permit row preserved at the top level. */
  permit: PermitRecord;
  rateLimit: RateLimitState | null;
}

// ── Revoke permit ─────────────────────────────────────────────────────────────

/** Input for {@link AtlaSentClient.revokePermit}. */
export interface RevokePermitRequest {
  /** The permit ID returned by a prior evaluate() call. */
  permitId: string;
  /** Optional human-readable reason stored in the audit log. */
  reason?: string;
}

/**
 * Result of {@link AtlaSentClient.revokePermit}.
 *
 * @deprecated Use {@link RevokePermitByIdResponse} via
 * {@link AtlaSentClient.revokePermitById} — the canonical REST surface
 * (`POST /v1/permits/{id}/revoke`) returns the full updated
 * {@link PermitRecord} with `revoked_at`/`revoked_by`/`revoke_reason`
 * populated, instead of the legacy `{revoked, permitId}` envelope.
 * Will be removed in `@atlasent/sdk@3`.
 */
export interface RevokePermitResponse {
  /** `true` when the permit was found and successfully revoked. */
  revoked: boolean;
  /** Echo of the revoked permit's ID. */
  permitId: string;
  /** ISO-8601 timestamp of when the revocation was recorded. `undefined` when not returned by the server. */
  revokedAt?: string | undefined;
  /** Audit hash for the revocation event. `undefined` when not returned by the server. */
  auditHash?: string | undefined;
  /** Per-key rate-limit state. `null` when the server didn't emit headers. */
  rateLimit: RateLimitState | null;
}

// ── Constraint trace (preflight) ──────────────────────────────────────────────

/**
 * One stage of a single policy's constraint evaluation.
 *
 * Mirrors `ConstraintTraceStage` in
 * `atlasent-api/packages/types/src/index.ts`. Emitted by the rule
 * engine when the request URL carries `?include=constraint_trace`.
 *
 * Forward-compat: extra engine-side keys are tolerated; readers
 * should not assume this is a closed shape.
 */
export interface ConstraintTraceStage {
  /** Engine stage name (e.g. `"role_check"`, `"context"`). */
  readonly stage: string;
  /** Optional rule identifier; absent for wrapper stages. */
  readonly rule?: string;
  /** True iff this stage's predicate fired. */
  readonly matched: boolean;
  /** Optional human-readable note from the engine. */
  readonly detail?: string;
  /** Zero-based position within the policy's `stages` array. */
  readonly order: number;
  /** Forward-compat: tolerate unknown engine-side keys without crashing. */
  readonly [key: string]: unknown;
}

/**
 * Per-policy block of a constraint trace.
 *
 * Mirrors `ConstraintTracePolicy` in
 * `atlasent-api/packages/types/src/index.ts`. The handler iterates
 * active policies in order until first non-allow; the policy that
 * produced the outer decision has `decision !== "allow"`.
 */
export interface ConstraintTracePolicy {
  /** Stable identifier of the evaluated policy. */
  readonly policy_id: string;
  /** Policy-level decision (`"allow"|"deny"|"hold"|"escalate"`). */
  readonly decision: string;
  /** Engine-side fingerprint of the bundle row. */
  readonly fingerprint: string;
  /**
   * Optional engine-computed risk score from a `risk` rule clause.
   * Distinct from the heuristic risk score on the outer envelope.
   */
  readonly risk_score?: number;
  /** Ordered stages produced while evaluating this policy. */
  readonly stages: ReadonlyArray<ConstraintTraceStage>;
  /** Forward-compat: tolerate unknown engine-side keys. */
  readonly [key: string]: unknown;
}

/**
 * Top-level constraint trace returned by
 * `/v1-evaluate?include=constraint_trace`.
 *
 * Mirrors `ConstraintTraceResponse` in
 * `atlasent-api/packages/types/src/index.ts`. Present iff the
 * caller requested the trace; the SDK's preflight helper always
 * requests it.
 */
export interface ConstraintTrace {
  /** Per-policy blocks in evaluation order. */
  readonly rules_evaluated: ReadonlyArray<ConstraintTracePolicy>;
  /**
   * Policy id whose evaluation produced the outer decision. Equals
   * the outer `matched_policy_id` on non-allow paths; `undefined` on
   * a clean allow (all policies passed).
   */
  readonly matching_policy_id?: string;
  /** Forward-compat: tolerate unknown engine-side keys. */
  readonly [key: string]: unknown;
}

/**
 * Result of {@link AtlaSentClient.evaluatePreflight}.
 *
 * Wraps the regular {@link EvaluateResponse} plus the
 * {@link ConstraintTrace} returned when the request URL carries
 * `?include=constraint_trace`. The whole point of preflight is to
 * surface which stages / policies WOULD fire BEFORE pushing the
 * request onto an approval queue, so workflows can reject trivially
 * defective requests at submission time and only forward viable
 * requests to a human reviewer.
 *
 * `constraintTrace` is `null` on responses from older atlasent-api
 * deployments that do not echo the trace — forward-compatible
 * degradation.
 */
export interface EvaluatePreflightResponse {
  /** The regular evaluate response (decision, permitId, ...). */
  readonly evaluation: EvaluateResponse;
  /**
   * The constraint trace, or `null` when the server omitted it
   * (older atlasent-api version).
   */
  readonly constraintTrace: ConstraintTrace | null;
}

// ── Streaming evaluate ────────────────────────────────────────────────────────

/**
 * Options for {@link AtlaSentClient.protectStream}.
 *
 * All fields are optional; defaults are used when omitted.
 */
export interface StreamOptions {
  /**
   * Optional abort signal to cancel the stream from the caller side.
   */
  signal?: AbortSignal;
  /**
   * Per-event timeout in milliseconds: if no SSE event arrives within
   * this window the stream throws {@link StreamTimeoutError}.
   * Defaults to 30 000 ms (30 s). Pass `0` to disable.
   */
  timeoutMs?: number;
  /**
   * Maximum reconnection attempts on network drop before the stream
   * gives up and throws. Defaults to 3.
   */
  maxRetries?: number;
}

/** A policy decision emitted mid-stream. */
export interface StreamDecisionEvent {
  type: "decision";
  /**
   * Policy decision — canonical 4-value lowercase vocabulary:
   * `"allow"`, `"deny"`, `"hold"`, or `"escalate"`.
   *
   * Previously emitted `"ALLOW"` / `"DENY"` (uppercase, 2-value);
   * now unified with `decision_canonical`.
   *
   * @deprecated Read `decision_canonical` instead for forward-compatible
   * branching. Both fields now carry the same value. Will be
   * removed/changed in `@atlasent/sdk@3`.
   */
  decision: Decision;
  /**
   * Canonical 4-value decision, byte-identical to the wire.
   * One of `"allow"`, `"deny"`, `"hold"`, `"escalate"`.
   */
  decision_canonical: DecisionCanonical;
  /** Opaque permit identifier for a final allow. Pass to verifyPermit. */
  permitId: string;
  /** Human-readable explanation from the policy engine. */
  reason: string;
  /** Audit hash bound to this decision. */
  auditHash: string;
  /** ISO-8601 timestamp of the decision. */
  timestamp: string;
  /** When true the stream will emit done and close after this event. */
  isFinal: boolean;
}

/** An intermediate progress hint emitted before the final decision. */
export interface StreamProgressEvent {
  type: "progress";
  /** Human-readable stage name (e.g. "policy_loading", "context_enrichment"). */
  stage: string;
  /** Additional server-defined fields — forward-compat, do not rely on shape. */
  [key: string]: unknown;
}

/** Union of all events yielded by {@link AtlaSentClient.protectStream}. */
export type StreamEvent = StreamDecisionEvent | StreamProgressEvent;

// ── Batch evaluate ────────────────────────────────────────────────────────────

/**
 * A single item in a {@link AtlaSentClient.evaluateBatch} call.
 * Same shape as {@link EvaluateRequest}.
 */
export interface BatchEvalItem {
  /** Identifier of the calling agent. */
  agent: string;
  /** The action being authorized. */
  action: string;
  /** Arbitrary policy context. */
  context?: Record<string, unknown>;
}

/**
 * Per-item result in an {@link EvaluateBatchResponse}.
 *
 * Success items carry `decision`, `decisionId`, `permitToken`, `auditHash`,
 * and `timestamp`. Error items (when the per-item RPC layer failed) carry
 * only `index`, `error`, and optionally `message`.
 */
export interface EvaluateBatchResultItem {
  /** 0-based position matching the input order. */
  index: number;
  /**
   * Policy decision for this item. Present on success items.
   * `"allow"`, `"deny"`, `"hold"`, or `"escalate"`.
   */
  decision?: DecisionCanonical;
  /** Server-assigned permit / decision identifier. */
  decisionId?: string;
  /** Opaque permit token (allow decisions only). Pass to verifyPermit(). */
  permitToken?: string | null;
  /** Machine-readable denial / hold reason. */
  reason?: string;
  /** Hash-chained audit-trail entry. */
  auditHash?: string;
  /** ISO-8601 decision timestamp. */
  timestamp?: string;
  /** Error code when the item itself failed at the RPC layer. */
  error?: string;
  /** Human-readable detail when `error` is set. */
  message?: string;
}

/**
 * Response from {@link AtlaSentClient.evaluateBatch}.
 *
 * - `items` is in the same order as the input `requests` array.
 * - `partial: true` means at least one item errored at the RPC layer
 *   (not a policy deny — those are surfaced via `decision: "deny"` on
 *   the item). Check `item.error` on items without a `decision`.
 * - `replayed: true` means the response was served from the idempotency
 *   cache (a prior call with the same `batchId` completed within 24 h).
 */
export interface BatchEvalResponse {
  /** Server-assigned (or caller-supplied) batch identifier. */
  batchId: string;
  /** Per-item results, in input order. */
  items: EvaluateBatchResultItem[];
  /** `true` when at least one item failed at the RPC layer. */
  partial: boolean;
  /** `true` when served from the idempotency cache. */
  replayed?: boolean;
  /** Rate-limit state from the batch response headers. */
  rateLimit: RateLimitState | null;
}

// ── Decisions stream ──────────────────────────────────────────────────────────

/**
 * Options for {@link AtlaSentClient.subscribeDecisions}.
 */
export interface SubscribeDecisionsOptions {
  /**
   * Filter to specific event types (e.g. `["evaluate.allow", "evaluate.deny"]`).
   * Omit to receive all types.
   */
  types?: string[];
  /** Filter to a specific actor ID. */
  actorId?: string;
  /**
   * Resume from a prior event. Pass the `id` of the last received event.
   * The server replays everything after that sequence position, then
   * transitions to live polling.
   */
  lastEventId?: string;
  /**
   * Maximum session duration in seconds. The server emits `session_end`
   * and closes after this window; the caller should reconnect with the
   * last received `lastEventId`. Defaults to 1800 (30 min), max 3600 (1 h).
   */
  maxSeconds?: number;
  /** Abort signal to cancel the stream. */
  signal?: AbortSignal;
}

/**
 * A single event from {@link AtlaSentClient.subscribeDecisions}.
 *
 * The `type` field maps to the audit-event type emitted by the server
 * (e.g. `"evaluate.allow"`, `"evaluate.deny"`, `"permit.verified"`).
 * `"heartbeat"` is a synthetic type emitted by the SDK — not a server
 * event — indicating the server sent a keepalive ping.
 * `"session_end"` signals the server-side max-seconds limit was reached;
 * reconnect with `lastEventId` to continue.
 */
export interface DecisionStreamEvent {
  /** Stable server-assigned ID. Pass as `lastEventId` to resume. */
  id?: string;
  /**
   * Audit-event type, e.g. `"evaluate.allow"`, `"evaluate.deny"`,
   * `"evaluate.hold"`, `"permit.verified"`, `"permit.revoked"`,
   * `"heartbeat"`, `"session_end"`.
   */
  type: string;
  decision?: DecisionCanonical;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  payload?: Record<string, unknown>;
  hash?: string;
  previousHash?: string;
  occurredAt?: string;
}
