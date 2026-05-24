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
  /** Cap for the current window (from `X-RateLimit-Limit`). */
  limit: number;
  /** Remaining calls in the current window. */
  remaining: number;
  /** ISO-8601 timestamp when the window resets. */
  resetAt: string;
}

/**
 * Options accepted by the {@link AtlaSentClient} constructor.
 */
export interface AtlaSentClientOptions {
  /** API key issued from the AtlaSent dashboard. */
  apiKey: string;
  /**
   * Override the default API base URL (`https://api.atlasent.io`).
   * Must use `https://` in production. Defaults to the AtlaSent
   * hosted endpoint when omitted.
   */
  baseUrl?: string;
  /**
   * Per-request network timeout in milliseconds (default 10 000).
   * Applies to every request independently; the countdown resets on
   * each retry attempt.
   */
  timeoutMs?: number;
  /**
   * Inject a custom `fetch` implementation. When omitted the SDK
   * uses `globalThis.fetch` — suitable for Node ≥ 18, browsers, and
   * Cloudflare Workers.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Retry policy override. Merged with the SDK defaults:
   * `{ maxAttempts: 3, initialDelayMs: 200, maxDelayMs: 5000, factor: 2 }`.
   */
  retryPolicy?: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    factor?: number;
  };
}

/**
 * The canonical production-deploy action string, used by
 * {@link DeployGateRequest} when `action` is omitted.
 *
 * Exported so callers can reference it without hard-coding the string.
 */
export const PRODUCTION_DEPLOY_ACTION = "production.deploy" as const;

/**
 * Input for {@link AtlaSentClient.evaluate}.
 */
export interface EvaluateRequest {
  /** Identifier for the actor initiating the action (e.g. agent or user ID). */
  agent: string;
  /** Action type string evaluated against the active policy bundle. */
  action: string;
  /** Arbitrary key/value context forwarded to the policy engine. */
  context?: Record<string, unknown>;
}

/**
 * A single item inside a batch evaluate request.
 */
export interface BatchEvalItem {
  /** Identifier for the actor initiating the action. */
  agent: string;
  /** Action type string evaluated against the active policy bundle. */
  action: string;
  /** Arbitrary key/value context forwarded to the policy engine. */
  context?: Record<string, unknown>;
}

/**
 * A single item in the batch evaluation response.
 */
export interface EvaluateBatchResultItem {
  /** Zero-based index matching the input order. */
  index: number;
  /** Policy decision for this item. */
  decision?: DecisionCanonical;
  /** Evaluation / decision ID for this item. */
  decisionId?: string;
  /** Permit token (present when `decision === "allow"`). */
  permitToken?: string | null;
  /** Human-readable denial reason (present when `decision === "deny"`). */
  reason?: string | null;
  /** Audit-chain hash for this item's entry. */
  auditHash?: string;
  /** Server-side timestamp. */
  timestamp?: string;
  /** Per-item error code when the item failed server-side validation. */
  error?: string;
  /** Per-item error message. */
  message?: string;
}

/**
 * Response from {@link AtlaSentClient.evaluateBatch}.
 */
export interface BatchEvalResponse {
  /** Batch ID assigned by the server (or echoed from the request). */
  batchId: string;
  /** Ordered result items, one per input request. */
  items: EvaluateBatchResultItem[];
  /** True when some items were dropped due to a server-side cap. */
  partial: boolean;
  /** True when the server returned a cached response (idempotency replay). */
  replayed?: boolean;
  /** Per-key rate-limit state from the response headers. */
  rateLimit: RateLimitState | null;
}

/**
 * Full permit record returned by the control-plane REST endpoints
 * (`GET /v1/permits/:id`, `POST /v1/permits/:id/revoke`, etc.).
 */
