/**
 * Financial Governance Client Types.
 *
 * Wire surface:
 *   - `v1-financial-governance` edge function: `list_action_classes`,
 *     `update_ceiling`, `list_executions`, `freeze_execution`,
 *     `reverse_execution`, `list_incentive_signals`, `get_health_score`.
 *   - `v1-liability-attribution` edge function: `list`,
 *     `get_by_execution`, `generate_evidence_bundle`.
 *
 * This module defines the **client-facing** request/response types for
 * the console-side edge functions.  Pure advisory helpers (local
 * computation, no network) live in the existing `autonomousFinancial.ts`,
 * `incentiveAlignment.ts`, and `liabilityAttribution.ts` modules.
 *
 * Wire-stable as `financial_governance_client.v1`.
 */

import type { CurrencyCode, FinancialActionType, FinancialRiskTier } from "./financialAction.js";
import type { IncentiveSignal } from "./incentiveAlignment.js";

// ── Action Classes ──────────────────────────────────────────────────────────

/**
 * Server-persisted action class configuration.
 * Returned by `list_action_classes`.
 */
export interface FinancialActionClassRecord {
  readonly class_id: string;
  readonly org_id: string;
  readonly action_type: FinancialActionType;
  /** Human-readable description of the action class. */
  readonly label: string;
  readonly risk_tier: FinancialRiskTier;
  /** Per-execution ceiling amount in `ceiling_currency`. */
  readonly per_execution_ceiling: number;
  readonly ceiling_currency: CurrencyCode;
  /** Daily aggregate ceiling (null = unlimited). */
  readonly daily_aggregate_ceiling: number | null;
  /** Whether this action type requires a permit for autonomous execution. */
  readonly require_permit: boolean;
  readonly updated_at: string;
  readonly updated_by: string;
}

/** Response for `list_action_classes`. */
export interface ListActionClassesResponse {
  readonly classes: readonly FinancialActionClassRecord[];
  readonly total: number;
}

/** Request body for `update_ceiling`. */
export interface UpdateCeilingRequest {
  readonly action_type: FinancialActionType;
  readonly per_execution_ceiling: number;
  readonly ceiling_currency: CurrencyCode;
  readonly daily_aggregate_ceiling?: number | null;
  readonly require_permit?: boolean;
  readonly updated_by: string;
}

/** Response for `update_ceiling`. */
export interface UpdateCeilingResponse {
  readonly class: FinancialActionClassRecord;
}

// ── Executions ──────────────────────────────────────────────────────────────

/** Status of a financial execution record. */
export type FinancialExecutionStatus =
  | "pending"
  | "executed"
  | "frozen"
  | "reversed"
  | "failed";

/** A persisted financial execution record. */
export interface FinancialExecutionRecord {
  readonly execution_id: string;
  readonly org_id: string;
  readonly agent_id: string;
  readonly action_type: FinancialActionType;
  readonly action_value: number;
  readonly currency: CurrencyCode;
  readonly risk_tier: FinancialRiskTier;
  readonly status: FinancialExecutionStatus;
  readonly permit_id: string | null;
  readonly anomaly_detected: boolean;
  readonly anomaly_description: string | null;
  readonly frozen_at: string | null;
  readonly frozen_by: string | null;
  readonly freeze_reason: string | null;
  readonly reversed_at: string | null;
  readonly reversed_by: string | null;
  readonly reversal_reason: string | null;
  readonly executed_at: string | null;
  readonly created_at: string;
}

/** Response for `list_executions`. */
export interface ListExecutionsResponse {
  readonly executions: readonly FinancialExecutionRecord[];
  readonly total: number;
  readonly next_cursor?: string;
}

/** Query parameters for listing executions. */
export interface ListExecutionsQuery {
  readonly agent_id?: string;
  readonly action_type?: FinancialActionType;
  readonly status?: FinancialExecutionStatus;
  readonly risk_tier?: FinancialRiskTier;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Request body for `freeze_execution`. */
export interface FreezeExecutionRequest {
  readonly frozen_by: string;
  readonly freeze_reason: string;
}

/** Response for `freeze_execution`. */
export interface FreezeExecutionResponse {
  readonly execution: FinancialExecutionRecord;
}

/** Request body for `reverse_execution`. */
export interface ReverseExecutionRequest {
  readonly reversed_by: string;
  readonly reversal_reason: string;
}

/** Response for `reverse_execution`. */
export interface ReverseExecutionResponse {
  readonly execution: FinancialExecutionRecord;
}

// ── Incentive Signals ───────────────────────────────────────────────────────

/** Response for `list_incentive_signals`. */
export interface ListIncentiveSignalsResponse {
  readonly signals: readonly IncentiveSignal[];
  readonly total: number;
  readonly next_cursor?: string;
}

/** Query parameters for listing incentive signals. */
export interface ListIncentiveSignalsQuery {
  readonly party_id?: string;
  readonly reviewed?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Response for `get_health_score`. */
export interface GovernanceHealthScoreResponse {
  readonly org_id: string;
  /** 0–100; higher = healthier governance posture. */
  readonly health_score: number;
  /** Number of unreviewed signals contributing to the score. */
  readonly open_signal_count: number;
  readonly computed_at: string;
}

// ── Liability Attribution (v1-liability-attribution) ────────────────────────

/**
 * Server-persisted liability attribution record.
 * Returned by `list` and `get_by_execution`.
 */
export interface LiabilityAttributionServerRecord {
  readonly attribution_id: string;
  readonly execution_id: string;
  readonly org_id: string;
  readonly classification: string;
  readonly risk_tier: FinancialRiskTier;
  readonly liability_chain: readonly LiabilityPartyWire[];
  readonly delegation_present: boolean;
  readonly supervisory_present: boolean;
  readonly emergency_override: boolean;
  readonly override_justification: string | null;
  readonly chain_hash: string;
  readonly created_at: string;
}

/** Wire shape of a single party in a liability chain. */
export interface LiabilityPartyWire {
  readonly party_id: string;
  readonly party_label: string;
  readonly party_type: "human" | "agent" | "system";
  readonly role: string;
  readonly liability_weight: number;
  readonly acted_at: string;
  readonly permit_id: string | null;
}

/** Response for `list` (liability attribution). */
export interface ListLiabilityRecordsResponse {
  readonly records: readonly LiabilityAttributionServerRecord[];
  readonly total: number;
  readonly next_cursor?: string;
}

/** Query parameters for listing liability records. */
export interface ListLiabilityRecordsQuery {
  readonly risk_tier?: FinancialRiskTier;
  readonly emergency_override?: boolean;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Response for `get_by_execution`. */
export interface GetLiabilityByExecutionResponse {
  readonly record: LiabilityAttributionServerRecord;
}

/**
 * A self-contained evidence bundle for a liability attribution record.
 * Returned by `generate_evidence_bundle`.
 */
export interface LiabilityEvidenceBundle {
  readonly bundle_id: string;
  readonly attribution_id: string;
  readonly execution_id: string;
  readonly org_id: string;
  /** Canonical JSON of the liability chain (deterministic field order). */
  readonly canonical_chain_json: string;
  /** SHA-256 over `canonical_chain_json`. Matches `chain_hash` on the record. */
  readonly chain_hash: string;
  /** Detached Ed25519 signature (base64url) over canonical bytes. */
  readonly signature: string;
  readonly signing_key_id: string | null;
  readonly generated_at: string;
}

/** Response for `generate_evidence_bundle`. */
export interface GenerateLiabilityEvidenceBundleResponse {
  readonly bundle: LiabilityEvidenceBundle;
}
