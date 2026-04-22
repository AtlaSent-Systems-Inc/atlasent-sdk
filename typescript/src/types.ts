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

/** Input to {@link AtlaSentClient.exportAudit}. All fields optional. */
export interface ExportAuditRequest {
  /** Lower bound on `generated_at` (ISO 8601). */
  since?: string;
  /** Upper bound on `generated_at` (ISO 8601). */
  until?: string;
  /** Max rows to return. Server caps at 50000. Defaults to 10000. */
  limit?: number;
  /** Include admin-log rows alongside execution rows. Defaults to `true`. */
  includeAdminLog?: boolean;
}

/** A chain tip returned inside {@link ExportAuditResponse}. */
export interface ExportAuditHead {
  id: string;
  entryHash: string;
}

/**
 * Signed, offline-verifiable envelope from
 * {@link AtlaSentClient.exportAudit}.
 *
 * The bundle is tamper-evident: every row's `entryHash` is the
 * SHA-256 of its `canonicalPayload`, rows are hash-chained, and
 * `signature` is an Ed25519 signature over
 * `canonicalize(envelope - signature)`.
 *
 * The raw wire envelope is preserved verbatim on `.raw` for callers
 * that need to pass it to an external / offline verifier untouched.
 */
export interface ExportAuditResponse {
  /** Envelope schema version. */
  version: number;
  /** Organization the export belongs to. */
  orgId: string;
  /** ISO 8601 timestamp the bundle was sealed. */
  generatedAt: string;
  /** The request's `{since, until, limit}` filter, echoed back. */
  range: { since: string | null; until: string | null; limit: number };
  /** Hash-chained execution-evaluation rows. */
  evaluations: Array<Record<string, unknown>>;
  /** Tip of the execution chain at export time. */
  executionHead: ExportAuditHead | null;
  /** Hash-chained admin-log rows, or `null` when `includeAdminLog=false`. */
  adminLog: Array<Record<string, unknown>> | null;
  /** Tip of the admin chain at export time. */
  adminHead: ExportAuditHead | null;
  /**
   * Ed25519 public key (PEM) matching `signature`. Verify this
   * against your trust anchor — do not trust it implicitly.
   */
  publicKeyPem: string;
  /** Base64 Ed25519 signature over `canonicalize(envelope - signature)`. */
  signature: string;
  /**
   * Raw wire envelope, as received from the API, snake_case keys
   * preserved. Pass this unchanged to an offline verifier.
   */
  raw: Record<string, unknown>;
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