export interface PermitRecord {
  /** Unique permit identifier. */
  id: string;
  /** Status of the permit lifecycle. */
  status: "active" | "revoked" | "expired" | "consumed";
  /** Actor that triggered the permit issuance. */
  actor_id: string;
  /** Action type evaluated. */
  action_type: string;
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** ISO-8601 expiry timestamp (absent when permit has no TTL). */
  expires_at?: string;
  /** ISO-8601 revocation timestamp. */
  revoked_at?: string;
  /** Principal that revoked the permit. */
  revoked_by?: string;
  /** Human-readable revocation reason. */
  revoke_reason?: string;
  /** SHA-256 of the permit payload, used by the offline verifier. */
  payload_hash?: string;
  /** Decision ID that originated this permit. */
  decision_id?: string;
  /** Environment the permit was issued in. */
  environment?: string;
  /** Arbitrary metadata attached at issuance. */
  metadata?: Record<string, unknown>;
}

/**
 * Response from {@link AtlaSentClient.evaluate}.
 */
export interface EvaluateResponse {
  /** Policy decision. */
  decision: DecisionCanonical;
  /** Canonical lowercase decision (always present, identical to `decision`). */
  decision_canonical: DecisionCanonical;
  /** Evaluation / permit ID. Use `permitId` on new code. */
  evaluationId: string;
  /** Permit ID issued when `decision === "allow"`. */
  permitId: string;
  /**
   * Full permit record — only populated when the endpoint returns one
   * (currently always `null` for `/v1-evaluate`; present on control-plane
   * endpoints that return the full permit object).
   */
  permit: PermitRecord | null;
  /** Opaque permit token string (present when `decision === "allow"`). */
  permitToken: string | null;
  /** Denial / informational reasons. */
  reasons: string[];
  /** Primary reason string (first element of `reasons`, or `""`). */
  reason: string;
  /** SHA-256 of the audit chain entry. */
  auditHash: string;
  /** ISO-8601 server timestamp. */
  timestamp: string;
  /** Per-key rate-limit state from the response headers. */
  rateLimit: RateLimitState | null;
}

/**
 * Constraint trace returned when `?include=constraint_trace` is set.
 * Shape mirrors `ConstraintTraceResponse` in `atlasent-api`.
 */
export interface ConstraintTrace {
  /** Ordered list of policy stages that were evaluated. */
  stages: Array<{
    /** Policy stage identifier. */
    id: string;
    /** Stage outcome. */
    result: "pass" | "fail" | "skip";
    /** Human-readable label. */
    label?: string;
    /** Evaluated constraints within the stage. */
    constraints?: Array<{
      key: string;
      expected: unknown;
      actual: unknown;
      matched: boolean;
    }>;
  }>;
  /** Milliseconds the engine spent evaluating. */
  eval_ms?: number;
  /** Additional engine-side metadata. */
  [key: string]: unknown;
}

/**
 * Response from {@link AtlaSentClient.evaluatePreflight}.
 */
export interface EvaluatePreflightResponse {
  /** Full evaluate result including decision, permitId, rateLimit, etc. */
  evaluation: EvaluateResponse;
  /**
   * Per-stage policy trace. `null` on older server versions that don't
   * emit the trace even when `?include=constraint_trace` is set.
   */
  constraintTrace: ConstraintTrace | null;
}

/**
 * Input for {@link AtlaSentClient.verifyPermit}.
 *
 * @deprecated Prefer {@link AtlaSentClient.verifyPermitById}.
 */
export interface VerifyPermitRequest {
  /** Permit ID returned by a prior {@link AtlaSentClient.evaluate} call. */
  permitId: string;
  /** Agent that originally requested the permit (cross-check). */
  agent?: string;
  /** Action that was evaluated (cross-check). */
  action?: string;
  /** Context forwarded to the verify handler (not re-evaluated). */
  context?: Record<string, unknown>;
  /** Environment the permit was issued in. */
  environment?: string;
  /** Hash of the execution payload to bind the verification. */
  execution_hash?: string;
}

/**
 * Response from {@link AtlaSentClient.verifyPermit}.
 *
 * @deprecated Prefer {@link AtlaSentClient.verifyPermitById}.
 */
export interface VerifyPermitResponse {
  /** Whether the permit is currently valid. */
  verified: boolean;
  /** Canonical outcome string from the server. */
  outcome: string;
  /** SHA-256 of the permit payload at verify time. */
  permitHash: string;
  /** ISO-8601 server timestamp. */
  timestamp: string;
  /** Per-key rate-limit state from the response headers. */
  rateLimit: RateLimitState | null;
}

