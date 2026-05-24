/**
 * Wire types for `POST /v1-decisions-replay/:id/replay`.
 *
 * Re-evaluates a recorded decision against its originally-pinned policy
 * bundle and engine version, then reports whether the result agrees with
 * what was recorded. Side-effect-free: no audit chain row is written and
 * no permit is issued (see ADR-016).
 *
 * Mirrors `_handleReplayPost` in atlasent-api's
 * `supabase/functions/v1-decisions-replay/handler.ts`. Variance kinds and
 * envelope-verification states are pinned to the API contract — keep this
 * file aligned with `_shared/decision-replay.ts` if the surface evolves.
 *
 * Per AtlaSent's versioning doctrine `/v1/decisions/:id/replay` is an
 * **alpha** endpoint; shapes can change without a deprecation cycle until
 * it graduates to stable v1 (see atlasent-api `docs/STABLE_V2_PROMOTION.md`).
 */

import type { DecisionCanonical, RateLimitState } from "./types.js";

/** Replay variance per ADR-015 §3. Aligned with the recorded `variance`
 * field in the replay response.
 *
 * Superset that covers the `replayDecision()` wire contract (NONE,
 * DECISION_CHANGED, ENVELOPE_DRIFT) and the `replay()` SDK-canonical
 * mapping (adds POLICY_DRIFT, ENGINE_DRIFT, CHAIN_TAMPER, BUNDLE_MISSING). */
export type ReplayVarianceKind =
  | "NONE"
  | "DECISION_CHANGED"
  | "POLICY_DRIFT"
  | "ENVELOPE_DRIFT"
  | "ENGINE_DRIFT"
  | "CHAIN_TAMPER"
  | "BUNDLE_MISSING";

/** Engine-version registry classification (ADR-017). `unknown` covers
 * NULL engine_version (pre-replay-era rows) and registry-misses. */
export type EngineVersionKind =
  | "active"
  | "retired"
  | "archival"
  | "unknown";

/** Envelope hash verification outcome for the recorded request envelope.
 * `verified` = recomputed hash matched; `drift` = mismatch; `envelope_missing`
 * = recorded hash points at a content_envelopes row that no longer exists;
 * `absent` = the original evaluation predates envelope_hash capture. */
export type EnvelopeVerification =
  | "verified"
  | "drift"
  | "absent"
  | "envelope_missing";

/** Mirror of `decision` enum on the original evaluation. */
export type ReplayDecisionValue = "allow" | "deny" | "hold" | "escalate";

/** Envelope-drift diagnostic. Present only when `variance === "ENVELOPE_DRIFT"`. */
export interface EnvelopeDriftDetail {
  recorded_hash: string;
  recomputed_hash: string;
}

/**
 * Successful POST /v1-decisions-replay/:id/replay response. The shape is
 * additive — additional fields may appear in future API versions.
 */
export interface ReplayDecisionResponse {
  decision_id: string;
  /** What the original decision was at evaluate time. */
  original_decision: ReplayDecisionValue;
  /** Recorded deny code from the original decision, if any. */
  original_deny_code?: string;
  /** Re-evaluated decision. Absent when replay short-circuits on
   * ENVELOPE_DRIFT — in that case the original decision is the only
   * authoritative value and no replay was run. */
  replay_decision?: ReplayDecisionValue;
  replay_deny_code?: string;
  /** Engine version string recorded with the original decision, or
   * `undefined` for pre-replay-era rows. */
  engine_version?: string;
  engine_version_kind: EngineVersionKind;
  /** Always `true` on a 200 — the handler refuses replay (409) when the
   * engine version does not accept replay. */
  accepts_replay: boolean;
  variance: ReplayVarianceKind;
  envelope_verification: EnvelopeVerification;
  envelope_drift_detail?: EnvelopeDriftDetail;
  replayed_at: string;
}

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
