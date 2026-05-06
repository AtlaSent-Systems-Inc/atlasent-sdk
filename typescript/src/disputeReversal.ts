/**
 * Dispute + Reversal Workflows.
 *
 * Manages disputed financial actions, rollback workflows, frozen actions,
 * and temporary suspensions. Tracks dispute origin, remediation timeline,
 * and reversal authority.
 *
 * Wire-stable as `dispute_reversal.v1`.
 */

import type { FinancialExecutionStatus } from "./financialAction.js";

/** Who or what originated a dispute. */
export type DisputeOrigin =
  | "counterparty"      // External counterparty challenged the action
  | "regulator"         // Regulatory body flagged the action
  | "internal_audit"    // Internal audit team
  | "fraud_detection"   // Automated fraud detection
  | "approver_retract"  // An approver retracted their approval
  | "policy_violation"  // Policy violation detected post-execution
  | "agent_error";      // Autonomous agent error

/** Current state of a dispute. */
export type DisputeStatus =
  | "open"
  | "under_review"
  | "escalated"
  | "resolved_in_favor"
  | "resolved_against"
  | "reversed"
  | "withdrawn";

/** A dispute record for a financial action. */
export interface DisputeRecord {
  readonly dispute_id: string;
  readonly execution_id: string;
  readonly org_id: string;
  readonly origin: DisputeOrigin;
  readonly filed_by: string;
  readonly description: string;
  readonly status: DisputeStatus;
  readonly execution_frozen: boolean;
  readonly opened_at: string;
  readonly resolution_deadline: string | null;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
  readonly resolution_notes: string | null;
  readonly reversal_initiated: boolean;
  readonly reversal_id: string | null;
}

/** Reversal workflow stage. */
export type ReversalStage =
  | "initiated"
  | "authorization_pending"
  | "authorized"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

/** A reversal workflow for a financial execution. */
export interface ReversalWorkflow {
  readonly reversal_id: string;
  readonly execution_id: string;
  readonly dispute_id: string | null;
  readonly org_id: string;
  readonly initiated_by: string;
  readonly reason: string;
  readonly stage: ReversalStage;
  readonly authorized_by: string | null;
  readonly authorization_permit_id: string | null;
  readonly initiated_at: string;
  readonly authorized_at: string | null;
  readonly completed_at: string | null;
  readonly reversal_value: number;
  readonly partial: boolean;
}

/** Action freeze record. */
export interface ActionFreeze {
  readonly freeze_id: string;
  readonly execution_id: string;
  readonly org_id: string;
  readonly triggered_by: string;
  readonly reason: string;
  readonly triggered_at: string;
  readonly expires_at: string | null;
  readonly lifted: boolean;
  readonly lifted_at: string | null;
  readonly lifted_by: string | null;
  readonly frozen_status: FinancialExecutionStatus;
}

const VALID_DISPUTE_TRANSITIONS: Record<DisputeStatus, readonly DisputeStatus[]> = {
  open:                 ["under_review", "withdrawn"],
  under_review:         ["escalated", "resolved_in_favor", "resolved_against", "reversed"],
  escalated:            ["resolved_in_favor", "resolved_against", "reversed"],
  resolved_in_favor:    [],
  resolved_against:     [],
  reversed:             [],
  withdrawn:            [],
};

/** Validate and apply a dispute status transition. */
export function transitionDispute(
  current: DisputeStatus,
  next: DisputeStatus,
): { success: boolean; new_status: DisputeStatus | null; error: string | null } {
  const allowed = VALID_DISPUTE_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    return { success: false, new_status: null, error: `invalid dispute transition: ${current} → ${next}` };
  }
  return { success: true, new_status: next, error: null };
}

const VALID_REVERSAL_TRANSITIONS: Record<ReversalStage, readonly ReversalStage[]> = {
  initiated:             ["authorization_pending", "cancelled"],
  authorization_pending: ["authorized", "cancelled"],
  authorized:            ["executing", "cancelled"],
  executing:             ["completed", "failed"],
  completed:             [],
  failed:                ["initiated"], // Allow retry
  cancelled:             [],
};

/** Validate and apply a reversal workflow stage transition. */
export function transitionReversal(
  current: ReversalStage,
  next: ReversalStage,
): { success: boolean; error: string | null } {
  const allowed = VALID_REVERSAL_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    return { success: false, error: `invalid reversal transition: ${current} → ${next}` };
  }
  return { success: true, error: null };
}

/**
 * Return true when a freeze is currently active (not lifted and not expired).
 */
export function isFreezeActive(freeze: ActionFreeze, now?: Date): boolean {
  if (freeze.lifted) return false;
  if (freeze.expires_at !== null) {
    const nowIso = (now ?? new Date()).toISOString();
    if (nowIso >= freeze.expires_at) return false;
  }
  return true;
}

/**
 * Compute remediation urgency based on dispute deadline.
 * Returns 'overdue' when past deadline, 'urgent' within 24h, else 'normal'.
 */
export function computeRemediationUrgency(
  _openedAt: string,
  deadline: string | null,
  now?: Date,
): "normal" | "urgent" | "overdue" {
  if (deadline === null) return "normal";
  const nowMs      = (now ?? new Date()).getTime();
  const deadlineMs = new Date(deadline).getTime();
  const remaining  = deadlineMs - nowMs;
  if (remaining < 0)                       return "overdue";
  if (remaining < 24 * 60 * 60 * 1000)    return "urgent";
  return "normal";
}