/**
 * Response from {@link AtlaSentClient.verifyPermitById}.
 */
export interface VerifyPermitByIdResponse {
  /** Whether the permit is valid at verification time. */
  valid: boolean;
  /** Verification type discriminator (always `"permit"` for this endpoint). */
  verification_type?: string;
  /** Human-readable denial reason when `valid === false`. */
  reason?: string;
  /** ISO-8601 timestamp when verification ran. */
  verified_at?: string;
  /**
   * Audit evidence bundle emitted by the server. Shape is server-defined
   * and may include `permit_hash`, `chain_head`, etc.
   */
  evidence?: Record<string, unknown>;
  /** Full permit record at the time of verification. */
  permit?: PermitRecord;
  /** Per-key rate-limit state from the response headers. */
  rateLimit: RateLimitState | null;
}

/**
 * Response from {@link AtlaSentClient.getPermit}.
 */
export interface GetPermitResponse {
  /** Full permit lifecycle record. */
  permit: PermitRecord;
  /** Per-key rate-limit state from the response headers. */
  rateLimit: RateLimitState | null;
}

/**
 * Input for {@link AtlaSentClient.listPermits}.
 */
export interface ListPermitsRequest {
  /** Filter by permit status. */
  status?: "active" | "revoked" | "expired" | "consumed";
  /** Filter by actor ID. */
  actorId?: string;
  /** Filter by action type. */
  actionType?: string;
  /** ISO-8601 lower bound for `created_at`. */
  from?: string;
  /** ISO-8601 upper bound for `created_at`. */
  to?: string;
  /** Maximum number of results (server default 50, cap 500). */
  limit?: number;
  /** Opaque cursor from a prior page's `nextCursor`. */
  cursor?: string;
}

/**
 * Response from {@link AtlaSentClient.listPermits}.
 */
export interface ListPermitsResponse {
  /** Permits for the current page. */
  permits: PermitRecord[];
  /** Total matching permits across all pages. */
  total: number;
  /** Opaque cursor — pass to the next call to fetch the next page. */
  nextCursor?: string;
  /** Per-key rate-limit state from the response headers. */
  rateLimit: RateLimitState | null;
}

/**
 * Lightweight validity snapshot returned by
 * {@link AtlaSentClient.checkPermitValid}.
 */
export interface PermitValidResponse {
  /** Current lifecycle status. */
  status: "active" | "revoked" | "expired" | "consumed";
  /** ISO-8601 expiry (when the permit has a TTL). */
  expires_at?: string;
  /** ISO-8601 revocation timestamp (when `status === "revoked"`). */
  revoked_at?: string;
}

/**
 * Revoke input for the deprecated {@link AtlaSentClient.revokePermit}.
 *
 * @deprecated Use {@link AtlaSentClient.revokePermitById}.
 */
export interface RevokePermitRequest {
  /** Permit ID to revoke. */
  permitId: string;
  /** Optional human-readable reason recorded in the audit log. */
  reason?: string;
}

/**
 * Response from the deprecated {@link AtlaSentClient.revokePermit}.
 *
 * @deprecated Use {@link AtlaSentClient.revokePermitById}.
 */
export interface RevokePermitResponse {
  /** Whether the revocation was accepted. */
  revoked: boolean;
  /** Permit ID that was revoked. */
  permitId: string;
  /** ISO-8601 revocation timestamp. */
  revokedAt?: string;
  /** Audit-chain hash for the revocation entry. */
  auditHash?: string;
  /** Per-key rate-limit state from the response headers. */
  rateLimit: RateLimitState | null;
}

/**
 * Input for {@link AtlaSentClient.revokePermitById}.
 */
export interface RevokePermitByIdInput {
  /** Optional human-readable reason recorded in the audit log. */
  reason?: string;
}

/**
 * Response from {@link AtlaSentClient.revokePermitById}.
 */
export interface RevokePermitByIdResponse {
  /** Full permit record post-revocation. */
  permit: PermitRecord;
  /** Per-key rate-limit state from the response headers. */
  rateLimit: RateLimitState | null;
}

