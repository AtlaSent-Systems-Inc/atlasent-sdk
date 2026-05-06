/**
 * Incentive Alignment Engine.
 *
 * Detects governance anti-patterns that indicate misaligned incentives:
 * excessive overrides, rushed approvals, emergency bypass repetition,
 * authority concentration, and governance fatigue.
 *
 * These signals are leading indicators of systemic governance failure.
 * They do not block execution but feed into risk scoring and dashboards.
 *
 * Wire-stable as `incentive_alignment.v1`.
 */

/** Categories of governance incentive signals. */
export type IncentiveSignalType =
  | "excessive_overrides"
  | "rushed_approval"
  | "emergency_bypass_repeat"
  | "authority_concentration"
  | "rubber_stamping"
  | "approval_collusion"
  | "escalation_avoidance"
  | "governance_fatigue"
  | "delegation_chain_depth"
  | "approval_velocity_spike";

/** A detected incentive alignment signal. */
export interface IncentiveSignal {
  readonly signal_id: string;
  readonly signal_type: IncentiveSignalType;
  readonly party_id: string;
  readonly party_label: string;
  /** Severity (0–100). */
  readonly severity: number;
  readonly description: string;
  readonly evidence: readonly string[];
  readonly detected_at: string;
  readonly reviewed: boolean;
  readonly reviewed_by: string | null;
}

/** Behavior pattern analysis for a governance actor. */
export interface GovernanceBehaviorPattern {
  readonly party_id: string;
  readonly party_label: string;
  readonly observation_window_days: number;
  readonly total_approvals: number;
  readonly total_overrides: number;
  readonly total_emergency_bypasses: number;
  readonly mean_approval_latency_seconds: number;
  readonly min_approval_latency_seconds: number;
  readonly approval_concentration_score: number;
  readonly delegation_depth_max: number;
  readonly signals: readonly IncentiveSignal[];
  /** 0–100; higher = healthier governance posture. */
  readonly governance_health_score: number;
}

/** Misalignment alert for operator review. */
export interface MisalignmentAlert {
  readonly alert_id: string;
  readonly org_id: string;
  readonly severity: "warn" | "critical";
  readonly alert_type: IncentiveSignalType;
  readonly affected_party_ids: readonly string[];
  readonly description: string;
  readonly recommendation: string;
  readonly signals: readonly IncentiveSignal[];
  readonly created_at: string;
  readonly resolved: boolean;
  readonly resolved_at: string | null;
}

/** Thresholds for incentive alignment detection. */
export interface IncentiveAlignmentConfig {
  readonly max_override_rate: number;
  readonly min_approval_latency_seconds: number;
  readonly max_emergency_bypasses_30d: number;
  readonly max_concentration_share: number;
  readonly max_delegation_depth: number;
}

export const DEFAULT_INCENTIVE_CONFIG: IncentiveAlignmentConfig = {
  max_override_rate:              0.05,
  min_approval_latency_seconds:   30,
  max_emergency_bypasses_30d:     3,
  max_concentration_share:        0.40,
  max_delegation_depth:           3,
};

/**
 * Analyze a governance actor's behavior to detect misaligned incentives.
 * Returns signals sorted by severity (highest first).
 */
