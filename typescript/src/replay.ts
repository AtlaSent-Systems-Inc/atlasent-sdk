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

/**
 * Replay variance — superset covering both the raw wire values used by
 * `replayDecision()` and the SDK-canonical values used by `replay()`.
 *
 * Raw wire values (replayDecision): NONE, DECISION_CHANGED, ENVELOPE_DRIFT
 * SDK-canonical values (replay):    NONE, POLICY_DRIFT, ENVELOPE_DRIFT,
 *                                   ENGINE_DRIFT, CHAIN_TAMPER, BUNDLE_MISSING
 */
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

// ── ADR-015 Phase C — SDK-canonical replay surface ────────────────────────────

/** Input to {@link AtlaSentClient.replay}. */
export interface ReplayRequest {
  /** The evaluation/decision ID to replay. */
  evaluationId: string;
}

import { createHash } from "node:crypto";
import type { RateLimitState } from "./types.js";
import type { DecisionCanonical } from "./types.js";

/**
 * Result of {@link AtlaSentClient.replay}.
 *
 * Uses SDK-canonical variance kinds (see {@link ReplayVarianceKind}).
 * `DECISION_CHANGED` on the wire maps to `POLICY_DRIFT` here.
 * 409 responses map to `ENGINE_DRIFT` or `BUNDLE_MISSING` and are never
 * thrown — callers can always switch on `varianceKind`.
 */
export interface ReplayResponse {
  /** The decision/evaluation ID that was replayed. */
  decisionId: string;
  /** SDK-canonical variance outcome. */
  varianceKind: ReplayVarianceKind;
  /** The original recorded decision. */
  originalDecision: DecisionCanonical;
  /** Original deny code, if any. */
  originalDenyCode?: string;
  /** Re-evaluated decision. Absent when `varianceKind === "ENVELOPE_DRIFT"`. */
  replayedDecision?: DecisionCanonical;
  replayedDenyCode?: string;
  engineVersion?: string;
  engineVersionKind?: string;
  /** Whether the evaluation was eligible for replay. `false` for 409 responses. */
  acceptsReplay: boolean;
  envelopeVerification?: string;
  /** ISO-8601 timestamp of the replay. */
  replayedAt: string;
  /** Rate-limit state from response headers. */
  rateLimit: RateLimitState | null;
}

// ── Phase 3 offline bundle verification ───────────────────────────────────────

/**
 * Result of offline evidence bundle verification via {@link verifyEvidenceBundle}.
 *
 * Named distinctly from {@link BundleVerificationResult} in `auditBundle.ts`
 * which carries chain-integrity and signature fields for audit export bundles.
 * This result covers the lighter-weight structural + hash-integrity check used
 * by the Phase 3 replay client.
 */
export interface EvidenceBundleVerifyResult {
  /** `true` when all checks passed. */
  valid: boolean;
  /** The `bundle_id` from the top-level bundle object, if present. */
  bundleId: string | undefined;
  /** The first `permit_id` found in the permits array (convenience). */
  permitId: string | undefined;
  /** Human-readable failure description; `undefined` when `valid` is `true`. */
  reason: string | undefined;
}

/**
 * Offline shape of an evidence bundle as returned by
 * `GET /v1/evidence-bundles/:id` and downloaded for replay verification.
 */
export interface OfflineEvidenceBundleData {
  bundle_id?: string;
  org_id?: string;
  status?: string;
  permits?: Array<{ permit_id?: string; evaluation_id?: string }>;
  hash_chain?: { root_hash?: string; entry_count?: number };
  [key: string]: unknown;
}

/**
 * Verify an evidence bundle offline without a backend round-trip.
 *
 * Checks:
 * 1. Bundle has required fields (`bundle_id`, `org_id`, `status`).
 * 2. `status` is `"ready"`.
 * 3. Root hash integrity if `hash_chain` is present (SHA-256 via Node crypto).
 *
 * Does **not** require `AtlaSentClient` or network access.
 *
 * @example
 * ```ts
 * import { verifyEvidenceBundle } from "@atlasent/sdk";
 *
 * const result = verifyEvidenceBundle(bundleJson);
 * if (result.valid) {
 *   console.log("verified, first permit:", result.permitId);
 * } else {
 *   console.error("verification failed:", result.reason);
 * }
 * ```
 */
export function verifyEvidenceBundle(
  bundle: OfflineEvidenceBundleData,
): EvidenceBundleVerifyResult {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    return {
      valid: false,
      bundleId: undefined,
      permitId: undefined,
      reason: "bundle must be a non-null object",
    };
  }

  for (const field of ["bundle_id", "org_id", "status"] as const) {
    if (!(field in bundle)) {
      return {
        valid: false,
        bundleId: bundle.bundle_id,
        permitId: undefined,
        reason: `missing required field: ${field}`,
      };
    }
  }

  if (bundle.status !== "ready") {
    return {
      valid: false,
      bundleId: bundle.bundle_id,
      permitId: undefined,
      reason: `bundle status is '${bundle.status}', expected 'ready'`,
    };
  }

  const permits = bundle.permits ?? [];

  if (bundle.hash_chain?.root_hash !== undefined) {
    const computed = _computeEvidenceRootHash(permits);
    if (computed !== bundle.hash_chain.root_hash) {
      return {
        valid: false,
        bundleId: bundle.bundle_id,
        permitId: undefined,
        reason: "root hash mismatch — bundle may have been tampered",
      };
    }
  }

  return {
    valid: true,
    bundleId: bundle.bundle_id,
    permitId: permits[0]?.permit_id,
    reason: undefined,
  };
}

/**
 * Compute a deterministic SHA-256 root hash over the permits list.
 * Uses `JSON.stringify` with sorted keys via a replacer for canonical form.
 *
 * @internal
 */
export function _computeEvidenceRootHash(
  permits: OfflineEvidenceBundleData["permits"],
): string {
  const list = permits ?? [];
  // Sort keys deterministically at every depth using JSON + replacer pattern
  const canonical = JSON.stringify(list, (_, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}
