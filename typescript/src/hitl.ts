/**
 * Human-in-the-loop (HITL) types — wire shape for `/v1/hitl/*`.
 *
 * Mirrors `supabase/functions/_shared/hitl-policy.ts` and the
 * `hitl_escalations` row shape after migration 20260507060000.
 * Treat as wire-types only: do not embed business logic that the
 * server-side resolver owns (quorum math, status transitions).
 */

export type HitlQuorumTier =
  | "single_approver"
  | "simple_majority"
  | "two_thirds"
  | "unanimous";

export type HitlStatus =
  | "pending"
  | "escalated"
  | "approved"
  | "rejected"
  | "auto_approved"
  | "timed_out";

export type HitlFallbackDecision = "reject" | "approve";

export interface HitlQuorumProgress {
  required: number;
  approved: number;
  rejected: number;
  remaining: number;
  satisfied: boolean;
  rejected_terminal: boolean;
}

export interface HitlEscalation {
  id: string;
  org_id: string;
  agent_id: string;
  sandbox_run_id: string | null;
  status: HitlStatus;
  escalation_reason: string;
  proposed_action: Record<string, unknown>;
  risk_score: number | null;
  assigned_to_user_id: string | null;
  assigned_to_role: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  auto_approved_reason: string | null;
  resolved_at: string | null;
  timeout_at: string | null;
  created_at: string;

  quorum_required: HitlQuorumTier;
  min_approvers: number;
  approver_pool_size: number;
  escalation_depth: number;
  max_escalation_depth: number;
  fallback_decision: HitlFallbackDecision;
  governance_advisory_id: string | null;
  expired_reason: "sla_expired" | "escalation_chain_exhausted" | "manual_expire" | null;

  quorum_progress?: HitlQuorumProgress;

  // Heterogeneous N-of-M extension. Empty `approver_pool` means the
  // legacy single-pool path applies (server-side resolver decides).
  approver_pool?: HitlApproverPoolEntry[];
  quorum_threshold?: number | null;
  ai_unavailable_fallback?: HitlAiUnavailableFallback;
  fallback_human_role?: string | null;
  pool_unavailable_at?: string | null;

  /** Populated when the server attaches a heterogeneous-quorum tally. */
  heterogeneous_tally?: HitlHeterogeneousQuorumTally;
}

export interface HitlApprovalRecord {
  id: string;
  user_id: string | null;
  actor_label: string | null;
  decision: "approve" | "reject";
  note: string | null;
  quorum_at_vote: HitlQuorumTier;
  created_at: string;
  /** Which kind of approver cast this vote (default `"human"`). */
  approver_type?: HitlApproverType;
}

export interface HitlChainHop {
  id: string;
  depth: number;
  from_user_id: string | null;
  from_role: string | null;
  to_user_id: string | null;
  to_role: string | null;
  escalated_by: string | null;
  reason: string | null;
  created_at: string;
}

export interface ListHitlEscalationsRequest {
  status?: HitlStatus;
  agentId?: string;
  assignedToUserId?: string;
  limit?: number;
  cursor?: string;
}

export interface ListHitlEscalationsResponse {
  escalations: HitlEscalation[];
  total: number;
  next_cursor?: string;
}

/**
 * Wire shape for `POST /v1/hitl` — open a new escalation.
 *
 * The agent-side bridge between a `hold` outcome from `protect()`
 * and the approval queue. Only `agent_id` and `escalation_reason`
 * are required; the rest map to defaults configured on the
 * server-side policy. Pass `approver_pool` to use the heterogeneous
 * N-of-M extension instead of the homogeneous quorum tier.
 */
export interface HitlCreateRequest {
  agent_id: string;
  escalation_reason: string;

  sandbox_run_id?: string;
  proposed_action?: Record<string, unknown>;
  risk_score?: number;
  assigned_to_user_id?: string;
  assigned_to_role?: string;

  quorum_required?: HitlQuorumTier;
  min_approvers?: number;
  approver_pool_size?: number;
  max_escalation_depth?: number;
  fallback_decision?: HitlFallbackDecision;
  timeout_at?: string;
  governance_advisory_id?: string;

  approver_pool?: HitlApproverPoolEntry[];
  quorum_threshold?: number;
  ai_unavailable_fallback?: HitlAiUnavailableFallback;
  fallback_human_role?: string;
}

export interface HitlApproveRequest {
  note?: string;
}

export interface HitlRejectRequest {
  note?: string;
}

export interface HitlEscalateRequest {
  to_role?: string;
  to_user_id?: string;
  reason?: string;
}

/**
 * Translate a quorum tier and approver-pool size to the minimum
 * number of `approve` votes required to resolve the escalation.
 *
 * Mirrors the canonical `requiredApproverCount()` in
 * atlasent-api `_shared/hitl-policy.ts` and the SQL
 * `public.hitl_required_approver_count()` helper. Provided here so
 * SDK consumers can render a "you are the Nth of M approvers" hint
 * without a server round-trip; the authoritative count still comes
 * from the server's `quorum_progress` payload.
 */
export function hitlRequiredApproverCount(
  quorum: HitlQuorumTier,
  poolSize: number,
): number {
  const n = Number.isFinite(poolSize) && poolSize >= 1 ? Math.floor(poolSize) : 1;
  switch (quorum) {
    case "single_approver":
      return 1;
    case "simple_majority":
      return Math.floor(n / 2) + 1;
    case "two_thirds":
      return Math.ceil((2 * n) / 3);
    case "unanimous":
      return n;
  }
}

// ── Heterogeneous N-of-M quorum (migration 20260509120002) ───────────
//
// Mirrors the SQL `approver_pool` jsonb shape and
// `evaluate_heterogeneous_quorum()` row shape. The legacy
// homogeneous path (`approver_pool_size` + `quorum_required` tier) is
// still authoritative when `approver_pool` is empty; these types
// describe the new path only.

export type HitlApproverType =
  | "human"
  | "ai_supervisor"
  | "automated_compliance"
  | "hardware_signer"
  | "service_account";

export type HitlAiUnavailableFallback =
  | "escalate_to_human"
  | "reduce_pool"
  | "fail_closed";

export interface HitlApproverPoolEntry {
  type: HitlApproverType;
  principal_id: string;
  role?: string;
  weight?: number;
  required?: boolean;
  /** Marker for slots inserted by the AI-unavailable fallback. */
  origin?: string;
}

export interface HitlHeterogeneousQuorumExtension {
  approver_pool: HitlApproverPoolEntry[];
  quorum_threshold: number | null;
  ai_unavailable_fallback: HitlAiUnavailableFallback;
  fallback_human_role: string | null;
  pool_unavailable_at: string | null;
}

export interface HitlHeterogeneousQuorumTally {
  pool_size: number;
  effective_pool_size: number;
  required_threshold: number;
  approve_count: number;
  reject_count: number;
  unavailable_count: number;
  /** Per-approver-type breakdown: `{ ai_supervisor: { approve: 1, reject: 0 } }` */
  by_type: Record<HitlApproverType, { approve: number; reject: number }>;
  meets_threshold: boolean;
  any_required_reject: boolean;
  any_required_missing: boolean;
}
