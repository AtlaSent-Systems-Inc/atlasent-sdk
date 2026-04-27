/**
 * v2 Pillar 9 — Verifiable Proof System type definitions.
 *
 * Every interface here is a structural mirror of a schema file under
 * `contract/schemas/v2/`. Drift between schema and type is caught by
 * `test/types.test.ts`, which asserts that each required schema
 * field is present on the corresponding TypeScript surface.
 *
 * Fields are snake_case because that is what the v2 wire emits,
 * matching the v1 audit surface precedent (`typescript/src/audit.ts`).
 * SDK-side camelCase wrappers live in the eventual `@atlasent/sdk` v2
 * release; this preview package stays wire-identical so verifiers and
 * byte-level tooling (signature checks, canonical hashing) don't need
 * a translation layer.
 */

/** Policy decision values that can produce a proof. */
export type ProofDecision = "allow" | "deny" | "hold" | "escalate";

/**
 * Outcome of the callback wrapped by `protect()`. `"pending"` is
 * reserved for proofs fetched before the consume step completes
 * (async execution path).
 */
export type ProofExecutionStatus = "executed" | "failed" | "pending";

/** Outcome allowed on the consume request side — no `"pending"`. */
export type ConsumeExecutionStatus = "executed" | "failed";

/**
 * Top-level verification status. `"valid"` iff every item in
 * `checks` passed; `"incomplete"` reserved for proofs whose consume
 * step has not yet landed.
 */
export type ProofVerificationStatus = "valid" | "invalid" | "incomplete";

/**
 * Canonical check names. Order matches the signed-byte order server
 * and CLI produce. New check names are additive — older SDKs forward
 * unknowns rather than rejecting.
 */
export type ProofCheckName =
  | "signature"
  | "chain_link"
  | "payload_hash"
  | "policy_version"
  | "execution_coherence";

/**
 * Machine-readable failure reason codes. Present on a check result
 * iff `passed === false`.
 */
export type ProofFailureReason =
  | "missing_policy_version"
  | "payload_hash_mismatch"
  | "expired_permit"
  | "broken_chain"
  | "invalid_signature"
  | "retired_signing_key"
  | "execution_not_consumed";

/**
 * The canonical 18-field Verifiable Proof Object.
 *
 * Declaration order below IS the Ed25519 signed-byte order — reorder
 * at your peril. Mirrors the v1 audit-bundle envelope / `handleExport`
 * relationship.
 *
 * @see `contract/schemas/v2/proof.schema.json`
 */
export interface Proof {
  /** Server-assigned UUID for the proof. */
  proof_id: string;
  /** The permit (v1 `decision_id`) this proof binds to. */
  permit_id: string;
  /** Organization the proof belongs to. */
  org_id: string;
  /** Agent identifier as submitted on the originating evaluate call. */
  agent: string;
  /** Action as submitted on the originating evaluate call. */
  action: string;
  /** Target resource identifier. Empty string when the action has no discrete target. */
  target: string;
  /** SHA-256 hex of `canonicalizePayload(payload)`. Computed client-side; raw payload never hits the wire. */
  payload_hash: string;
  /** Opaque identifier of the policy bundle version that produced the decision. */
  policy_version: string;
  /** Policy decision that produced the permit. */
  decision: ProofDecision;
  /** Outcome of the callback the SDK wrapped. */
  execution_status: ProofExecutionStatus;
  /** Optional SHA-256 hex of execution-result metadata. `null` when the caller didn't supply one. */
  execution_hash: string | null;
  /** Audit-chain entry id — bridge between `/v2/proofs` and the v1 audit chain. */
  audit_hash: string;
  /** Prior audit-chain hash. `"0".repeat(64)` for genesis. */
  previous_hash: string;
  /** `SHA-256(previous_hash || canonicalJSON(this proof payload))`. */
  chain_hash: string;
  /** Registry id of the Ed25519 key that produced `signature`. */
  signing_key_id: string;
  /** Detached Ed25519 signature (base64url, no padding) over canonicalJSON of the 18 fields. */
  signature: string;
  /** ISO 8601 timestamp of the consume call that produced this proof. */
  issued_at: string;
  /** ISO 8601 timestamp of when the callback completed. `null` for proofs fetched before consume. */
  consumed_at: string | null;
}

