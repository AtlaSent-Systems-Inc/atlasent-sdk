/**
 * Incentive Signal Feedback Loop.
 *
 * Captures how governance actors respond to incentive alignment signals
 * and tracks outcomes. Feeds back into signal calibration and governance
 * health scoring over time.
 *
 * Wire-stable as `incentive_signal_feedback.v1`.
 */

/** The type of action taken in response to a governance signal. */
export type SignalActionType =
  | "accepted"
  | "dismissed"
  | "escalated"
  | "delegated"
  | "policy_updated"
  | "training_initiated"
  | "process_changed"
  | "monitoring_increased"
  | "auto_remediated";

/** A record of an action taken in response to a governance signal. */
export interface GovernanceSignalAction {
  id: string;
  signal_id: string;
  org_id: string;
  action_type: SignalActionType;
  action_description?: string;
  taken_by?: string;
  taken_at: string;
  outcome_score?: number;
  outcome_description?: string;
  outcome_recorded_at?: string;
  metadata: Record<string, unknown>;
}

/** Request body for recording a new signal action. */
export interface RecordSignalActionRequest {
  action_type: SignalActionType;
  action_description?: string;
  metadata?: Record<string, unknown>;
}

/** Request body for recording an outcome on a previous signal action. */
export interface RecordSignalOutcomeRequest {
  outcome_score: number;
  outcome_description?: string;
}

/** Aggregate summary of signal actions for an organization. */
export interface SignalActionSummary {
  total_signals: number;
  acted_on: number;
  dismissed: number;
  average_outcome_score: number;
  by_action_type: Record<SignalActionType, { count: number; avg_outcome: number }>;
}

/**
 * Compute a simple engagement rate from a signal action summary.
 * Returns the fraction of signals that received a non-dismissed response.
 */
export function computeSignalEngagementRate(
  summary: SignalActionSummary,
): number {
  if (summary.total_signals === 0) return 0;
  return summary.acted_on / summary.total_signals;
}

/**
 * Determine whether a signal action represents a substantive governance
 * response (i.e. more than a dismissal or auto-remediation).
 */
export function isSubstantiveSignalResponse(
  actionType: SignalActionType,
): boolean {
  return (
    actionType === "policy_updated" ||
    actionType === "training_initiated" ||
    actionType === "process_changed" ||
    actionType === "monitoring_increased" ||
    actionType === "escalated"
  );
}