/**
 * Self-describe response from `GET /v1-api-key-self`.
 */
export interface ApiKeySelfResponse {
  /** Unique key identifier (not the raw secret). */
  keyId: string;
  /** Organization this key belongs to. */
  organizationId: string;
  /** Environment the key is scoped to (e.g. `"production"`, `"staging"`). */
  environment: string;
  /** OAuth-style scopes granted to this key. */
  scopes: string[];
  /** IP CIDR allowlist (`null` means unrestricted). */
  allowedCidrs: string[] | null;
  /** Per-minute request cap configured for this key. */
  rateLimitPerMinute: number;
  /** Client IP the server observed on this request (`null` when unavailable). */
  clientIp: string | null;
  /** ISO-8601 expiry (`null` when the key has no TTL). */
  expiresAt: string | null;
  /** Per-key rate-limit state from the response headers. */
  rateLimit: RateLimitState | null;
}

/** Audit event query parameters for {@link AtlaSentClient.listAuditEvents}. */
export interface AuditEventsQuery {
  /** Comma-separated event types to filter on. */
  types?: string;
  /** Filter by actor ID. */
  actorId?: string;
  /** ISO-8601 lower bound. */
  from?: string;
  /** ISO-8601 upper bound. */
  to?: string;
  /** Maximum results (server default 50, cap 500). */
  limit?: number;
  /** Opaque cursor from the prior page. */
  cursor?: string;
}

/** Combined result from {@link AtlaSentClient.listAuditEvents}. */
export type AuditEventsResult = AuditEventsPage & {
  /** Per-key rate-limit state from the response headers. */
  rateLimit: RateLimitState | null;
};

/** Input for {@link AtlaSentClient.createAuditExport}. */
export interface AuditExportRequest {
  /** Comma-separated event types to include. */
  types?: string;
  /** ISO-8601 lower bound. */
  from?: string;
  /** ISO-8601 upper bound. */
  to?: string;
  /** Filter by actor ID. */
  actor_id?: string;
}

/** Combined result from {@link AtlaSentClient.createAuditExport}. */
export type AuditExportResult = AuditExport & {
  /** Per-key rate-limit state from the response headers. */
  rateLimit: RateLimitState | null;
};

// ── Streaming ───────────────────────────────────────────────────────────────

/** Options for {@link AtlaSentClient.protectStream}. */
export interface StreamOptions {
  /** Per-event idle timeout in milliseconds (default 30 000; 0 = disabled). */
  timeoutMs?: number;
  /** Maximum reconnection attempts on network drop (default 3). */
  maxRetries?: number;
  /** AbortSignal to cancel the stream from outside. */
  signal?: AbortSignal;
}

/** A progress update emitted by the streaming evaluation endpoint. */
export interface StreamProgressEvent {
  type: "progress";
  /** Server-assigned SSE event ID (used for reconnect). */
  id?: string;
  /** Human-readable progress message. */
  message: string;
  /** Completion percentage (0–100), when available. */
  percent?: number;
}

/** The final decision emitted by the streaming evaluation endpoint. */
export interface StreamDecisionEvent {
  type: "decision";
  /** Server-assigned SSE event ID. */
  id?: string;
  /** Policy decision. */
  decision: DecisionCanonical;
  /** True when this is the terminal event for the session. */
  isFinal: boolean;
  /** Permit ID when `decision === "allow"`. */
  permitId?: string;
  /** Human-readable denial / hold reason. */
  reason?: string;
}

/** Union of all events emitted by {@link AtlaSentClient.protectStream}. */
export type StreamEvent = StreamProgressEvent | StreamDecisionEvent;

// ── Decision-stream subscription ────────────────────────────────────────────

/** Options for {@link AtlaSentClient.subscribeDecisions}. */
export interface SubscribeDecisionsOptions {
  /** Filter to specific event types (e.g. `["evaluate.allow", "evaluate.deny"]`). */
  types?: string[];
  /** Filter to a specific actor ID. */
  actorId?: string;
  /**
   * Maximum stream duration in seconds (server enforces a hard cap;
   * omit to use the server default).
   */
  maxSeconds?: number;
  /** Reconnect from this event ID (resumes without replaying history). */
  lastEventId?: string;
  /** AbortSignal to cancel the subscription. */
  signal?: AbortSignal;
}

