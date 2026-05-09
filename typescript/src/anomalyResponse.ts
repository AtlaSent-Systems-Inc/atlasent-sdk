/**
 * Anomaly Response Automation.
 *
 * Rules-driven automated responses to governance anomalies detected
 * during agent execution. Supports freezing agents, creating incidents,
 * notifying administrators, requiring human-in-the-loop review,
 * rolling back executions, and escalating to regulators.
 *
 * Wire-stable as `anomaly_response.v1`.
 */

/** The automated action type to take when an anomaly rule triggers. */
export type AnomalyActionType =
  | "freeze_agent"
  | "create_incident"
  | "notify_admin"
  | "require_hitl"
  | "rollback_execution"
  | "escalate_to_regulator";

/** A rule that triggers an automated response when an anomaly threshold is crossed. */
export interface AnomalyResponseRule {
  id: string;
  org_id: string;
  name: string;
  description?: string;
  anomaly_score_threshold: number;
  action_type: AnomalyActionType;
  action_config: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** A record of an anomaly response that was triggered. */
export interface AnomalyResponseEvent {
  id: string;
  rule_id: string;
  execution_id: string;
  org_id: string;
  anomaly_score: number;
  action_type: AnomalyActionType;
  action_result: Record<string, unknown>;
  triggered_at: string;
}

/** Request body for creating a new anomaly response rule. */
export interface CreateAnomalyResponseRuleRequest {
  name: string;
  description?: string;
  anomaly_score_threshold: number;
  action_type: AnomalyActionType;
  action_config?: Record<string, unknown>;
}

/** Request body for manually triggering an anomaly response check. */
export interface TriggerAnomalyResponseRequest {
  execution_id: string;
  anomaly_score: number;
  context?: Record<string, unknown>;
}

/**
 * Determine which rules from a set would trigger for a given anomaly score.
 * Returns only active rules whose threshold is met or exceeded.
 */
export function matchAnomalyRules(
  rules: readonly AnomalyResponseRule[],
  anomalyScore: number,
): AnomalyResponseRule[] {
  return rules
    .filter((r) => r.is_active && anomalyScore >= r.anomaly_score_threshold)
    .sort((a, b) => b.anomaly_score_threshold - a.anomaly_score_threshold);
}

/**
 * Determine the most severe action type from a set of triggered rules.
 * Severity order (highest first):
 *   escalate_to_regulator > rollback_execution > freeze_agent >
 *   require_hitl > create_incident > notify_admin
 */
export function highestSeverityAction(
  rules: readonly AnomalyResponseRule[],
): AnomalyActionType | null {
  const ORDER: AnomalyActionType[] = [
    "escalate_to_regulator",
    "rollback_execution",
    "freeze_agent",
    "require_hitl",
    "create_incident",
    "notify_admin",
  ];
  for (const action of ORDER) {
    if (rules.some((r) => r.action_type === action)) return action;
  }
  return null;
}
