/**
 * Context Envelope types — structured input set for execution-time
 * authorization decisions.
 *
 * These types mirror the `context_envelopes` + `context_signals` +
 * `context_namespace_registry` DB schema introduced in migration
 * `20260522070000_context_envelope_v1.sql`.
 *
 * A V1 envelope has a fixed top-level keyset (the canonical namespace
 * catalog). The recorder validates incoming envelopes against this catalog
 * and rejects unknown top-level keys in strict mode (V2+).
 */

/** Canonical V1 envelope top-level namespace keys. */
export const CONTEXT_NAMESPACES = [
  "intent",
  "actor",
  "resource",
  "environment",
  "history",
  "evidence_refs",
  "signals",
  "compatibility_overrides",
] as const;

export type ContextNamespaceKey = (typeof CONTEXT_NAMESPACES)[number];

/** One row from `context_namespace_registry`. */
export interface ContextNamespaceEntry {
  namespace: ContextNamespaceKey;
  purpose: string;
  owner: string;
  /** `true` for the `signals` namespace — derived / inferred inputs. */
  is_signal: boolean;
  introduced_in_version: string;
}

/** One signal attached to a context envelope. */
export interface ContextSignal {
  /** Dotted path under the `signals` namespace (e.g. `"signals.actor_anomaly"`). */
  namespace: string;
  /** Named source that produced this signal. */
  source: string;
  /** Confidence in [0.0, 1.0]. `null` when not reported. */
  confidence: number | null;
  /** Arbitrary signal payload. */
  payload: Record<string, unknown>;
  /** ISO-8601 timestamp when the signal was produced. */
  produced_at: string;
  /** Seconds until the signal is considered stale. `null` = no expiry. */
  ttl_seconds: number | null;
}

/** Trust tiers for a resource classification assertion. Absent ⇒ `caller_asserted`. */
export const RESOURCE_ASSERTION_TRUST_LEVELS = [
  "caller_asserted",
  "partner_attested",
  "verified",
] as const;

export type ResourceAssertionTrust = (typeof RESOURCE_ASSERTION_TRUST_LEVELS)[number];

/**
 * A trusted, provenance-bearing classification assertion about a resource —
 * the unit AtlaSent *consumes* from an external data-security classifier
 * (e.g. Inspect Data); it does not produce classifications itself (ADR-041).
 *
 * Attach under the `resource` namespace of a context envelope. Only
 * `classification` and `source` are required. Policy MUST NOT treat an
 * assertion as fact without checking `trust` / freshness. Mirrors the contract
 * `ResourceClassificationAssertion` and the Python SDK.
 *
 * ```ts
 * const resource = {
 *   kind: "customer_record",
 *   ref: "crm:account:A_1",
 *   classification: ["confidential", "pii"],
 *   assertions: [
 *     { classification: "phi", source: "partner:inspect-data",
 *       trust: "partner_attested", confidence: 0.98 },
 *   ],
 * };
 * ```
 */
export interface ResourceClassificationAssertion {
  /** What is asserted about the resource, e.g. "phi", "pci". */
  classification: string;
  /** Who asserted it — a stable producer id/URN, e.g. "partner:inspect-data". */
  source: string;
  /** Trust tier. Absent ⇒ `caller_asserted`. */
  trust?: ResourceAssertionTrust;
  /** Producer-reported confidence in [0, 1]. */
  confidence?: number;
  /** ISO-8601 UTC when the assertion was produced. */
  asserted_at?: string;
  /** ISO-8601 UTC after which the assertion is stale. */
  valid_until?: string;
  /** Stable id of the assertion in the producer's system, for audit linkage. */
  assertion_id?: string;
  /** Optional `sha256:<hex>` binding the assertion content for tamper-evidence. */
  content_hash?: string;
}

const RESOURCE_ASSERTION_SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/;

// Full ISO-8601 UTC/offset timestamp: date + time(seconds) + optional fraction
// + `Z` or `±HH:MM`. Matches the Python check so both accept the same set.
const RESOURCE_ASSERTION_ISO8601_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isResourceAssertionIso8601(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const m = RESOURCE_ASSERTION_ISO8601_RE.exec(value);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  // Reject impossible calendar dates (e.g. 2026-02-30, which `Date.parse` would
  // silently normalize to March). Build a UTC date from the wall-clock parts and
  // require it to round-trip unchanged.
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day &&
    dt.getUTCHours() === hour &&
    dt.getUTCMinutes() === minute &&
    dt.getUTCSeconds() === second
  );
}

/**
 * Validate a resource classification assertion. Returns a list of problems;
 * an empty list means well-formed. Mirrors the contract / Python validators so
 * all three agree on "well-formed". Only `classification` + `source` required.
 */
