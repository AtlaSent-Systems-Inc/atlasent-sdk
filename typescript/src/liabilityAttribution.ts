/**
 * Liability Attribution Engine.
 *
 * Tracks and computes liability across the full chain of parties involved
 * in a financial action: who authorized, delegated, executed, overrode,
 * and approved exceptions.
 *
 * Supports shared, delegated, supervisory, and emergency-override liability
 * regimes. Every attribution record is immutable once written.
 *
 * Wire-stable as `liability_attribution.v1`.
 */

import type { FinancialRiskTier, LiabilityClassification } from "./financialAction.js";

/** The role a party played in a financial action. */
export type LiabilityPartyRole =
  | "authorizer"          // Granted initial authorization
  | "delegator"           // Delegated authority to another party
  | "delegate"            // Received delegated authority
  | "executor"            // Performed the actual execution
  | "approver"            // Approved at a quorum stage
  | "override_actor"      // Applied an override or exception
  | "supervisor"          // Bears supervisory liability for the action
  | "exception_approver"; // Approved a policy exception

/** A single party in the liability chain. */
export interface LiabilityParty {
  readonly party_id: string;
  readonly party_label: string;
  readonly party_type: "human" | "agent" | "system";
  readonly role: LiabilityPartyRole;
  /** Fractional liability weight (0–1); all parties in chain sum to 1. */
  readonly liability_weight: number;
  readonly acted_at: string;
  readonly permit_id: string | null;
}

/**
 * Immutable liability attribution record for a financial execution.
 *
 * Stored in `liability_attribution_records`. One record per execution.
 */
export interface LiabilityAttributionRecord {
  readonly attribution_id: string;
  readonly execution_id: string;
  readonly org_id: string;
  readonly classification: LiabilityClassification;
  readonly risk_tier: FinancialRiskTier;
  /** Ordered liability chain. First party = primary. */
  readonly liability_chain: readonly LiabilityParty[];
  readonly delegation_present: boolean;
  readonly supervisory_present: boolean;
  readonly emergency_override: boolean;
  readonly override_justification: string | null;
  readonly created_at: string;
  /** SHA-256 hash of the canonical chain for integrity verification. */
  readonly chain_hash: string;
}

/** Input required to build a liability attribution record. */
export interface LiabilityAttributionInput {
  readonly execution_id: string;
  readonly org_id: string;
  readonly classification: LiabilityClassification;
  readonly risk_tier: FinancialRiskTier;
  readonly authorizer: Omit<LiabilityParty, "role" | "liability_weight">;
  readonly executor: Omit<LiabilityParty, "role" | "liability_weight">;
  readonly approvers: readonly Omit<LiabilityParty, "role" | "liability_weight">[];
  readonly delegations?: readonly {
    readonly delegator_id: string;
    readonly delegate_id: string;
    readonly delegator_label: string;
    readonly delegate_label: string;
    readonly delegator_type: "human" | "agent" | "system";
    readonly delegate_type: "human" | "agent" | "system";
    readonly permit_id: string | null;
    readonly acted_at: string;
  }[];
  readonly supervisors?: readonly Omit<LiabilityParty, "role" | "liability_weight">[];
  readonly override?: {
    readonly actor_id: string;
    readonly actor_label: string;
    readonly actor_type: "human" | "agent" | "system";
    readonly justification: string;
    readonly permit_id: string | null;
    readonly acted_at: string;
  };
}

/** Weight distribution strategy. */
export type WeightDistribution = "equal" | "role_weighted";

/** Role weights for role_weighted distribution. */
const ROLE_WEIGHTS: Record<LiabilityPartyRole, number> = {
  authorizer:         0.30,
  delegator:          0.15,
  delegate:           0.15,
  executor:           0.25,
  approver:           0.05,
  override_actor:     0.40,
  supervisor:         0.10,
  exception_approver: 0.05,
};

