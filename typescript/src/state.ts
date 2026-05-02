/**
 * Canonical cross-product behavioral state contract.
 *
 * Imported as a sub-export of @atlasent/sdk:
 *
 * ```ts
 * import type { State, StateEvent, StateSource } from "@atlasent/sdk/state";
 * ```
 *
 * Defined in `atlasent-docs/docs/STATE_CONTRACT_PROPOSAL.md` (decisions
 * confirmed 2026-05-02). Replaces the ad-hoc per-app definitions
 * previously drifting between hicoach, calm-state, behavior-insights,
 * and ledgers-me.
 *
 * - `State` is the canonical normalized cross-product model.
 * - `StateSnapshot` is the derived latest state at a point in time.
 * - `StateEvent` is what hits the wire.
 * - `StateSource` is a closed enum; new emitters require a contract change.
 */

// ──────────────────────────────────────────────────────────────────
// 1. StateSource — closed enum, one literal per emitter
// ──────────────────────────────────────────────────────────────────
export const STATE_SOURCES = [
  "hiCoach",     // bettyc925/hicoach            (consumer regulation app)
  "CalmState",   // atlasent/calm-state          (org-side regulation app)
  "Echobloom",   // bettyc925/echobloom          (observability — emits from sessions)
  "FutureBloom", // atlasent/future-bloom-planner (planner — state inferred from plan execution)
  "LedgersMe",   // bettyc925/ledgers-me         (financial outcomes inform state proxy)
  "AtlaSent",    // atlasent/atlasent-api        (control-plane derived events)
  "manual",      // operator-entered, no emitter
] as const;

export type StateSource = (typeof STATE_SOURCES)[number];

// ──────────────────────────────────────────────────────────────────
// 2. State — canonical normalized model
//    Every dimension is OPTIONAL at the type level so partial
//    observations are valid; each axis has a fixed vocabulary.
// ──────────────────────────────────────────────────────────────────

/** Canonical emotional axis. Superset of calm-state's 8 + hicoach's 5. */
export type EmotionalAxis =
  | "tense"
  | "anxious"
  | "overwhelmed"
  | "flat"
  | "frustrated"
  | "uncertain"
  | "tired"
  | "okay"
  | "open"
  | "grounded";

/** Canonical body axis. Superset of calm-state's 6 + hicoach's 4. */
export type BodyAxis =
  | "tight"
  | "heavy"
  | "restless"
  | "numb"
  | "buzzing"
  | "settled"
  | "relaxed"
  | "exhausted";

export type ReadinessLevel = "low" | "medium" | "high";

/**
 * Canonical normalized state. Every dimension is optional; emitters
 * record what they actually captured. Continuous axes are 0..1 normalized
 * — UI layers translate to/from their native scale (e.g. calm-state's
 * 0..10 sliders).
 */
export interface State {
  emotional?: EmotionalAxis;
  body?: BodyAxis;
  readiness?: ReadinessLevel;

  /** 0..1, 0=baseline, 1=overwhelming. */
  intensity?: number;
  /** 0..1. */
  stress?: number;
  /** 0..1. */
  pressure?: number;
  /** 0..1. */
  cognitive_load?: number;
  /** 0..1, self-rated certainty in the rating itself. */
  confidence?: number;
}

// ──────────────────────────────────────────────────────────────────
// 3. StateSnapshot — derived "what is the latest state right now"
//    Built by consumers from the StateEvent stream. Never emitted.
// ──────────────────────────────────────────────────────────────────
export interface StateSnapshot {
  /** UUID of the user / actor. */
  subject_id: string;
  /** Best-known current state. */
  state: State;
  /** ISO-8601 timestamp of derivation. */
  derived_at: string;
  /** StateEvent ids this snapshot folds in. */
  contributing_event_ids: string[];
  /** Age of the newest contributing event, in seconds. */
  freshness_seconds: number;
  /** 0..1, derived from contributing-event confidences. */
  confidence: number;
}

// ──────────────────────────────────────────────────────────────────
// 4. StateEvent — what hits the wire
// ──────────────────────────────────────────────────────────────────

export type StateEventKind =
  /** A single point-in-time State capture. */
  | "observation"
  /** State before/after a regulation technique, plan step, etc. */
  | "transition"
  /** An external outcome (financial, behavioral) bearing on state. */
  | "outcome";

/** Envelope shared by every StateEvent variant. */
export interface StateEventBase {
  /** UUID. Emitter-generated. Idempotent. */
  event_id: string;
  /** UUID. */
  subject_id: string;
  source: StateSource;
  kind: StateEventKind;
  /** ISO-8601. */
  emitted_at: string;

  /** 0..1. */
  confidence: number;
  /** Opaque; validated by behavior-insights. */
  consent_token?: string;
}

export interface StateObservationEvent extends StateEventBase {
  kind: "observation";
  /** Partial allowed — record what was actually captured. */
  state: State;
}

export interface StateTransitionEvent extends StateEventBase {
  kind: "transition";
  entry_state: State;
  exit_state: State;
  delta: {
    /** 0..1, magnitude of perceived improvement. */
    relief?: number;
    /** -1..1. */
    intensity_change?: number;
  };
  /** Emitter-side identifier; not constrained by this contract. */
  technique?: string;
}

/**
 * Per-source `extra` shape on outcome events. Keys must be members
 * of {@link StateSource}. Sources not present in this map carry no
 * `extra` payload. Adding a new emitter adds a new key here.
 */
export interface SourceOutcomeExtraMap {
  LedgersMe: {
    transaction_id: string;
    transaction_amount: number | null;
    transaction_currency: string | null;
    /** ISO-8601 — when the transaction cleared. */
    cleared_at: string;
  };
  AtlaSent: {
    permit_id: string;
    execution_status: string;
  };
  Echobloom: {
    session_id: string;
  };
}

/** Outcome event body, shared across sources. */
interface StateOutcomeEventBase extends StateEventBase {
  kind: "outcome";
  outcome_description: string;
  linking_mode: "manual" | "time_window";
  /** Manual mode: explicit StateEvent id to link to. */
  linked_event_id?: string;
  /** time_window mode: ISO-8601. */
  window_start?: string;
  /** time_window mode: ISO-8601. */
  window_end?: string;
}

/**
 * Outcome event. `extra` is determined by `source` via a mapped type,
 * so the two cannot disagree by construction. Sources without an
 * entry in {@link SourceOutcomeExtraMap} carry `extra?: never`.
 *
 * (An earlier draft used a self-discriminated `extra` union with its
 * own `source` field independent of the outer `source`; TypeScript
 * accepted contradictory pairs. Fixed per Codex P2 review.)
 */
export type StateOutcomeEvent = {
  [S in StateSource]: StateOutcomeEventBase & {
    source: S;
    extra?: S extends keyof SourceOutcomeExtraMap
      ? SourceOutcomeExtraMap[S]
      : never;
  };
}[StateSource];

export type StateEvent =
  | StateObservationEvent
  | StateTransitionEvent
  | StateOutcomeEvent;
