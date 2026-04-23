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

// ── Streaming evaluate ────────────────────────────────────────────────────

/** Discriminant for {@link EvaluateStreamEvent}. */
export type StreamEventType = "reasoning" | "policy_check" | "decision" | "error";

/**
 * A single event yielded by {@link AtlaSentClient.evaluateStream}.
 *
 * Events arrive in order:
 *   - Zero or more `"reasoning"` events (policy engine thinking).
 *   - Zero or more `"policy_check"` events (per-policy verdicts).
 *   - Exactly one `"decision"` event — always the last in the stream.
 *   - `"error"` if the server aborts abnormally.
 *
 * Branch on `type` to read the relevant fields.
 */
export interface EvaluateStreamEvent {
  type: StreamEventType;
  /** Populated on `"reasoning"` and `"error"` events. */
  content?: string;
  /** Populated on `"policy_check"` events. */
  policyId?: string;
  /** Populated on `"policy_check"` events. */
  outcome?: string;
  /** `true` / `false` on the final `"decision"` event. */
  permitted?: boolean;
  /** Opaque permit ID on the final `"decision"` event. */
  permitId?: string;
  /** Human-readable reason on `"decision"` and `"policy_check"` events. */
  reason?: string;
  /** Audit-trail hash on the final `"decision"` event. */
  auditHash?: string;
  /** ISO 8601 timestamp on the final `"decision"` event. */
  timestamp?: string;
}

// ── Offline audit verifier ────────────────────────────────────────────────

/** A single event record inside an audit export bundle. */
export interface AuditEvent {
  eventId: string;
  action: string;
  actorId: string;
  timestamp: string;
  decisionId: string;
  permitted: boolean;
  auditHash: string;
}

/**
 * Result of {@link verifyBundle}.
 *
 * Check `valid` to determine whether the bundle is intact.
 */
export interface BundleVerifyResult {
  /** `true` if the Ed25519 signature over the events is valid. */
  valid: boolean;
  /** Number of audit events in the bundle. */
  eventCount: number;
  /** Hex-encoded 32-byte Ed25519 public key from the bundle header. */
  publicKey: string;
  /** Non-empty when `valid` is `false` and a diagnostic is available. */
  error: string;
}
