/**
 * v2 Pillar 2 — Batch evaluation types.
 *
 * Structural mirrors of `contract/schemas/v2/evaluate-batch-request.schema.json`
 * and `contract/schemas/v2/evaluate-batch-response.schema.json`. Field
 * names stay snake_case (wire-identical) for the same reason
 * Pillar 9's `Proof` does — byte-level tooling shouldn't need a
 * translation layer. SDK-side camelCase wrappers layer on top in
 * the eventual v2 client.
 *
 * Per-item response is a discriminated union on `permitted`:
 * `permitted === true` narrows to the allow shape (with non-empty
 * `decision_id`); `permitted === false` keeps the same fields with
 * `reason` typically set to a denial explanation.
 */

/** Maximum items in a single batch — matches `evaluate-batch-request.schema.json`. */
export const EVALUATE_BATCH_MAX_ITEMS = 1000;

/** Pillar 9 proof status reported on a batch item that opted in via `payload_hash`. */
export type BatchProofStatus =
  | "pending"
  | "executed"
  | "failed"
  | "not_applicable";

/** One inbound evaluate request inside a batch. */
export interface BatchEvaluateItem {
  /** Same semantics as `/v1-evaluate-request.action`. */
  action: string;
  /** Same semantics as `/v1-evaluate-request.agent`. */
  agent: string;
  /** Same semantics as `/v1-evaluate-request.context`. */
  context: Record<string, unknown>;
  /**
   * Optional client-side payload hash. When set, the corresponding
   * response item carries `proof_id` + `proof_status` so a later
   * `consume` call can close the Pillar 9 proof loop.
   */
  payload_hash?: string;
  /** Optional target resource identifier. Mirrors `Proof.target`. */
  target?: string;
}

/** Request body for `POST /v2/evaluate:batch`. */
export interface EvaluateBatchRequest {
  requests: BatchEvaluateItem[];
  /** Echoed for wire parity with `/v1-evaluate`. Auth is via Bearer header. */
  api_key: string;
}

/**
 * Common fields every per-item response carries. Discriminator is
 * `permitted`; allow / deny narrow off it.
 */
interface BatchEvaluateResponseItemCommon {
  /** Zero-based position in the inbound `requests` array. */
  index: number;
  /** Per-item permit id. Same semantics as v1 `EvaluateResponse.decision_id`. */
  decision_id: string;
  /** Human-readable explanation. Empty string if the engine has nothing to add. */
  reason: string;
  /** Per-item audit-chain hash. Present even on deny. */
  audit_hash: string;
  /** ISO 8601 timestamp of this item's decision. */
  timestamp: string;
  /** Echo of the top-level batch_id, repeated per item for parallel post-processing. */
  batch_id: string;
  /** Pillar 9 proof id — present iff the request item carried `payload_hash`. */
  proof_id?: string;
  /** Pillar 9 proof status — present iff the request item carried `payload_hash`. */
  proof_status?: BatchProofStatus;
}

/** Per-item response when `permitted === true`. */
export interface BatchEvaluateAllowItem extends BatchEvaluateResponseItemCommon {
  permitted: true;
}

/** Per-item response when `permitted === false`. */
export interface BatchEvaluateDenyItem extends BatchEvaluateResponseItemCommon {
  permitted: false;
}

/** Discriminated union over allow / deny per-item responses. */
export type BatchEvaluateResponseItem =
  | BatchEvaluateAllowItem
  | BatchEvaluateDenyItem;

/** Response body for `POST /v2/evaluate:batch`. */
export interface EvaluateBatchResponse {
  batch_id: string;
  items: BatchEvaluateResponseItem[];
}
