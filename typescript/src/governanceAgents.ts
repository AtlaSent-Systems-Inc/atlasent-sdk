/**
 * Constrained governance agents — read-side SDK surface.
 *
 * Three endpoints, all GET, all org-scoped server-side:
 *
 *   GET /v1/governance/agents                — registry of advisory agents
 *   GET /v1/governance/findings?change_id=…  — findings against one change
 *   GET /v1/governance/evaluations?change_id=… — agent run records
 *
 * **Doctrine — evaluation ≠ authorization ≠ execution.**
 * Every type in this module is read-only signal. `can_authorize` is
 * pinned `false` on the wire (DB-generated column on the registry,
 * CHECK on findings). The SDK does not expose an invocation method:
 * agent invocation is a CI concern (atlasent-action `governance-agents`
 * mode), not an application concern. This module is for surfaces that
 * want to render findings alongside the authority workflow.
 *
 * Wire schema source of truth lives in
 *   atlasent-api/packages/types/src/governance-agents.ts
 * which is intentionally standalone (not re-exported from @atlasent/types).
 * The shapes mirrored below are the read-side subset.
 *
 * @module
 */

// ─── enums (mirror SQL CHECK domains) ────────────────────────────────────────

export type AgentFindingSeverity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "blocker";

export type AgentEvaluationStatus =
  | "running"
  | "completed"
  | "failed"
  | "timeout";

export type AgentAuthorityDomain =
  | "engineering"
  | "runtime_platform"
  | "security"
  | "compliance"
  | "release_management"
  | "operations"
  | "customer_impact"
  | "governance_office";

export type AgentInvokerKind =
  | "human"
  | "service_account"
  | "autonomous_agent"
  | "system";

export type AgentSubjectKind =
  | "pull_request"
  | "schema_migration"
  | "runtime_flag"
  | "deployment"
  | "operational_rollout"
  | "regulated_execution_change"
  | "policy_bundle";

// ─── records ─────────────────────────────────────────────────────────────────

/**
 * A versioned advisory agent definition. `authority_class` is fixed to
 * `advisory` and `can_authorize` to `false` at the schema level — these
 * cannot be relaxed without a structural change to the runtime DB.
 */
export interface GovernanceAgent {
  readonly slug: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly applicable_subject_kinds: readonly AgentSubjectKind[];
  readonly authority_class: "advisory";
  /** Structurally false. Generated column on the runtime DB. */
  readonly can_authorize: false;
  readonly capabilities: readonly string[];
  readonly is_active: boolean;
  readonly created_at: string;
  readonly retired_at: string | null;
}

/** A typed evidence pointer attached to a finding. Free-form by design. */
export interface AgentEvidenceRef {
  readonly kind: string;
  readonly ref: string;
  readonly note?: string;
}

/**
 * One advisory finding produced by an agent run. `can_authorize` is
 * pinned `false` by a CHECK constraint on the underlying table — no
 * finding row in any environment can ever satisfy a gate.
 */
export interface GovernanceAgentFinding {
  readonly id: string;
  readonly org_id: string;
  readonly evaluation_id: string;
  readonly change_id: string;
  readonly agent_slug: string;
  readonly agent_version: string;
  readonly finding_type: string;
  readonly severity: AgentFindingSeverity;
  readonly confidence: number | null;
  readonly summary: string;
  readonly evidence_refs: readonly AgentEvidenceRef[];
  readonly required_authority: AgentAuthorityDomain | null;
  readonly recommended_action: string | null;
  /** Structurally false. CHECK constraint on the runtime DB. */
  readonly can_authorize: false;
  readonly supersedes_finding_id: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  /**
   * Populated by the finding→gate routing trigger (atlasent-api #842).
   * Null when no matching gate exists at insertion time; can be
   * back-resolved by `governance_resolve_findings_for_gate(gate_id)`.
   */
  readonly routed_gate_id?: string | null;
}

/**
 * An append-only record of one agent run against one governed change.
 * The same (agent_slug, agent_version, input_hash) combination may
 * produce multiple rows across time — the runtime DB does not dedupe.
 */
export interface GovernanceAgentEvaluation {
  readonly id: string;
  readonly org_id: string;
  readonly change_id: string;
  readonly agent_slug: string;
  readonly agent_version: string;
  readonly input_hash: string;
  readonly status: AgentEvaluationStatus;
  readonly highest_severity: AgentFindingSeverity | null;
  readonly findings_count: number;
  readonly summary: string | null;
  readonly runtime_ms: number | null;
  readonly failure_reason: string | null;
  readonly invoked_by_kind: AgentInvokerKind;
  readonly invoked_by: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
}

// ─── response envelopes ──────────────────────────────────────────────────────

export interface ListGovernanceAgentsResponse {
  readonly agents: readonly GovernanceAgent[];
}

export interface ListGovernanceFindingsResponse {
  readonly findings: readonly GovernanceAgentFinding[];
}

export interface ListGovernanceEvaluationsResponse {
  readonly evaluations: readonly GovernanceAgentEvaluation[];
}

// ─── query shapes ────────────────────────────────────────────────────────────

export interface ListGovernanceFindingsQuery {
  readonly change_id: string;
  /** Optional: filter to one agent's findings. */
  readonly agent_slug?: string;
}

export interface ListGovernanceEvaluationsQuery {
  readonly change_id: string;
  /** Optional: filter to one agent's runs. */
  readonly agent_slug?: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AgentFindingSeverity, number> = {
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  blocker: 5,
};

/**
 * Return the worst severity across a set of findings, or `null` when
 * the input is empty. Pure function, exported because every consumer
 * needs the same rollup logic (Console finds panel, CI summary, etc.).
 */
export function highestAgentFindingSeverity(
  findings: readonly Pick<GovernanceAgentFinding, "severity">[],
): AgentFindingSeverity | null {
  let best: AgentFindingSeverity | null = null;
  let rank = 0;
  for (const f of findings) {
    const r = SEVERITY_RANK[f.severity];
    if (r > rank) {
      rank = r;
      best = f.severity;
    }
  }
  return best;
}