export function detectMisalignedIncentives(params: {
  partyId: string;
  partyLabel: string;
  windowDays: number;
  totalActions: number;
  overrideCount: number;
  emergencyBypassCount: number;
  approvalLatencies: readonly number[];
  approvalShare: number;
  delegationDepthMax: number;
  config?: IncentiveAlignmentConfig;
  now?: Date;
}): IncentiveSignal[] {
  const config = params.config ?? DEFAULT_INCENTIVE_CONFIG;
  const signals: IncentiveSignal[] = [];
  const now = (params.now ?? new Date()).toISOString();
  let signalIdx = 0;
  const makeId = () => `signal_${params.partyId}_${signalIdx++}`;

  // Excessive overrides
  const overrideRate = params.totalActions > 0 ? params.overrideCount / params.totalActions : 0;
  if (overrideRate > config.max_override_rate) {
    signals.push({
      signal_id:    makeId(),
      signal_type:  "excessive_overrides",
      party_id:     params.partyId,
      party_label:  params.partyLabel,
      severity:     Math.min(100, (overrideRate / config.max_override_rate) * 50),
      description:  `Override rate ${(overrideRate * 100).toFixed(1)}% exceeds threshold ${(config.max_override_rate * 100).toFixed(1)}%`,
      evidence:     [`override_count:${params.overrideCount}`, `total_actions:${params.totalActions}`],
      detected_at:  now,
      reviewed:     false,
      reviewed_by:  null,
    });
  }

  // Emergency bypass repeat
  if (params.emergencyBypassCount > config.max_emergency_bypasses_30d) {
    signals.push({
      signal_id:    makeId(),
      signal_type:  "emergency_bypass_repeat",
      party_id:     params.partyId,
      party_label:  params.partyLabel,
      severity:     Math.min(100, (params.emergencyBypassCount / config.max_emergency_bypasses_30d) * 60),
      description:  `${params.emergencyBypassCount} emergency bypasses in ${params.windowDays}d (threshold: ${config.max_emergency_bypasses_30d})`,
      evidence:     [`bypass_count:${params.emergencyBypassCount}`],
      detected_at:  now,
      reviewed:     false,
      reviewed_by:  null,
    });
  }

  // Rushed approvals
  const rushCount = params.approvalLatencies.filter((l) => l < config.min_approval_latency_seconds).length;
  if (rushCount > 0 && params.approvalLatencies.length > 0) {
    const minLatency = Math.min(...params.approvalLatencies);
    const rushRate   = rushCount / params.approvalLatencies.length;
    signals.push({
      signal_id:    makeId(),
      signal_type:  "rushed_approval",
      party_id:     params.partyId,
      party_label:  params.partyLabel,
      severity:     Math.min(100, rushRate * 80),
      description:  `${rushCount} approvals in under ${config.min_approval_latency_seconds}s (min observed: ${minLatency.toFixed(0)}s)`,
      evidence:     [`rushed_count:${rushCount}`, `total_approvals:${params.approvalLatencies.length}`],
      detected_at:  now,
      reviewed:     false,
      reviewed_by:  null,
    });
  }

  // Authority concentration
  if (params.approvalShare > config.max_concentration_share) {
    signals.push({
      signal_id:    makeId(),
      signal_type:  "authority_concentration",
      party_id:     params.partyId,
      party_label:  params.partyLabel,
      severity:     Math.min(100, (params.approvalShare / config.max_concentration_share) * 50),
      description:  `Party controls ${(params.approvalShare * 100).toFixed(1)}% of approvals (threshold: ${(config.max_concentration_share * 100).toFixed(1)}%)`,
      evidence:     [`approval_share:${params.approvalShare.toFixed(3)}`],
      detected_at:  now,
      reviewed:     false,
      reviewed_by:  null,
    });
  }

  // Deep delegation chains
  if (params.delegationDepthMax > config.max_delegation_depth) {
    signals.push({
      signal_id:    makeId(),
      signal_type:  "delegation_chain_depth",
      party_id:     params.partyId,
      party_label:  params.partyLabel,
      severity:     Math.min(100, ((params.delegationDepthMax - config.max_delegation_depth) / config.max_delegation_depth) * 60),
      description:  `Delegation depth ${params.delegationDepthMax} exceeds threshold ${config.max_delegation_depth}`,
      evidence:     [`depth:${params.delegationDepthMax}`],
      detected_at:  now,
      reviewed:     false,
      reviewed_by:  null,
    });
  }

  return signals.sort((a, b) => b.severity - a.severity);
}

/**
 * Compute a governance health score (0–100).
 * 100 = perfect governance; 0 = extreme misalignment.
 */
export function computeGovernanceHealthScore(signals: readonly IncentiveSignal[]): number {
  if (signals.length === 0) return 100;
  const totalPenalty = signals.reduce((acc, s) => acc + s.severity * 0.5, 0);
  return Math.max(0, 100 - totalPenalty);
}
