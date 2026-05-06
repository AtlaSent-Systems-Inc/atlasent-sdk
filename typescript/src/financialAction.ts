/**
 * Financial Action Model — canonical types for financial execution authority.
 *
 * Defines the core vocabulary for all financial actions governed by
 * AtlaSent's economic governance layer. Every consequential financial
 * operation must be classified here before execution authorization.
 *
 * Wire-stable as `financial_action.v1`.
 */

/** ISO 4217 currency code. */
export type CurrencyCode =
  | "USD" | "EUR" | "GBP" | "JPY" | "CAD" | "AUD" | "CHF"
  | "CNY" | "SEK" | "NZD" | string;

/**
 * Risk tier for a financial action.
 *
 * - low:      < $1,000 — single-approver sufficient
 * - medium:   $1,000–$50,000 — dual-control typically required
 * - high:     $50,000–$1,000,000 — CFO-level required
 * - critical: > $1,000,000 or irreversible — board-level or emergency protocol
 */
export type FinancialRiskTier = "low" | "medium" | "high" | "critical";

/** How accountability is distributed across parties for a financial action. */
export type LiabilityClassification =
  | "individual"          // Single party bears full liability
  | "shared"              // Multiple parties share liability proportionally
  | "delegated"           // Liability flows to the delegate, not delegator
  | "supervisory"         // Supervisors bear liability for team actions
  | "emergency_override"; // Special liability regime for emergency bypasses

/** Canonical set of financial action types. */
export type FinancialActionType =
  | "refund"
  | "payment_release"
  | "invoice_approval"
  | "payroll_execution"
  | "procurement_approval"
  | "wire_transfer"
  | "trading_execution"
  | "budget_override"
  | "spending_authorization"
  | "vendor_payment"
  | "subscription_cancellation"
  | "credit_issuance"
  | "fee_waiver"
  | "chargeback"
  | "contract_commitment"
  | string;

/**
 * Canonical definition of a financial action class.
 *
 * Stored in `financial_action_classes`. Drives quorum policy,
 * liability classification, and risk tier assignment.
 */
export interface FinancialActionClass {
  /** Stable identifier (e.g. "wire_transfer.domestic"). */
  readonly action_class_id: string;
  readonly name: string;
  readonly action_type: FinancialActionType;
  readonly risk_tier: FinancialRiskTier;
  /** Minimum number of approvals before execution is permitted. */
  readonly required_approvals: number;
  readonly liability_classification: LiabilityClassification;
  /** Whether this action is reversible post-execution. */
  readonly reversible: boolean;
  /** Maximum allowed execution value for autonomous agents (null = no ceiling). */
  readonly autonomous_ceiling: number | null;
  readonly ceiling_currency: CurrencyCode | null;
  readonly created_at: string;
  readonly description?: string;
}

/** Status of a financial execution record. */
export type FinancialExecutionStatus =
  | "pending_approval"
  | "approved"
  | "executing"
  | "completed"
  | "failed"
  | "reversed"
  | "disputed"
  | "frozen";

/**
 * Immutable record of a financial action execution.
 *
 * Written at authorization time. Stored in `financial_execution_records`.
 */
export interface FinancialExecutionRecord {
  readonly execution_id: string;
  readonly action_class_id: string;
  readonly org_id: string;
  readonly action_value: number;
  readonly currency: CurrencyCode;
  readonly risk_tier: FinancialRiskTier;
  readonly liability_classification: LiabilityClassification;
  readonly initiator_id: string;
  readonly executor_id: string;
  /** Ordered list of approver IDs. */
  readonly approver_ids: readonly string[];
  /** AtlaSent permit IDs — one per approval stage. */
  readonly permit_ids: readonly string[];
  readonly override_applied: boolean;
  readonly override_id: string | null;
  readonly status: FinancialExecutionStatus;
  readonly authorized_at: string;
  readonly executed_at: string | null;
  /** Hash-chained audit trail entry. */
  readonly audit_hash: string;
  readonly context: Record<string, unknown>;
}

/** Threshold configuration for risk-tier escalation. */
export interface RiskTierThreshold {
  readonly tier: FinancialRiskTier;
  /** Inclusive lower bound in the reference currency. */
  readonly lower_bound: number;
  /** Exclusive upper bound; null means unbounded. */
  readonly upper_bound: number | null;
  readonly reference_currency: CurrencyCode;
}

/** Default risk tier thresholds (USD-denominated). */
export const DEFAULT_RISK_TIER_THRESHOLDS: readonly RiskTierThreshold[] = [
  { tier: "low",      lower_bound: 0,           upper_bound: 1_000,       reference_currency: "USD" },
  { tier: "medium",   lower_bound: 1_000,       upper_bound: 50_000,      reference_currency: "USD" },
  { tier: "high",     lower_bound: 50_000,      upper_bound: 1_000_000,   reference_currency: "USD" },
  { tier: "critical", lower_bound: 1_000_000,   upper_bound: null,        reference_currency: "USD" },
] as const;

/**
 * Classify a financial action's risk tier based on its value.
 */
export function classifyRiskTier(
  value: number,
  thresholds: readonly RiskTierThreshold[] = DEFAULT_RISK_TIER_THRESHOLDS,
): FinancialRiskTier {
  for (const t of thresholds) {
    if (value >= t.lower_bound && (t.upper_bound === null || value < t.upper_bound)) {
      return t.tier;
    }
  }
  return "critical";
}

/**
 * Return true when the action value is within the autonomous execution ceiling.
 * A null ceiling means no ceiling is configured (always within bounds).
 */
export function withinAutonomousCeiling(
  actionValue: number,
  ceiling: number | null,
): boolean {
  if (ceiling === null) return true;
  return actionValue <= ceiling;
}