/**
 * Request body for `POST /v2/permits/:id/consume`.
 *
 * @see `contract/schemas/v2/consume-request.schema.json`
 */
export interface ConsumeRequest {
  /** Decision id from the originating `/v2/evaluate` call. */
  permit_id: string;
  /** SHA-256 hex of `canonicalizePayload(payload)`. */
  payload_hash: string;
  /** Outcome of the wrapped callback. */
  execution_status: ConsumeExecutionStatus;
  /** Optional SHA-256 hex of execution-result metadata. Omit when the caller has nothing to bind. */
  execution_hash?: string;
  /** API key echoed in the body for wire parity with `/v1-evaluate`. */
  api_key: string;
}

/**
 * Response from `POST /v2/permits/:id/consume`. Kept tiny — the
 * consume endpoint is on the hot path of every `protect()` call,
 * and callers fetch the full Proof via `GET /v2/proofs/:id`.
 *
 * @see `contract/schemas/v2/consume-response.schema.json`
 */
export interface ConsumeResponse {
  /** UUID of the proof row. */
  proof_id: string;
  /** Echo of the submitted `execution_status`. */
  execution_status: ConsumeExecutionStatus;
  /** Audit-chain hash. Same meaning as `Proof.audit_hash`. */
  audit_hash: string;
}

/**
 * One per-check result in a verification response.
 *
 * @see `contract/schemas/v2/proof-verification-result.schema.json`#/$defs/ProofVerificationCheck
 */
export interface ProofVerificationCheck {
  /** Canonical check name. */
  name: ProofCheckName;
  /** True iff the check succeeded. */
  passed: boolean;
  /** Machine-readable failure reason. Required when `passed === false`. */
  reason?: ProofFailureReason;
}

/**
 * Result of `POST /v2/proofs/:id/verify`. Shared shape between the
 * online SDK path (`client.verifyProof`) and the offline
 * `npx @atlasent/verify proof.json` CLI.
 *
 * @see `contract/schemas/v2/proof-verification-result.schema.json`
 */
export interface ProofVerificationResult {
  /** Top-level status. `"valid"` iff every item in `checks` passed. */
  verification_status: ProofVerificationStatus;
  /** Echo of the proof id that was verified. */
  proof_id: string;
  /** Registry id of the key the signature verified under. Absent on signature failure. */
  signing_key_id?: string;
  /** Echo of `Proof.audit_hash`. */
  audit_hash?: string;
  /** Echo of `Proof.payload_hash`. */
  payload_hash?: string;
  /** Per-check results. */
  checks: ProofVerificationCheck[];
}

// ───────────────────────────── EvaluateBatch ─────────────────────────────

/**
 * Pillar 9 proof SLA reported on a batch evaluate item. `not_applicable`
 * means the request didn't opt in (no `payload_hash` on the inbound
 * item); `pending` means evaluate cleared but consume hasn't landed.
 */
export type BatchProofStatus = "pending" | "executed" | "failed" | "not_applicable";

/**
 * One entry in `EvaluateBatchRequest.requests`. Mirrors the v1
 * EvaluateRequest shape plus optional `payload_hash` / `target` for
 * batch items that opt into the Pillar 9 proof flow.
 *
 * @see `contract/schemas/v2/evaluate-batch-request.schema.json`
 */
export interface BatchEvaluateItem {
  /** Same semantics as `/v1-evaluate-request.action` (1..256 chars). */
  action: string;
  /** Same semantics as `/v1-evaluate-request.agent` (1..256 chars). */
  agent: string;
  /** Same semantics as `/v1-evaluate-request.context`. */
  context: Record<string, unknown>;
  /** Optional SHA-256 hex of `canonicalizePayload(payload)` — opt-in proof flow. */
  payload_hash?: string;
  /** Optional target resource identifier. Mirrors `Proof.target`. */
  target?: string;
}

