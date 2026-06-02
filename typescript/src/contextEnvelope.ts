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
