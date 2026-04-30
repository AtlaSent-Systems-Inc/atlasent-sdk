/**
 * Public types for the AtlaSent TypeScript SDK.
 *
 * These shapes are deliberately minimal and 1:1 with the AtlaSent
 * authorization API. Request / response fields are camelCase on the
 * SDK side; the client handles snake_case translation on the wire.
 */

import type { AuditEventsPage, AuditExport } from "./audit.js";

/** The two possible policy decisions. */
export type Decision = "ALLOW" | "DENY";

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

/** Input to {@link AtlaSentClient.evaluate}. */
export interface EvaluateRequest {
  /** Identifier of the calling agent (e.g. "clinical-data-agent"). */
  agent: string;
  /** The action being authorized (e.g. "modify_patient_record"). */
  action: string;
  /** Arbitrary policy context (user, environment, resource IDs). */
  context?: Record<string, unknown>;
}

/** Result of {@link AtlaSentClient.evaluate}. */
export interface EvaluateResponse {
  /** "ALLOW" or "DENY". A "DENY" is not thrown — branch on this field. */
  decision: Decision;
  /** Opaque permit identifier, passed to {@link AtlaSentClient.verifyPermit}. */
  permitId: string;
  /** Human-readable explanation from the policy engine. */
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
}

/** Result of {@link AtlaSentClient.verifyPermit}. */
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
}

// ── Streaming evaluate ────────────────────────────────────────────────────────

/** A policy decision emitted mid-stream. */
export interface StreamDecisionEvent {
  type: "decision";
  /** "ALLOW" or "DENY". A deny always has isFinal: true and ends the stream. */
  decision: Decision;
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