/**
 * Compute liability weights for all parties in a chain.
 * Normalizes weights to sum to 1.0.
 */
export function computeLiabilityWeights(
  parties: readonly { role: LiabilityPartyRole }[],
  distribution: WeightDistribution = "role_weighted",
): number[] {
  if (parties.length === 0) return [];

  let raw: number[];
  if (distribution === "equal") {
    raw = parties.map(() => 1);
  } else {
    raw = parties.map((p) => ROLE_WEIGHTS[p.role] ?? 0.05);
  }

  const total = raw.reduce((s, w) => s + w, 0);
  if (total <= 0) return parties.map(() => 1 / parties.length);
  return raw.map((w) => w / total);
}

/**
 * Build a liability chain from attribution input.
 * Assigns roles and computes normalized weights for each party.
 */
export function buildLiabilityChain(
  input: LiabilityAttributionInput,
  distribution: WeightDistribution = "role_weighted",
): LiabilityParty[] {
  type Raw = Omit<LiabilityParty, "liability_weight">;
  const raw: Raw[] = [];

  raw.push({ ...input.authorizer, role: "authorizer" });

  for (const d of input.delegations ?? []) {
    raw.push({
      party_id:    d.delegator_id,
      party_label: d.delegator_label,
      party_type:  d.delegator_type,
      role:        "delegator",
      acted_at:    d.acted_at,
      permit_id:   d.permit_id,
    });
    raw.push({
      party_id:    d.delegate_id,
      party_label: d.delegate_label,
      party_type:  d.delegate_type,
      role:        "delegate",
      acted_at:    d.acted_at,
      permit_id:   d.permit_id,
    });
  }

  for (const a of input.approvers) {
    raw.push({ ...a, role: "approver" });
  }

  for (const s of input.supervisors ?? []) {
    raw.push({ ...s, role: "supervisor" });
  }

  raw.push({ ...input.executor, role: "executor" });

  if (input.override) {
    raw.push({
      party_id:    input.override.actor_id,
      party_label: input.override.actor_label,
      party_type:  input.override.actor_type,
      role:        "override_actor",
      acted_at:    input.override.acted_at,
      permit_id:   input.override.permit_id,
    });
  }

  const weights = computeLiabilityWeights(raw, distribution);
  return raw.map((p, i) => ({ ...p, liability_weight: weights[i] ?? 0 }));
}

/**
 * Find all parties bearing primary liability (weight >= threshold).
 * Used in dispute workflows and regulatory reporting.
 */
export function findPrimaryLiabilityParties(
  chain: readonly LiabilityParty[],
  threshold = 0.20,
): LiabilityParty[] {
  return chain.filter((p) => p.liability_weight >= threshold);
}

/** Result of validating a liability chain. */
export interface LiabilityChainValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Validate structural correctness of a liability chain:
 * - At least one party present
 * - Weights sum to ~1.0
 * - No duplicate party_id+role pairs
 * - override_actor present when hasEmergencyOverride is true
 */
export function validateLiabilityChain(
  chain: readonly LiabilityParty[],
  hasEmergencyOverride: boolean,
): LiabilityChainValidation {
  const errors: string[] = [];

  if (chain.length === 0) {
    errors.push("liability chain must have at least one party");
  }

  const weightSum = chain.reduce((s, p) => s + p.liability_weight, 0);
  if (Math.abs(weightSum - 1.0) > 0.01) {
    errors.push(`liability weights sum to ${weightSum.toFixed(4)}, expected 1.0`);
  }

  const seen = new Set<string>();
  for (const p of chain) {
    const key = `${p.party_id}:${p.role}`;
    if (seen.has(key)) errors.push(`duplicate party+role: ${key}`);
    seen.add(key);
  }

  if (hasEmergencyOverride && !chain.some((p) => p.role === "override_actor")) {
    errors.push("emergency_override is true but no override_actor in chain");
  }

  return { valid: errors.length === 0, errors };
}
