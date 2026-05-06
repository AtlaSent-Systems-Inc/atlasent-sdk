/**
 * Financial Control Dashboard — types for governance visualization.
 *
 * Covers approval concentration analysis, override analytics, budget drift,
 * economic risk timelines, and liability visualization.
 *
 * These are pure data types; rendering is left to UI consumers.
 *
 * Wire-stable as `financial_dashboard.v1`.
 */

import type { FinancialRiskTier } from "./financialAction.js";
import type { ApprovalConcentrationAnalysis, BudgetaryDriftAnalysis, FinancialRiskScore } from "./economicRisk.js";
import type { MisalignmentAlert } from "./incentiveAlignment.js";
import type { LiabilityParty } from "./liabilityAttribution.js";
import type { DisputeRecord, ReversalWorkflow } from "./disputeReversal.js";

/** Top-level financial governance summary for a dashboard view. */
export interface FinancialGovernanceSummary {
  readonly org_id: string;
  readonly generated_at: string;
  readonly window_days: number;
  readonly current_risk_score: FinancialRiskScore;
  readonly total_actions: number;
  readonly total_value: number;
  readonly override_count: number;
  readonly emergency_bypass_count: number;
  readonly active_dispute_count: number;
  readonly pending_reversal_count: number;
  readonly active_freeze_count: number;
  readonly budget_warning_count: number;
  readonly budget_critical_count: number;
  readonly concentration_analysis: ApprovalConcentrationAnalysis;
  readonly budget_drift: readonly BudgetaryDriftAnalysis[];
  readonly misalignment_alerts: readonly MisalignmentAlert[];
  readonly risk_timeline: readonly RiskTimelinePoint[];
}

/** A single point on the economic risk timeline. */
export interface RiskTimelinePoint {
  readonly date: string;
  readonly risk_score: number;
  readonly risk_tier: FinancialRiskTier;
  readonly action_count: number;
  readonly total_value: number;
  readonly override_count: number;
  readonly anomaly_count: number;
}

/** Override analytics for operator review. */
export interface OverrideAnalytics {
  readonly org_id: string;
  readonly window_days: number;
  readonly total_overrides: number;
  readonly override_rate: number;
  readonly overrides_by_actor: readonly ActorOverrideStat[];
  readonly overrides_by_action_type: readonly ActionTypeOverrideStat[];
  readonly override_value_total: number;
  readonly repeat_override_actors: readonly string[];
  readonly emergency_override_count: number;
  readonly computed_at: string;
}

export interface ActorOverrideStat {
  readonly actor_id: string;
  readonly actor_label: string;
  readonly override_count: number;
  readonly override_value_total: number;
  readonly last_override_at: string;
}

export interface ActionTypeOverrideStat {
  readonly action_type: string;
  readonly override_count: number;
  readonly total_value: number;
}

/** Liability visualization data for graph/chart rendering. */
export interface LiabilityVisualization {
  readonly execution_id: string;
  readonly org_id: string;
  readonly nodes: readonly LiabilityNode[];
  readonly edges: readonly LiabilityEdge[];
  readonly total_weight: number;
}

export interface LiabilityNode {
  readonly id: string;
  readonly label: string;
  readonly party_type: "human" | "agent" | "system";
  readonly role: string;
  readonly liability_weight: number;
  readonly acted_at: string;
}

export interface LiabilityEdge {
  readonly from_id: string;
  readonly to_id: string;
  readonly relationship: "authorized" | "delegated_to" | "approved_for" | "supervised" | "overrode";
  readonly weight: number;
}

/** Active disputes and reversals dashboard summary. */
export interface DisputeReversalSummary {
  readonly org_id: string;
  readonly active_disputes: readonly DisputeRecord[];
  readonly pending_reversals: readonly ReversalWorkflow[];
  readonly resolved_last_30d: number;
  readonly average_resolution_days: number;
  readonly overdue_disputes: readonly DisputeRecord[];
  readonly total_disputed_value: number;
  readonly total_reversed_value: number;
  readonly generated_at: string;
}

/**
 * Build a liability visualization graph from a liability chain.
 */
export function buildLiabilityVisualization(
  executionId: string,
  orgId: string,
  chain: readonly LiabilityParty[],
): LiabilityVisualization {
  const nodes: LiabilityNode[] = chain.map((p) => ({
    id:               p.party_id,
    label:            p.party_label,
    party_type:       p.party_type,
    role:             p.role,
    liability_weight: p.liability_weight,
    acted_at:         p.acted_at,
  }));

  const edges: LiabilityEdge[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const from = chain[i]!;
    const to   = chain[i + 1]!;
    let relationship: LiabilityEdge["relationship"] = "authorized";
    if      (from.role === "delegator" && to.role === "delegate") relationship = "delegated_to";
    else if (from.role === "supervisor")                          relationship = "supervised";
    else if (to.role   === "approver")                            relationship = "approved_for";
    else if (to.role   === "override_actor")                      relationship = "overrode";
    edges.push({
      from_id:      from.party_id,
      to_id:        to.party_id,
      relationship,
      weight:       Math.min(from.liability_weight, to.liability_weight),
    });
  }

  return {
    execution_id: executionId,
    org_id:       orgId,
    nodes,
    edges,
    total_weight: chain.reduce((s, p) => s + p.liability_weight, 0),
  };
}

/**
 * Build a risk timeline from daily snapshot data.
 */
export function buildRiskTimeline(
  snapshots: readonly {
    date: string;
    riskScore: number;
    actionCount: number;
    totalValue: number;
    overrideCount: number;
    anomalyCount: number;
  }[],
): RiskTimelinePoint[] {
  return snapshots.map((s) => {
    let tier: FinancialRiskTier = "low";
    if      (s.riskScore > 80) tier = "critical";
    else if (s.riskScore > 55) tier = "high";
    else if (s.riskScore > 25) tier = "medium";
    return {
      date:           s.date,
      risk_score:     s.riskScore,
      risk_tier:      tier,
      action_count:   s.actionCount,
      total_value:    s.totalValue,
      override_count: s.overrideCount,
      anomaly_count:  s.anomalyCount,
    };
  });
}
