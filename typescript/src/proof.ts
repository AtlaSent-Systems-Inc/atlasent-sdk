/**
 * Proof bundle types — wire shape for `GET /v1/proof/:evaluationId`.
 *
 * The proof endpoint reconstructs an evaluation from the governance event
 * log and returns it along with the associated permits, overrides, and events
 * as a signed bundle. Consumers use this for tamper-evident audit trails.
 *
 * Mirrors `api/src/schemas/proof.ts` in atlasent-control-plane.
 */

import type { GovernanceEvent } from "./v1Types.js";
import type { PermitV1 } from "./v1Types.js";
import type { OverrideV1 } from "./overrides.js";

/**
 * Reconstructed summary of the evaluation that produced the proof.
 *
 * Drawn from the `evaluation.decided` governance event. Timestamps
 * are ISO-8601 UTC strings.
 */
export interface ProofEvaluationSummary {
  evaluationId: string;
  /** Policy decision: `"allow"` or `"deny"`. */
  decision: "allow" | "deny";
  /** Human-readable reasons emitted by the policy engine. */
  reasons: string[];
  /** The action that was evaluated. `null` when not stored on the event. */
  action: string | null;
  /** Resource type. `null` when not stored on the event. */
  resourceType: string | null;
  /** Resource identifier. `null` when not stored on the event. */
  resourceId: string | null;
  /** ISO-8601 timestamp of when the decision was made. */
  decidedAt: string;
  /** Actor who triggered the evaluation. `null` for system-initiated evaluations. */
  decidedBy: string | null;
}

/**
 * The proof payload — the data that is signed.
 *
 * Contains the reconstructed evaluation summary, the permits and overrides
 * that were active at decision time, and the full governance event trail.
 */
export interface ProofPayload {
  evaluation: ProofEvaluationSummary;
  permits: PermitV1[];
  overrides: OverrideV1[];
  events: GovernanceEvent[];
}

/**
 * Full proof bundle returned by `GET /v1/proof/:evaluationId`.
 *
 * **Signature semantics:**
 *
 * When `PROOF_SIGNING_SECRET` is configured on the server:
 * - `algorithm === "hmac-sha256"`
 * - `signature` is the hex-encoded HMAC-SHA256 over
 *   `evaluationId + "\n" + issuedAt + "\n" + JSON.stringify(payload)`
 *
 * When `PROOF_SIGNING_SECRET` is absent:
 * - `algorithm === "none"`, `signature === null`
 *
 * Consumers MUST reject proofs where `algorithm === "none"` in any
 * context where tamper-evidence is required.
 */
export interface ProofResponse {
  evaluationId: string;
  /** Signing algorithm used. `"none"` means unsigned. */
  algorithm: "none" | "hmac-sha256";
  /** Hex-encoded HMAC-SHA256 signature, or `null` when unsigned. */
  signature: string | null;
  payload: ProofPayload;
  /** ISO-8601 timestamp of when the proof was issued. */
  issuedAt: string;
}
