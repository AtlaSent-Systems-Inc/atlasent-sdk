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

// ── Deploy Gate V1 context types ──────────────────────────────────────────────────────

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

/**
 * Proof that a specific actor consumed a specific permit for a specific
 * action_type. Pass an array of these as `completion_proofs` on an evaluate
 * request to satisfy multi-actor quorum dependencies.
 *
 * The runtime verifies each proof via two gates (both must pass):
 * 1. A `permit_uses` row exists for `permit_id` (permit was consumed).
 * 2. An `execution_evaluations` row is bound to `actor_id` + `action_type`
 *    for the same permit (actor/action binding — Codex P1 #1148 FIX #3).
 * Proofs that fail either gate are silently dropped (fail-closed).
 */
export interface CompletionProof {
  /** The action_type (slug) that was completed by the prior actor. */
  action_type: string;
  /** The actor who completed the action. */
  actor_id: string;
  /** The permit token (or its hash) issued when the action was permitted. */
  permit_id: string;
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
  /** Deployment environment where the action executes (e.g. `"production"`). */
  environment?: string;
  /** Structured resource descriptor. Prefer over embedding resource info in `context`. */
  resource?: { type: string; id?: string; attributes?: Record<string, unknown> };
  /** Snapshot of the resource state before the proposed action. Enables state-transition-aware policy evaluation. */
  current_state?: { description: string; attributes?: Record<string, unknown> };
  /** Desired resource state after the action executes. */
  proposed_state?: { description: string; attributes?: Record<string, unknown> };
  /** Execution surface binding — identifies the CI/CD adapter, DB driver, or enforcement point. */
  execution_binding?: { kind: string; adapter_version?: string; resource_id?: string; enforcement_point?: string };
  /** The desired end-state the actor wants the resource to reach. Enables trajectory-aware authorization. */
  desired_state?: { description: string; attributes?: Record<string, unknown>; fingerprint?: string };
  /** Actor-proposed execution path from current_state to desired_state. The engine returns an authorized_trajectory that may differ. */
  proposed_trajectory?: {
    steps: Array<{
      step: string;
      description?: string;
      required: boolean;
      time_limit_seconds?: number;
      authorized_by?: string;
      constraints?: Record<string, unknown>;
    }>;
    description?: string;
  };
  /**
   * Multi-actor quorum completion proofs. Supply one entry per prior actor
   * whose completed action this evaluation depends on. The runtime verifies
   * each proof (consumed-permit gate + actor/action binding gate) and counts
   * only valid proofs toward quorum. Absent or empty → no quorum proofs
   * submitted (no behavioral change for non-quorum dependencies).
   */
  completion_proofs?: CompletionProof[];
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
  /**
   * Resolved risk class from the evaluation engine.
   * One of `"critical"`, `"high"`, `"medium"`, `"low"`.
   * Present when the risk envelope assigns a class.
   */
  riskClass?: string;
  /**
   * WHY this permit was issued — the authority kind and a reference to the
   * authorizing entity. Present on `allow` decisions when the control plane
   * attaches explicit authority provenance.
   */
  authorityBasis?: {
    kind: "policy" | "approval" | "emergency" | "maintenance_window" | "delegation" | "quorum";
    reference?: string;
    grantedBy?: string;
    rationale?: string;
    expiresAt?: string;
  };
  /**
   * ID of the HITL escalation auto-created by the control plane.
   * Present iff `decision === "hold"`. Poll `GET /v1/escalations/{id}`
   * for resolution status.
   */
  escalationId?: string;
  /**
   * Authorized execution trajectory returned when the engine approved a
   * `proposed_trajectory`. Present only on `allow` decisions.
   * May differ from what was proposed — the engine may add checkpoints,
   * restrict steps, or tighten time limits. Follow this trajectory exactly;
   * call `POST /v1/trajectory-verify` at each step to confirm on_trajectory.
   */
  authorized_trajectory?: {
    trajectory_id: string;
    steps: Array<{
      step: string;
      description?: string;
      required: boolean;
      time_limit_seconds?: number;
      authorized_by?: string;
      constraints?: Record<string, unknown>;
      expected_intermediate_state?: { description: string; attributes?: Record<string, unknown>; fingerprint?: string };
    }>;
    description?: string;
    forbidden_states?: Array<{ description: string; attributes?: Record<string, unknown>; fingerprint?: string }>;
    expires_at: string;
  };
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
 * read-only and safe to surface in operator dashboards.
 */
export interface ApiKeySelfResponse {
  /** Server-side UUID of the api_keys row for this key. */
  keyId: string;
  /** Organization the key belongs to. */
  orgId: string;
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
 * wire fields.
 */
export interface AuditEventsResult extends AuditEventsPage {
  rateLimit: RateLimitState | null;
}

/**
 * Filter accepted by {@link AtlaSentClient.createAuditExport}.
 */
export interface AuditExportRequest {
  /** Comma-joined list of event types to include. */
  types?: string;
  /** Filter to a single actor. */
  actor_id?: string;
  /** Inclusive lower bound on `occurred_at` (ISO 8601). */
  from?: string;
  /** Inclusive upper bound on `occurred_at` (ISO 8601). */
  to?: string;
}

/**
 * Result of {@link AtlaSentClient.createAuditExport}.
 */
export interface AuditExportResult extends AuditExport {
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

// ── Permit lifecycle (canonical REST shapes) ───────────────────────────────────────────

/** Permit lifecycle status. */
export type PermitStatus =
  | "issued"
  | "verified"
  | "consumed"
  | "expired"
  | "revoked";

/**
 * Wire shape of a Permit row, returned by {@link AtlaSentClient.getPermit}
 * and {@link AtlaSentClient.listPermits}.
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
  /** SHA-256 hex of the CDO that produced this permit. P1 provisional. */
  cdo_hash?: string | null;
}

/** Optional filters for {@link AtlaSentClient.listPermits}. */
export interface ListPermitsRequest {
  status?: PermitStatus;
  actorId?: string;
  actionType?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

/** Response from {@link AtlaSentClient.listPermits}. */
export interface ListPermitsResponse {
  permits: PermitRecord[];
  total: number;
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
 */
export interface PermitValidResponse {
  valid: boolean;
  status: "active" | "expired" | "revoked" | "consumed";
  revoked_at?: string;
  revocation_id?: string;
}

// ── Canonical revoke / verify (REST) ──────────────────────────────────────────────────

/** Input for {@link AtlaSentClient.revokePermitById}. */
export interface RevokePermitByIdInput {
  reason?: string;
}

/**
 * Response from {@link AtlaSentClient.revokePermitById}.
 */
export interface RevokePermitByIdResponse {
  permit: PermitRecord;
  rateLimit: RateLimitState | null;
}

/**
 * Response from {@link AtlaSentClient.verifyPermitById}.
 */
export interface VerifyPermitByIdResponse {
  valid: boolean;
  verification_type: "permit";
  reason: string | null;
  verified_at: string;
  evidence: {
    permit_id: string;
    status: PermitStatus;
    actor_id?: string;
    action_id?: string;
    expires_at?: string;
    payload_hash?: string | null;
    decision_id?: string | null;
  };
  permit: PermitRecord;
  rateLimit: RateLimitState | null;
}

// ── Revoke permit ─────────────────────────────────────────────────────────────────────────

/** Input for {@link AtlaSentClient.revokePermit}. */
export interface RevokePermitRequest {
  permitId: string;
  reason?: string;
}

/**
 * Result of {@link AtlaSentClient.revokePermit}.
 *
 * @deprecated Use {@link RevokePermitByIdResponse} via
 * {@link AtlaSentClient.revokePermitById}.
 * Will be removed in `@atlasent/sdk@3`.
 */
export interface RevokePermitResponse {
  revoked: boolean;
  permitId: string;
  revokedAt?: string | undefined;
  auditHash?: string | undefined;
  rateLimit: RateLimitState | null;
}

// ── Constraint trace (preflight) ────────────────────────────────────────────────────────

export interface ConstraintTraceStage {
  readonly stage: string;
  readonly rule?: string;
  readonly matched: boolean;
  readonly detail?: string;
  readonly order: number;
  readonly [key: string]: unknown;
}

export interface ConstraintTracePolicy {
  readonly policy_id: string;
  readonly decision: string;
  readonly fingerprint: string;
  readonly risk_score?: number;
  readonly stages: ReadonlyArray<ConstraintTraceStage>;
  readonly [key: string]: unknown;
}

export interface ConstraintTrace {
  readonly rules_evaluated: ReadonlyArray<ConstraintTracePolicy>;
  readonly matching_policy_id?: string;
  readonly [key: string]: unknown;
}

export interface EvaluatePreflightResponse {
  readonly evaluation: EvaluateResponse;
  readonly constraintTrace: ConstraintTrace | null;
}

// ── Streaming evaluate ─────────────────────────────────────────────────────────────────────

export interface StreamOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface StreamDecisionEvent {
  type: "decision";
  decision: Decision;
  decision_canonical: DecisionCanonical;
  permitId: string;
  reason: string;
  auditHash: string;
  timestamp: string;
  isFinal: boolean;
}

export interface StreamProgressEvent {
  type: "progress";
  stage: string;
  [key: string]: unknown;
}

export type StreamEvent = StreamDecisionEvent | StreamProgressEvent;

// ── Batch evaluate ────────────────────────────────────────────────────────────────────────────

export interface BatchEvalItem {
  agent: string;
  action: string;
  context?: Record<string, unknown>;
}

export interface EvaluateBatchResultItem {
  index: number;
  decision?: DecisionCanonical;
  decisionId?: string;
  permitToken?: string | null;
  reason?: string;
  auditHash?: string;
  timestamp?: string;
  error?: string;
  message?: string;
}

export interface BatchEvalResponse {
  batchId: string;
  items: EvaluateBatchResultItem[];
  partial: boolean;
  replayed?: boolean;
  rateLimit: RateLimitState | null;
}

// ── Decisions stream ──────────────────────────────────────────────────────────────────────

export interface SubscribeDecisionsOptions {
  types?: string[];
  actorId?: string;
  lastEventId?: string;
  maxSeconds?: number;
  signal?: AbortSignal;
}

export interface DecisionStreamEvent {
  id?: string;
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

// ── Trajectory authorization ────────────────────────────────────────────────────────────

/** Verified snapshot of resource state. */
export interface StateSnapshot {
  description: string;
  attributes?: Record<string, unknown>;
  /** Deterministic hash of the state (e.g. schema fingerprint, content hash). */
  fingerprint?: string;
  recorded_at?: string;
}

/** Step in an execution trajectory. */
export interface TrajectoryStep {
  step: string;
  description?: string;
  required: boolean;
  time_limit_seconds?: number;
  authorized_by?: string;
  constraints?: Record<string, unknown>;
  expected_intermediate_state?: StateSnapshot;
}

/** Actor-submitted trajectory proposal. */
export interface ProposedTrajectory {
  steps: TrajectoryStep[];
  description?: string;
}

/** Evaluation-engine-returned authorized trajectory. May differ from the proposed trajectory. */
export interface AuthorizedTrajectory extends ProposedTrajectory {
  trajectory_id: string;
  forbidden_states?: StateSnapshot[];
  expires_at: string;
}

/** Input to POST /v1/trajectory-verify. */
export interface TrajectoryVerifyRequest {
  permit_token: string;
  current_step: string;
  current_state?: StateSnapshot;
  completed_steps?: string[];
  execution_context?: Record<string, unknown>;
}

/** Response from POST /v1/trajectory-verify. */
export interface TrajectoryVerifyResponse {
  on_trajectory: boolean;
  trajectory_position?: number;
  trajectory_complete: boolean;
  deviation?: TrajectoryDeviationEvent;
  verified_at: string;
}

/** Deviation type for trajectory deviation events. */
export type TrajectoryDeviationType =
  | "step_not_on_trajectory"
  | "step_out_of_sequence"
  | "forbidden_state_reached"
  | "required_step_skipped"
  | "time_limit_exceeded"
  | "constraint_violation"
  | "trajectory_expired";

/** Emitted when execution departs from the authorized trajectory. */
export interface TrajectoryDeviationEvent {
  deviation_type: TrajectoryDeviationType;
  trajectory_id: string;
  permit_id: string;
  step?: string;
  actual_state?: StateSnapshot;
  expected_state?: StateSnapshot;
  reason: string;
  detected_at: string;
}

/** Evidence artifact: authorized trajectory vs. actual execution trace. */
export interface ComplianceComparisonArtifact {
  version: "compliance_comparison.v1";
  artifact_id: string;
  authorized_transition: {
    permit_id: string;
    desired_state: StateSnapshot;
    trajectory: AuthorizedTrajectory;
    spec_signature?: string;
  };
  execution_trace: {
    executed_steps: Array<{
      step: string;
      started_at: string;
      completed_at?: string;
      outcome: "success" | "failure" | "skipped";
      state_after?: StateSnapshot;
    }>;
    final_state: StateSnapshot;
    trace_signature?: string;
  };
  fidelity: {
    compliant: boolean;
    /** Score in [0, 1] measuring closeness of actual to authorized trajectory. */
    fidelity_score: number;
    missing_required_steps: string[];
    unexpected_steps: string[];
    forbidden_states_reached: StateSnapshot[];
    deviation_events: TrajectoryDeviationEvent[];
  };
  artifact_hash: string;
  generated_at: string;
}

// ── License verification (self-hosted / air-gapped) ───────────────────────────

/**
 * License status for a self-hosted or air-gapped AtlaSent deployment.
 *
 * Returned by `GET /v1/license`. Describes the current validity, posture,
 * features, and optional limits for the license key installed on this instance.
 *
 * Callers should check `status === "active"` before relying on `features`.
 * A `"grace"` status means the license has expired but a grace period
 * (`grace_until`) has not yet elapsed — enforcement is not yet suspended, but
 * the license should be renewed immediately.
 */
export interface LicenseStatus {
  /**
   * Current validity state of the license.
   *
   * - `"active"` — license is valid and within its expiry window.
   * - `"grace"` — license has expired; a grace period (`grace_until`) applies.
   * - `"expired"` — license has expired and the grace period has elapsed.
   * - `"revoked"` — license has been explicitly revoked by AtlaSent.
   */
  status: "active" | "grace" | "expired" | "revoked";
  /** Slug of the organization this license was issued to. */
  org_slug: string;
  /**
   * Deployment posture the license was issued for.
   *
   * - `"self_hosted"` — customer-managed deployment with network access to the
   *   AtlaSent license endpoint for periodic renewal checks.
   * - `"air_gapped"` — fully offline deployment; license verification is
   *   entirely local (signed blob checked against the embedded public key).
   */
  posture: "self_hosted" | "air_gapped";
  /** ISO 8601 timestamp when the license expires. */
  expires_at: string;
  /**
   * ISO 8601 timestamp when the grace period ends.
   * Present only when `status === "grace"`.
   */
  grace_until?: string;
  /**
   * Feature flags enabled by this license (e.g. `"governance"`, `"bvs"`,
   * `"federation"`). Check presence of a specific feature with
   * `status.features.includes("feature_name")`.
   */
  features: string[];
  /**
   * Maximum evaluations per day allowed by this license.
   * `undefined` means unlimited.
   */
  eval_limit?: number;
  /**
   * Maximum active seats (API key holders) allowed by this license.
   * `undefined` means unlimited.
   */
  seat_limit?: number;
}

/**
 * Result of submitting a license blob to `POST /v1/license/verify`.
 *
 * `valid` is the contract field — pin to it. When `valid` is `false`, the
 * `error` field carries a machine-readable reason code such as
 * `"SIGNATURE_INVALID"`, `"ORG_MISMATCH"`, `"LICENSE_EXPIRED"`, or
 * `"LICENSE_REVOKED"`.
 */
export interface LicenseVerifyResult {
  /** `true` when the submitted blob passes all verification checks. */
  valid: boolean;
  /** Slug of the organization the submitted license was issued to. Present when `valid` is `true`. */
  org_slug?: string;
  /** ISO 8601 expiry of the submitted license. Present when `valid` is `true`. */
  expires_at?: string;
  /** Machine-readable error code when `valid` is `false`. */
  error?: string;
}
