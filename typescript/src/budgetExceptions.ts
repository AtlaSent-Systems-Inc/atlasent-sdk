/**
 * Budget Exception Workflows.
 *
 * Structured request-and-approval process for temporary exceptions
 * to budget policy limits. Supports creation, review, approval,
 * rejection, and cancellation lifecycles with full audit trails.
 *
 * Wire-stable as `budget_exceptions.v1`.
 */

/** Lifecycle status of a budget exception request. */
export type BudgetExceptionStatus =
  | "pending"
  | "under_review"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

/** A formal request for a temporary exception to a budget policy limit. */
export interface BudgetExceptionRequest {
  id: string;
  org_id: string;
  budget_policy_id?: string;
  requested_by: string;
  amount_requested: number;
  currency: string;
  reason: string;
  justification?: string;
  business_impact?: string;
  status: BudgetExceptionStatus;
  reviewed_by?: string;
  reviewed_at?: string;
  review_notes?: string;
  effective_from?: string;
  effective_until?: string;
  approved_amount?: number;
  conditions: string[];
  created_at: string;
  updated_at: string;
}

/** Request body for creating a new budget exception request. */
export interface CreateBudgetExceptionRequest {
  budget_policy_id?: string;
  amount_requested: number;
  currency?: string;
  reason: string;
  justification?: string;
  business_impact?: string;
  effective_from?: string;
  effective_until?: string;
}

/** Request body for approving a budget exception. */
export interface ApproveBudgetExceptionRequest {
  review_notes?: string;
  approved_amount: number;
  conditions?: string[];
  effective_from?: string;
  effective_until?: string;
}

/**
 * Returns true when an approved exception is currently in effect.
 * An exception is in effect when:
 *   - status is "approved"
 *   - current time is within [effective_from, effective_until]
 */
export function isBudgetExceptionActive(
  exception: BudgetExceptionRequest,
  now?: Date,
): boolean {
  if (exception.status !== "approved") return false;
  const ts = (now ?? new Date()).toISOString();
  if (exception.effective_from && ts < exception.effective_from) return false;
  if (exception.effective_until && ts > exception.effective_until) return false;
  return true;
}

/**
 * Returns true when a budget exception request is in a terminal state
 * (no further transitions are possible).
 */
export function isBudgetExceptionTerminal(
  status: BudgetExceptionStatus,
): boolean {
  return status === "approved" || status === "rejected" || status === "expired" || status === "cancelled";
}
