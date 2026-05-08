/**
 * Incident reconstruction types: shapes returned by
 * `reconstruct_incident_chains_v2()` via
 * `GET /v1/governance/timeline/incident/{incidentId}`.
 */

import type { RateLimitState } from "./types.js";

/**
 * Single execution row returned by `reconstruct_incident_chains_v2()`.
 *
 * All §13.1 additive columns are nullable — rows inserted before the
 * migration have `null` for any field added after their insert.
 */
export interface IncidentChainExecutionRow {
  execution_id: string;
  actor_id: string | null;
  action_id: string | null;
  /** Broad action category (e.g. `"write"`, `"admin"`). */
  action_class: string | null;
  outcome: string | null;
  started_at: string | null;
  completed_at: string | null;
  /** UUID of the delegation chain this execution belongs to. */
  delegation_chain_id: string | null;
  /** UUID of the original execution this is a replay of. */
  replay_of_execution_id: string | null;
  /** UUID of the incident this execution is linked to (§13.1 column). */
  incident_id: string | null;
  /** UUID of the policy version pinned at evaluate() time. */
  policy_version_id: string | null;
  /** UUID of the bundle version pinned at evaluate() time. */
  bundle_version_id: string | null;
  decision_id: string | null;
  subject_id: string | null;
  resource_id: string | null;
  /** Structured deny/abort code (e.g. `"policy_deny"`, `"quorum_failed"`). */
  outcome_reason: string | null;
  parent_execution_id: string | null;
}

/** Per-actor summary within the reconstructed incident chain. */
export interface IncidentChainActorEntry {
  actor_id: string;
  execution_ids: string[];
  execution_count: number;
}

/** Evidence row bound to the incident chain (shape is open/forward-compat). */
export type IncidentChainEvidenceRow = Record<string, unknown>;

/**
 * Full response from `GET /v1/governance/timeline/incident/{incidentId}`.
 *
 * Backed by `reconstruct_incident_chains_v2()` which fixes the
 * `executor_id → actor_id` bug that caused silent empty timelines
 * in the v1 function.
 */
export interface IncidentTimelineResponse {
  incident_id: string;
  /** All execution rows in the incident, newest first. */
  execution_rows: IncidentChainExecutionRow[];
  /** Per-actor rollup: which executions each actor was responsible for. */
  actor_timeline: IncidentChainActorEntry[];
  /** Evidence rows bound to this incident's chain. */
  evidence: IncidentChainEvidenceRow[];
  rateLimit: RateLimitState | null;
}