export function validateResourceClassificationAssertion(input: unknown): string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return ["assertion must be a non-null object"];
  }
  const a = input as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof a.classification !== "string" || a.classification.length === 0) {
    problems.push("classification is required and must be a non-empty string");
  }
  if (typeof a.source !== "string" || a.source.length === 0) {
    problems.push("source is required and must be a non-empty string");
  }
  if (
    a.trust !== undefined &&
    !(RESOURCE_ASSERTION_TRUST_LEVELS as readonly string[]).includes(a.trust as string)
  ) {
    problems.push(
      `trust, when present, must be one of ${RESOURCE_ASSERTION_TRUST_LEVELS.join(", ")}`,
    );
  }
  if (
    a.confidence !== undefined &&
    (typeof a.confidence !== "number" ||
      !Number.isFinite(a.confidence) ||
      a.confidence < 0 ||
      a.confidence > 1)
  ) {
    problems.push("confidence, when present, must be a number in [0, 1]");
  }
  if (a.asserted_at !== undefined && !isResourceAssertionIso8601(a.asserted_at)) {
    problems.push("asserted_at, when present, must be an ISO-8601 timestamp");
  }
  if (a.valid_until !== undefined && !isResourceAssertionIso8601(a.valid_until)) {
    problems.push("valid_until, when present, must be an ISO-8601 timestamp");
  }
  if (a.assertion_id !== undefined && (typeof a.assertion_id !== "string" || a.assertion_id.length === 0)) {
    problems.push("assertion_id, when present, must be a non-empty string");
  }
  if (
    a.content_hash !== undefined &&
    (typeof a.content_hash !== "string" || !RESOURCE_ASSERTION_SHA256_PREFIXED.test(a.content_hash))
  ) {
    problems.push("content_hash, when present, must match sha256:<64 hex chars>");
  }
  return problems;
}

/** Type guard: true when `input` is a well-formed ResourceClassificationAssertion. */
export function isResourceClassificationAssertion(
  input: unknown,
): input is ResourceClassificationAssertion {
  return validateResourceClassificationAssertion(input).length === 0;
}

/**
 * A canonical V1 context envelope — the deterministic input set that
 * powers execution-time authorization decisions.
 *
 * Envelopes are append-only and hash-committed: `envelope_hash` is
 * SHA-256 of the canonical JSON form. The permit issued by the evaluator
 * commits to this hash so the audit chain, the permit, and a verifier all
 * agree on what was evaluated.
 *
 * ```ts
 * import type { ContextEnvelope } from "@atlasent/sdk";
 *
 * const envelope: ContextEnvelope = {
 *   request_id: "req_abc123",
 *   org_id: "org_xyz",
 *   envelope_version: "atlasent.v1",
 *   protected_action: "production.deploy",
 *   envelope: {
 *     intent: { action: "deploy", summary: "Release v1.2.0" },
 *     actor: { id: "agent:deploy-bot", roles: ["deploy"] },
 *     environment: { name: "production", freeze_window: false },
 *   },
 *   envelope_hash: "a3f...",
 *   evidence_refs: [],
 *   recorded_by: "v1-evaluate",
 *   received_at: "2026-06-02T00:00:00Z",
 *   signals: [],
 * };
 * ```
 */
export interface ContextEnvelope {
  /** Caller-supplied idempotency / correlation key. */
  request_id: string;
  org_id: string;
  envelope_version: "atlasent.v1";
  /** The namespaced action type this envelope covers. */
  protected_action: string;
  /**
   * The full validated envelope payload. Top-level keys must be in
   * {@link CONTEXT_NAMESPACES}. Unknown keys are warn-only in V1.
   */
  envelope: Partial<Record<ContextNamespaceKey, unknown>>;
  /**
   * SHA-256 hex of `canonical-JSON(envelope)`. Three points of truth
   * (permit, audit chain, verifier) reduce to this single hash.
   */
  envelope_hash: string;
  /** UUIDs of governance evidence rows referenced by this envelope. */
  evidence_refs: string[];
  /** Which handler wrote this row (e.g. `"v1-evaluate"`). */
  recorded_by: string;
  /** ISO-8601 timestamp. */
  received_at: string;
  /** Signals attached to this envelope. */
  signals: ContextSignal[];
}

/**
 * Minimal input shape for recording a context envelope via
 * `context_record_envelope()`. The hash is computed by the caller
 * before submitting.
 */
export interface RecordContextEnvelopeInput {
  request_id: string;
  org_id: string;
  envelope_version: "atlasent.v1";
  protected_action: string;
  envelope: Partial<Record<ContextNamespaceKey, unknown>>;
  envelope_hash: string;
  evidence_refs?: string[];
  recorded_by?: string;
  signals?: Omit<ContextSignal, never>[];
}
