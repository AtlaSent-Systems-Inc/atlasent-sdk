/**
 * Regulatory Escalation Chain.
 *
 * Hierarchical escalation infrastructure for routing governance issues
 * through defined authority levels. Supports multi-jurisdiction
 * regulatory chains with SLA tracking and resolution workflows.
 *
 * Wire-stable as `regulatory_escalation.v1`.
 */

/**
 * A defined level in the regulatory authority hierarchy.
 * Levels are ordered numerically — lower numbers = lower authority.
 */
export interface RegulatoryAuthorityLevel {
  id: string;
  org_id: string;
  name: string;
  level: number;
  description?: string;
  parent_level_id?: string;
  jurisdiction?: string;
  escalation_sla_hours: number;
  created_at: string;
}

/** Lifecycle status of a regulatory escalation. */
export type RegulatoryEscalationStatus =
  | "pending"
  | "acknowledged"
  | "under_review"
  | "resolved"
  | "overridden";

/** A formal escalation between two regulatory authority levels. */
export interface RegulatoryEscalation {
  id: string;
  org_id: string;
  from_level_id: string;
  to_level_id: string;
  subject_type: string;
  subject_id: string;
  reason: string;
  details: Record<string, unknown>;
  status: RegulatoryEscalationStatus;
  escalated_by: string;
  acknowledged_by?: string;
  acknowledged_at?: string;
  resolved_by?: string;
  resolved_at?: string;
  resolution?: string;
  resolution_details?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Request body for creating a new regulatory escalation. */
export interface CreateRegulatoryEscalationRequest {
  from_level_id: string;
  to_level_id: string;
  subject_type: string;
  subject_id: string;
  reason: string;
  details?: Record<string, unknown>;
}

/**
 * Returns true when a regulatory escalation is in a terminal state.
 */
export function isRegulatoryEscalationTerminal(
  status: RegulatoryEscalationStatus,
): boolean {
  return status === "resolved" || status === "overridden";
}

/**
 * Determine whether an escalation has breached its SLA.
 * Compares the SLA hours on the target authority level against the
 * elapsed time since creation.
 */
export function isEscalationSlaBreached(
  escalation: RegulatoryEscalation,
  targetLevel: RegulatoryAuthorityLevel,
  now?: Date,
): boolean {
  if (isRegulatoryEscalationTerminal(escalation.status)) return false;
  const createdMs = new Date(escalation.created_at).getTime();
  const nowMs = (now ?? new Date()).getTime();
  const elapsedHours = (nowMs - createdMs) / (1000 * 60 * 60);
  return elapsedHours > targetLevel.escalation_sla_hours;
}
