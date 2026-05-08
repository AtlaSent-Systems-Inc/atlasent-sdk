/**
 * Governance graph types: named query results, graph node/edge shapes.
 *
 * Mirrors the `query_governance_graph()` SQL function dispatched by
 * `GET /v1/governance/graph/query?type=<query_type>`.
 */

import type { RateLimitState } from "./types.js";

// ── Query types ───────────────────────────────────────────────────────────────

/**
 * Named traversal queries dispatched by `query_governance_graph()`.
 *
 * | Type | Returns |
 * |---|---|
 * | `production_deployers` | Actors with `executed_in → environment=production` edges |
 * | `execution_approvers` | Actors as targets of `approved_by` edges |
 * | `quorum_bypass_connectors` | Connector nodes with outbound `violates` edges |
 * | `emergency_override_actions` | Execution nodes with `metadata.used_override = true` |
 * | `connected_systems` | Connector/service/external-system nodes with `connected_to`/`synced_from` edges |
 * | `user_approvals` | `approved_by` edges where target `external_id = params.actor_id` (requires `actor_id` param) |
 */
export type GovernanceGraphQueryType =
  | "production_deployers"
  | "execution_approvers"
  | "quorum_bypass_connectors"
  | "emergency_override_actions"
  | "connected_systems"
  | "user_approvals";

// ── Shared graph primitive types ──────────────────────────────────────────────

/**
 * Node type values from the `graph_node_type` DB enum.
 * Additional values may be introduced server-side; treat as open.
 */
export type GraphNodeType =
  | "execution"
  | "permit"
  | "incident"
  | "connector"
  | "service"
  | "external_system"
  | "actor"
  | "policy"
  | "environment"
  | (string & Record<never, never>);

/**
 * Edge type values from the `graph_edge_type` DB enum.
 * Additional values may be introduced server-side; treat as open.
 */
export type GraphEdgeType =
  | "governed_by"
  | "incident_involves"
  | "synced_from"
  | "approved_by"
  | "executed_in"
  | "violates"
  | "connected_to"
  | (string & Record<never, never>);

/** Full graph node row returned by `GET /v1/governance/graph`. */
export interface GraphNode {
  id: string;
  org_id: string;
  node_type: GraphNodeType;
  external_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Full graph edge row returned by `GET /v1/governance/graph/edges`. */
export interface GraphEdge {
  id: string;
  org_id: string;
  edge_type: GraphEdgeType;
  source_node_id: string;
  target_node_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ── Named-query result row shapes ─────────────────────────────────────────────

/** Row returned by `query_type = "production_deployers"`. */
export interface ProductionDeployerRow {
  node_id: string;
  actor_id: string | null;
  exec_count: number;
  last_seen: string | null;
}

/** Row returned by `query_type = "execution_approvers"`. */
export interface ExecutionApproverRow {
  node_id: string;
  actor_id: string | null;
  approval_count: number;
}

/** Row returned by `query_type = "quorum_bypass_connectors"`. */
export interface QuorumBypassConnectorRow {
  node_id: string;
  connector_id: string | null;
  violation_count: number;
}

/** Row returned by `query_type = "emergency_override_actions"`. */
export interface EmergencyOverrideActionRow {
  node_id: string;
  execution_id: string | null;
  actor_id: string | null;
  timestamp: string | null;
}

/** Row returned by `query_type = "connected_systems"`. */
export interface ConnectedSystemRow {
  node_id: string;
  system_id: string | null;
  node_type: GraphNodeType;
  edge_type: GraphEdgeType;
}

/** Row returned by `query_type = "user_approvals"`. */
export interface UserApprovalRow {
  edge_id: string;
  source_node_id: string;
  created_at: string;
}

/**
 * Conditional type mapping each {@link GovernanceGraphQueryType} to its
 * per-row result shape. Use as `GovernanceGraphResultRow<"production_deployers">`.
 */
export type GovernanceGraphResultRow<
  T extends GovernanceGraphQueryType = GovernanceGraphQueryType,
> = T extends "production_deployers"
  ? ProductionDeployerRow
  : T extends "execution_approvers"
    ? ExecutionApproverRow
    : T extends "quorum_bypass_connectors"
      ? QuorumBypassConnectorRow
      : T extends "emergency_override_actions"
        ? EmergencyOverrideActionRow
        : T extends "connected_systems"
          ? ConnectedSystemRow
          : T extends "user_approvals"
            ? UserApprovalRow
            : Record<string, unknown>;

// ── Request / response shapes ─────────────────────────────────────────────────

/**
 * Optional parameters for `queryGovernanceGraph()`.
 *
 * `actor_id` is required when `query_type = "user_approvals"`.
 */
export interface GovernanceGraphQueryParams {
  actor_id?: string;
}

/** Response from {@link AtlaSentClient.queryGovernanceGraph}. */
export interface GovernanceGraphQueryResponse<
  T extends GovernanceGraphQueryType = GovernanceGraphQueryType,
> {
  query_type: T;
  results: GovernanceGraphResultRow<T>[];
  org_id: string;
  rateLimit: RateLimitState | null;
}

// ── Graph CRUD shapes ─────────────────────────────────────────────────────────

/** Response from `listGraphNodes()`. */
export interface ListGraphNodesResponse {
  nodes: GraphNode[];
  total: number;
  nextCursor?: string;
  rateLimit: RateLimitState | null;
}

/** Response from `listGraphEdges()`. */
export interface ListGraphEdgesResponse {
  edges: GraphEdge[];
  total: number;
  nextCursor?: string;
  rateLimit: RateLimitState | null;
}

/** Input for `createGraphNode()`. */
export interface CreateGraphNodeInput {
  node_type: GraphNodeType;
  external_id?: string;
  metadata?: Record<string, unknown>;
}

/** Input for `createGraphEdge()`. */
export interface CreateGraphEdgeInput {
  edge_type: GraphEdgeType;
  source_node_id: string;
  target_node_id: string;
  metadata?: Record<string, unknown>;
}