/**
 * Wire payload for `POST /v2/evaluate:batch`. Order is preserved —
 * `response.items[i]` decides `requests[i]`. Caller-side ergonomic
 * helpers (omit `api_key`, accept `BatchEvaluateItem[]` directly) are
 * provided by `V2Client.evaluateBatch`; this is the raw wire shape.
 */
export interface EvaluateBatchRequest {
  /** Per-item evaluate requests. 1..1000 items. */
  requests: BatchEvaluateItem[];
  /** API key echoed in the body, same semantics as `/v1-evaluate.api_key`. */
  api_key: string;
}

/**
 * One entry in `EvaluateBatchResponse.items`. Matches the inbound
 * request at `requests[index]`. Permitted items carry the same fields
 * as v1 EvaluateResponse; denied items carry `permitted: false` plus a
 * reason.
 *
 * @see `contract/schemas/v2/evaluate-batch-response.schema.json`
 */
export interface BatchEvaluateResponseItem {
  /** Zero-based position in the inbound requests array. */
  index: number;
  /** True on allow, false on deny / hold / escalate. */
  permitted: boolean;
  /** Per-item permit id. Same semantics as v1 `EvaluateResponse.decision_id`. */
  decision_id: string;
  /** Human-readable reason. Empty string when policy has nothing to add. */
  reason: string;
  /** Per-item audit-chain hash. */
  audit_hash: string;
  /** ISO 8601 timestamp of this item's decision. */
  timestamp: string;
  /** Echo of the top-level batch_id, repeated for per-item correlation. */
  batch_id: string;
  /** Pillar 9 proof id, present iff the request carried a `payload_hash`. */
  proof_id?: string;
  /** Pillar 9 proof SLA. */
  proof_status?: BatchProofStatus;
}

/**
 * Response from `POST /v2/evaluate:batch`. `items[i]` decides
 * `requests[i]` from the inbound payload — order preservation is a
 * wire guarantee.
 */
export interface EvaluateBatchResponse {
  /** UUID identifying the batch. */
  batch_id: string;
  /** Ordered per-item decisions. */
  items: BatchEvaluateResponseItem[];
}

// ─────────────────────────── DecisionEvent (SSE) ──────────────────────────

/**
 * Discriminator for {@link DecisionEvent}. Seven event types cover the
 * full permit lifecycle. SDKs MUST forward unknown types verbatim
 * (forward-compatibility) — old clients against new servers continue
 * to receive events as opaque data rather than failing parse.
 *
 * @see `contract/schemas/v2/decision-event.schema.json`
 */
export type DecisionEventType =
  | "permit_issued"
  | "verified"
  | "consumed"
  | "revoked"
  | "escalated"
  | "hold_resolved"
  | "rate_limit_state";

/**
 * Server-sent event emitted on `GET /v2/decisions:subscribe`. Each
 * event is one JSON object on the SSE `data:` line; `id` doubles as
 * the SSE `Last-Event-ID` so clients resume cleanly after reconnect.
 *
 * Per-type payload shapes are documented in the JSON Schema `$defs`;
 * the SDK keeps `payload` typed as `Record<string, unknown>` so
 * unknown fields forward-compatibly.
 */
export interface DecisionEvent {
  /** Monotonic per-org event id. Echoes back as Last-Event-ID on reconnect. */
  id: string;
  /** Event type discriminator. Unknown types forward as opaque strings. */
  type: DecisionEventType | string;
  /** Organization the event belongs to. */
  org_id: string;
  /** ISO 8601 timestamp the event was emitted by the server. */
  emitted_at: string;
  /** Decision id; present on every type except `rate_limit_state`. */
  permit_id?: string;
  /** Actor that triggered the event. Null on system-triggered events. */
  actor_id?: string | null;
  /** Per-type payload. Unknown fields forward verbatim. */
  payload?: Record<string, unknown>;
}
