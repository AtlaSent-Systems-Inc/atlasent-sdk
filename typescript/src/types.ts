/**
 * Public types for the AtlaSent TypeScript SDK.
 *
 * These shapes are deliberately minimal and 1:1 with the AtlaSent
 * authorization API. Request / response fields are camelCase on the
 * SDK side; the client handles snake_case translation on the wire.
 */

/** The two possible policy decisions. */
export type Decision = "ALLOW" | "DENY";

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
}

/** Result bundle returned by {@link AtlaSentClient.gate}. */
export interface GateResult {
  /** The evaluate step of the gate call. */
  evaluation: EvaluateResponse;
  /** The verify step of the gate call. */
  verification: VerifyPermitResponse;
}

/** Input to {@link AtlaSentClient.authorize}. */
export interface AuthorizeRequest {
  /** Identifier of the calling agent. */
  agent: string;
  /** The action being authorized. */
  action: string;
  /** Arbitrary policy context. */
  context?: Record<string, unknown>;
  /** If `true` (default), verify the permit end-to-end. */
  verify?: boolean;
  /** If `true`, throw {@link PermissionDeniedError} on deny instead of returning `permitted: false`. */
  raiseOnDeny?: boolean;
}

/** Result of {@link AtlaSentClient.authorize}. */
export interface AuthorizationResult {
  /** `true` when the action was permitted. Fail-closed: inspect before acting. */
  permitted: boolean;
  /** Echoes the agent from the request. */
  agent: string;
  /** Echoes the action from the request. */
  action: string;
  /** Echoes the context from the request. */
  context: Record<string, unknown>;
  /** Human-readable reason from the policy engine. */
  reason: string;
  /** Permit ID (empty string if the decision was DENY and no permit was issued). */
  permitId: string;
  /** Audit-trail hash from evaluate. Empty on deny. */
  auditHash: string;
  /** Verification hash from verify. Empty when `verify: false` or on deny. */
  permitHash: string;
  /** `true` only when `verify: true` and the server confirmed the permit. */
  verified: boolean;
  /** ISO 8601 timestamp from the evaluate response. */
  timestamp: string;
}

/** Constructor options for {@link AtlaSentClient}. */
export interface AtlaSentClientOptions {
  /** Required. Your AtlaSent API key. */
  apiKey: string;
  /** API base URL. Defaults to "https://api.atlasent.io". */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
  /** Retries for transient failures (5xx, timeouts, network). Defaults to 2. */
  maxRetries?: number;
  /** Base backoff in milliseconds, doubled each retry. Defaults to 500. */
  retryBackoffMs?: number;
  /**
   * Optional in-memory cache for `evaluate()` results. Pass a
   * {@link TTLCache} instance (or any object matching its shape) to
   * deduplicate repeated decisions within a short window.
   */
  cache?: EvaluateCache;
  /**
   * Optional structured logger. Defaults to a no-op. Pass `consoleLogger`
   * (or any object matching the {@link Logger} interface) to surface
   * retries, cache hits, and deny decisions.
   */
  logger?: import("./logger.js").Logger;
  /**
   * Inject a fetch implementation (primarily for testing).
   * Defaults to `globalThis.fetch`.
   */
  fetch?: typeof fetch;
  /** Inject a sleep implementation (primarily for testing retry backoff). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Minimal interface that {@link AtlaSentClient} uses to cache
 * `evaluate()` responses. Implemented by {@link TTLCache}, but any
 * object with this shape works.
 */
export interface EvaluateCache {
  get(key: string): EvaluateResponse | undefined;
  put(key: string, value: EvaluateResponse): void;
}