/** A single event from the decisions subscription stream. */
export interface DecisionStreamEvent {
  type: string;
  id?: string;
  decision?: DecisionCanonical;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  payload?: Record<string, unknown>;
  hash?: string;
  previousHash?: string;
  occurredAt?: string;
}

// ── Deploy Gate ─────────────────────────────────────────────────────────────

/** Optional evidence bundle attached to a Deploy Gate result. */
export interface DeployGateEvidence {
  permitId?: string;
  permitHash?: string;
  auditHash?: string;
  verifiedAt?: string;
}

/** Input for {@link AtlaSentClient.deployGate}. */
export interface DeployGateRequest {
  /** Agent identifier (default `"ci-deploy-bot"`). */
  agent?: string;
  /** Action to evaluate (default `"production.deploy"`). */
  action?: string;
  /** Context forwarded to the policy engine. */
  context?: Record<string, unknown>;
}

/** Response from {@link AtlaSentClient.deployGate}. */
export interface DeployGateResponse {
  /** Whether the deploy is authorized. */
  allowed: boolean;
  /** Full evaluate result. */
  evaluation: EvaluateResponse;
  /** Verification result (absent when evaluate returned non-allow). */
  verification?: VerifyPermitResponse;
  /** Human-readable summary. */
  reason: string;
  /** Evidence bundle for audit / compliance tooling. */
  evidence: DeployGateEvidence;
}

// ── Decision replay (ADR-015 §Replay, parity v2) ────────────────────────────

/**
 * Variance kind returned by {@link AtlaSentClient.replay}.
 *
 * | Value           | Meaning                                                  |
 * |-----------------|----------------------------------------------------------|
 * | `NONE`          | Replay produced the same outcome — no drift detected.    |
 * | `POLICY_DRIFT`  | Policy changed; replay outcome differs from original.    |
 * | `ENVELOPE_DRIFT`| Envelope hash mismatch; replay was not possible.         |
 * | `ENGINE_DRIFT`  | Engine version retired/unknown; replay was not possible. |
 * | `CHAIN_TAMPER`  | Audit chain tampered; replay aborted.                    |
 * | `BUNDLE_MISSING`| No policy bundle recorded; replay was not possible.      |
 */
export type ReplayVarianceKind =
  | "NONE"
  | "POLICY_DRIFT"
  | "ENVELOPE_DRIFT"
  | "ENGINE_DRIFT"
  | "CHAIN_TAMPER"
  | "BUNDLE_MISSING";

/** Input for {@link AtlaSentClient.replay}. */
export interface ReplayRequest {
  /** ID of the prior evaluation to re-evaluate. */
  evaluationId: string;
}

/** Response from {@link AtlaSentClient.replay}. */
export interface ReplayResponse {
  /** Decision ID (echoed from wire, or falls back to `evaluationId`). */
  decisionId: string;
  /** Variance classification between original and replayed decision. */
  varianceKind: ReplayVarianceKind;
  /** Decision recorded at evaluation time. */
  originalDecision: DecisionCanonical;
  /** Deny code from the original decision (when `originalDecision === "deny"`). */
  originalDenyCode?: string;
  /** Decision produced by the replay run (absent on ENVELOPE_DRIFT). */
  replayedDecision?: DecisionCanonical;
  /** Deny code from the replay run (when `replayedDecision === "deny"`). */
  replayedDenyCode?: string;
  /** Engine version identifier used for the replay. */
  engineVersion?: string;
  /** Lifecycle status of the engine version (`"active"`, `"retired"`, …). */
  engineVersionKind?: string;
  /** Whether the engine version accepts replay requests. */
  acceptsReplay: boolean;
  /** Envelope verification result (`"verified"`, `"drift"`, `"absent"`, …). */
  envelopeVerification?: string;
  /** ISO-8601 timestamp when the replay ran. */
  replayedAt: string;
  /**
   * Per-key rate-limit state from the response headers.
   * `null` when the server didn't emit them.
   */
  rateLimit: RateLimitState | null;
}