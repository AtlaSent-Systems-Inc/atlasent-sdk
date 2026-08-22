import { describe, expect, it, vi, type MockedFunction } from "vitest";

import { AtlaSentClient } from "../src/index.js";

type FetchMock = MockedFunction<typeof fetch>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function mockFetch(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchMock {
  return vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return impl(url, init ?? {});
    },
  ) as unknown as FetchMock;
}

function makeClient(fetchImpl: FetchMock) {
  return new AtlaSentClient({
    apiKey: "ask_live_test",
    fetch: fetchImpl,
    timeoutMs: 5_000,
  });
}

// ── Minimal fixture data ──────────────────────────────────────────────────────

const ESCALATION_STUB = {
  id: "esc_1",
  org_id: "org_1",
  agent_id: "agent_1",
  sandbox_run_id: null,
  status: "pending",
  escalation_reason: "policy_requires_approval",
  proposed_action: {},
  risk_score: 50,
  assigned_to_user_id: null,
  assigned_to_role: "approver",
  resolved_by: null,
  resolution_note: null,
  auto_approved_reason: null,
  resolved_at: null,
  timeout_at: "2026-05-08T00:00:00Z",
  created_at: "2026-05-07T00:00:00Z",
  quorum_required: "two_thirds",
  min_approvers: 1,
  approver_pool_size: 3,
  escalation_depth: 0,
  max_escalation_depth: 3,
  fallback_decision: "reject",
  governance_advisory_id: null,
  expired_reason: null,
  metadata: null,
};

const CHAIN_HOP = {
  id: "hop_1",
  depth: 1,
  from_user_id: null,
  from_role: "approver",
  to_user_id: null,
  to_role: "security_lead",
  escalated_by: "user_99",
  reason: "escalated up",
  created_at: "2026-05-07T01:00:00Z",
};

const CONNECTOR_ROW = {
  id: "conn_1",
  org_id: "org_1",
  connector_type: "github",
  name: "Main GitHub",
  environment: "production",
  status: "active",
  scopes: ["repo"],
  config: {},
  last_synced_at: null,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
};

const ENFORCEMENT_POLICY = {
  id: "policy_1",
  org_id: "org_1",
  connector_type: "github",
  trigger_event: "push",
  condition: {},
  required_action: "require_approval",
  quorum_config: null,
  environment_scope: ["production"],
  enabled: true,
  priority: 10,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
};

const RISK_SCORE = {
  id: "risk_1",
  org_id: "org_1",
  overall_score: 42,
  risk_level: "medium",
  actor_risk_score: 20,
  connector_risk_score: 10,
  enforcement_gap_score: 5,
  incident_frequency_score: 7,
  override_rate_score: 0,
  risky_actors: [],
  risky_systems: [],
  repeated_overrides: [],
  window_days: 30,
  computed_at: "2026-05-07T00:00:00Z",
  created_at: "2026-05-07T00:00:00Z",
};

const CROSS_ORG_PERMISSION_RESULT = {
  check_id: "chk_1",
  allowed: true,
  reason: "trust path resolved",
  trust_path: [{ org_id: "org_2", trust_type: "federated", trust_level: "high" }],
  conditions: [],
  checked_at: "2026-05-07T00:00:00Z",
};

const ANOMALY_RULE = {
  id: "rule_1",
  org_id: "org_1",
  name: "High anomaly freeze",
  description: "Freeze agent on high anomaly",
  anomaly_score_threshold: 80,
  action_type: "freeze_agent",
  action_config: {},
  is_active: true,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
};

const ANOMALY_EVENT = {
  id: "evt_1",
  rule_id: "rule_1",
  execution_id: "exec_1",
  org_id: "org_1",
  anomaly_score: 85,
  action_type: "freeze_agent",
  action_result: { frozen: true },
  triggered_at: "2026-05-07T00:00:00Z",
};

const BUDGET_EXCEPTION = {
  id: "exc_1",
  org_id: "org_1",
  budget_policy_id: "bp_1",
  requested_by: "user_1",
  amount_requested: 5000,
  currency: "USD",
  reason: "Q3 campaign overage",
  status: "pending",
  conditions: [],
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
};

const AUTHORITY_LEVEL = {
  id: "lvl_1",
  org_id: "org_1",
  name: "Tier 1",
  level: 1,
  escalation_sla_hours: 24,
  created_at: "2026-05-01T00:00:00Z",
};

const REGULATORY_ESCALATION = {
  id: "regesc_1",
  org_id: "org_1",
  from_level_id: "lvl_1",
  to_level_id: "lvl_2",
  subject_type: "execution",
  subject_id: "exec_1",
  reason: "policy breach",
  details: {},
  status: "pending",
  escalated_by: "user_1",
  created_at: "2026-05-07T00:00:00Z",
  updated_at: "2026-05-07T00:00:00Z",
};

const SIGNAL_ACTION = {
  id: "act_1",
  signal_id: "sig_1",
  org_id: "org_1",
  action_type: "accepted",
  taken_at: "2026-05-07T00:00:00Z",
  metadata: {},
};

const SIGNAL_SUMMARY = {
  total_signals: 10,
  acted_on: 7,
  dismissed: 3,
  average_outcome_score: 0.75,
  by_action_type: {
    accepted: { count: 5, avg_outcome: 0.9 },
    dismissed: { count: 3, avg_outcome: 0 },
    escalated: { count: 2, avg_outcome: 0.6 },
    delegated: { count: 0, avg_outcome: 0 },
    policy_updated: { count: 0, avg_outcome: 0 },
    training_initiated: { count: 0, avg_outcome: 0 },
    process_changed: { count: 0, avg_outcome: 0 },
    monitoring_increased: { count: 0, avg_outcome: 0 },
    auto_remediated: { count: 0, avg_outcome: 0 },
  },
};

const IMPERSONATION_GRANT = {
  id: "grant_1",
  grantor_org_id: "org_1",
  grantee_org_id: "org_2",
  grantee_service_account_id: "sa_1",
  impersonated_role: "auditor",
  allowed_actions: ["read"],
  allowed_resource_types: ["executions"],
  max_token_duration_seconds: 3600,
  is_active: true,
  created_by: "user_1",
  created_at: "2026-05-01T00:00:00Z",
};

const IMPERSONATION_TOKEN = {
  token: "imp_tok_abc123",
  expires_at: "2026-05-08T01:00:00Z",
  grant_id: "grant_1",
};

// ── HITL – createHitlEscalation / getHitlChain ───────────────────────────────

describe("HITL additional methods", () => {
  it("createHitlEscalation POSTs to /v1/hitl and returns escalation", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/hitl");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.agent_id).toBe("agent_1");
      return jsonResponse(ESCALATION_STUB);
    });
    const client = makeClient(fetchMock);
    const result = await client.createHitlEscalation({
      agent_id: "agent_1",
      escalation_reason: "policy_requires_approval",
    });
    expect(result.escalation.id).toBe("esc_1");
    expect(result.escalation.status).toBe("pending");
  });

  it("getHitlChain GETs /v1/hitl/:id/chain and returns chain array", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/hitl/esc_1/chain");
      return jsonResponse({ chain: [CHAIN_HOP] });
    });
    const client = makeClient(fetchMock);
    const result = await client.getHitlChain("esc_1");
    expect(result.chain).toHaveLength(1);
    expect(result.chain[0]!.to_role).toBe("security_lead");
  });

  it("getHitlChain returns empty array when server omits chain", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    const result = await client.getHitlChain("esc_x");
    expect(result.chain).toEqual([]);
  });
});

// ── Governance Graph ──────────────────────────────────────────────────────────

describe("queryGovernanceGraph", () => {
  it("sends type param and returns results for production_deployers", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/governance/graph/query");
      expect(url).toContain("type=production_deployers");
      return jsonResponse({
        query_type: "production_deployers",
        results: [
          { node_id: "n_1", actor_id: "actor_1", exec_count: 5, last_seen: "2026-05-07T00:00:00Z" },
        ],
        org_id: "org_1",
      });
    });
    const client = makeClient(fetchMock);
    const result = await client.queryGovernanceGraph("production_deployers");
    expect(result.query_type).toBe("production_deployers");
    expect(result.results).toHaveLength(1);
    expect(result.org_id).toBe("org_1");
  });

  it("passes actor_id param for user_approvals query", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toContain("type=user_approvals");
      expect(url).toContain("actor_id=actor_99");
      return jsonResponse({
        query_type: "user_approvals",
        results: [{ edge_id: "e_1", source_node_id: "n_1", created_at: "2026-05-07T00:00:00Z" }],
        org_id: "org_1",
      });
    });
    const client = makeClient(fetchMock);
    const result = await client.queryGovernanceGraph("user_approvals", { actor_id: "actor_99" });
    expect(result.results).toHaveLength(1);
  });
});

// ── Incident Timeline ─────────────────────────────────────────────────────────

describe("getIncidentTimeline", () => {
  it("GETs /v1/governance/timeline/incident/:id and returns timeline", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/governance/timeline/incident/inc_1");
      return jsonResponse({
        incident_id: "inc_1",
        execution_rows: [],
        actor_timeline: [],
        evidence: [],
      });
    });
    const client = makeClient(fetchMock);
    const result = await client.getIncidentTimeline("inc_1");
    expect(result.incident_id).toBe("inc_1");
    expect(result.execution_rows).toEqual([]);
  });

  it("throws bad_request when incidentId is empty", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    await expect(client.getIncidentTimeline("")).rejects.toMatchObject({
      code: "bad_request",
    });
  });
});

// ── Connector Management ──────────────────────────────────────────────────────

describe("listConnectors", () => {
  it("GETs /v1/governance/connectors and returns connectors array", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/governance/connectors");
      return jsonResponse({ connectors: [CONNECTOR_ROW], total: 1 });
    });
    const client = makeClient(fetchMock);
    const result = await client.listConnectors();
    expect(result.connectors).toHaveLength(1);
    expect(result.connectors[0]!.id).toBe("conn_1");
    expect(result.total).toBe(1);
  });

  it("passes cursor and limit as query params", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toContain("cursor=tok_abc");
      expect(url).toContain("limit=10");
      return jsonResponse({ connectors: [], total: 0, next_cursor: "tok_xyz" });
    });
    const client = makeClient(fetchMock);
    const result = await client.listConnectors({ cursor: "tok_abc", limit: 10 });
    expect(result.connectors).toEqual([]);
    expect(result.nextCursor).toBe("tok_xyz");
  });
});

describe("installConnector", () => {
  it("POSTs to /v1/governance/connectors and returns connector", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/governance/connectors");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.connector_type).toBe("github");
      return jsonResponse(CONNECTOR_ROW);
    });
    const client = makeClient(fetchMock);
    const result = await client.installConnector({
      connector_type: "github",
      name: "Main GitHub",
      environment: "production",
    });
    expect(result.connector.id).toBe("conn_1");
    expect(result.connector.status).toBe("active");
  });
});

describe("authenticateConnector", () => {
  it("POSTs to /v1/governance/connectors/:id/authenticate", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/governance/connectors/conn_1/authenticate");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.credential_type).toBe("api_key");
      return jsonResponse({ credential_id: "cred_1", version: 1 });
    });
    const client = makeClient(fetchMock);
    const result = await client.authenticateConnector("conn_1", {
      credential_type: "api_key",
      encrypted_value: "enc_secret",
    });
    expect(result.credential_id).toBe("cred_1");
    expect(result.version).toBe(1);
  });

  it("throws bad_request when connectorId is empty", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    await expect(
      client.authenticateConnector("", { credential_type: "api_key", encrypted_value: "x" }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("syncConnector", () => {
  it("POSTs to /v1/governance/connectors/:id/sync", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/governance/connectors/conn_1/sync");
      return jsonResponse({
        connector_id: "conn_1",
        status: "syncing",
        sync_started_at: "2026-05-07T00:00:00Z",
      });
    });
    const client = makeClient(fetchMock);
    const result = await client.syncConnector("conn_1");
    expect(result.connector_id).toBe("conn_1");
    expect(result.status).toBe("syncing");
  });

  it("throws bad_request when connectorId is empty", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    await expect(client.syncConnector("")).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("revokeConnector", () => {
  it("POSTs to /v1/governance/connectors/:id/revoke", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/governance/connectors/conn_1/revoke");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.reason).toBe("decommissioned");
      return jsonResponse({ connector_id: "conn_1", revoked_at: "2026-05-07T00:00:00Z" });
    });
    const client = makeClient(fetchMock);
    const result = await client.revokeConnector("conn_1", "decommissioned");
    expect(result.connector_id).toBe("conn_1");
    expect(result.revoked_at).toBe("2026-05-07T00:00:00Z");
  });

  it("POSTs without reason when omitted", async () => {
    const fetchMock = mockFetch((url, init) => {
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.reason).toBeUndefined();
      return jsonResponse({ connector_id: "conn_1", revoked_at: "2026-05-07T00:00:00Z" });
    });
    const client = makeClient(fetchMock);
    const result = await client.revokeConnector("conn_1");
    expect(result.connector_id).toBe("conn_1");
  });

  it("throws bad_request when connectorId is empty", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    await expect(client.revokeConnector("")).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("rotateConnectorCredentials", () => {
  it("POSTs to /v1/governance/connectors/:id/rotate-credentials", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/governance/connectors/conn_1/rotate-credentials");
      return jsonResponse({
        connector_id: "conn_1",
        new_version: 2,
        rotated_at: "2026-05-07T00:00:00Z",
      });
    });
    const client = makeClient(fetchMock);
    const result = await client.rotateConnectorCredentials("conn_1");
    expect(result.connector_id).toBe("conn_1");
    expect(result.new_version).toBe(2);
  });

  it("throws bad_request when connectorId is empty", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    await expect(client.rotateConnectorCredentials("")).rejects.toMatchObject({ code: "bad_request" });
  });
});

// ── Enforcement Policies ──────────────────────────────────────────────────────

describe("listEnforcementPolicies", () => {
  it("GETs /v1/governance/enforcement-policies and returns policies", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/governance/enforcement-policies");
      return jsonResponse({ policies: [ENFORCEMENT_POLICY], total: 1 });
    });
    const client = makeClient(fetchMock);
    const result = await client.listEnforcementPolicies();
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0]!.id).toBe("policy_1");
    expect(result.total).toBe(1);
  });

  it("passes connector_type filter as query param", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toContain("connector_type=github");
      return jsonResponse({ policies: [], total: 0 });
    });
    const client = makeClient(fetchMock);
    const result = await client.listEnforcementPolicies("github");
    expect(result.policies).toEqual([]);
  });
});

describe("upsertEnforcementPolicy", () => {
  it("POSTs to /v1/governance/enforcement-policies and returns policy", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/governance/enforcement-policies");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.connector_type).toBe("github");
      return jsonResponse(ENFORCEMENT_POLICY);
    });
    const client = makeClient(fetchMock);
    const result = await client.upsertEnforcementPolicy({
      connector_type: "github",
      trigger_event: "push",
      required_action: "require_approval",
    });
    expect(result.policy.id).toBe("policy_1");
    expect(result.policy.required_action).toBe("require_approval");
  });
});

// ── Org Risk ──────────────────────────────────────────────────────────────────

describe("computeOrgRisk", () => {
  it("POSTs to /v1/governance/risk/compute and returns score", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/governance/risk/compute");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.window_days).toBe(7);
      return jsonResponse(RISK_SCORE);
    });
    const client = makeClient(fetchMock);
    const result = await client.computeOrgRisk({ window_days: 7 });
    expect(result.score.overall_score).toBe(42);
    expect(result.score.risk_level).toBe("medium");
  });

  it("POSTs with empty options by default", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/governance/risk/compute");
      return jsonResponse(RISK_SCORE);
    });
    const client = makeClient(fetchMock);
    const result = await client.computeOrgRisk();
    expect(result.score.id).toBe("risk_1");
  });
});

describe("getLatestOrgRisk", () => {
  it("GETs /v1/governance/risk/latest and returns score", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/governance/risk/latest");
      return jsonResponse({ score: RISK_SCORE });
    });
    const client = makeClient(fetchMock);
    const result = await client.getLatestOrgRisk();
    expect(result.score).not.toBeNull();
    expect(result.score!.overall_score).toBe(42);
  });

  it("returns null score when server returns no score", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    const result = await client.getLatestOrgRisk();
    expect(result.score).toBeNull();
  });
});

describe("listOrgRiskHistory", () => {
  it("GETs /v1/governance/risk/history and returns scores", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/governance/risk/history");
      return jsonResponse({ scores: [RISK_SCORE], total: 1 });
    });
    const client = makeClient(fetchMock);
    const result = await client.listOrgRiskHistory();
    expect(result.scores).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("passes cursor and limit and sets nextCursor", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toContain("cursor=tok_a");
      expect(url).toContain("limit=5");
      return jsonResponse({ scores: [], total: 0, next_cursor: "tok_b" });
    });
    const client = makeClient(fetchMock);
    const result = await client.listOrgRiskHistory({ cursor: "tok_a", limit: 5 });
    expect(result.nextCursor).toBe("tok_b");
  });
});

// ── Cross-Org Permission ──────────────────────────────────────────────────────

describe("checkCrossOrgPermission", () => {
  it("POSTs to /v1/cross-org/permissions/check and returns result", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/cross-org/permissions/check");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.source_org_id).toBe("org_1");
      expect(body.action).toBe("read");
      return jsonResponse(CROSS_ORG_PERMISSION_RESULT);
    });
    const client = makeClient(fetchMock);
    const result = await client.checkCrossOrgPermission({
      source_org_id: "org_1",
      target_org_id: "org_2",
      action: "read",
    });
    expect(result.check_id).toBe("chk_1");
    expect(result.allowed).toBe(true);
  });
});

describe("listCrossOrgPermissionChecks", () => {
  it("GETs /v1/cross-org/permissions/checks and returns checks array", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/cross-org/permissions/checks");
      return jsonResponse({ checks: [CROSS_ORG_PERMISSION_RESULT] });
    });
    const client = makeClient(fetchMock);
    const result = await client.listCrossOrgPermissionChecks();
    expect(result).toHaveLength(1);
    expect(result[0]!.check_id).toBe("chk_1");
  });

  it("passes filter params as query strings", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toContain("source_org_id=org_1");
      expect(url).toContain("target_org_id=org_2");
      expect(url).toContain("allowed=true");
      expect(url).toContain("limit=20");
      return jsonResponse({ checks: [] });
    });
    const client = makeClient(fetchMock);
    const result = await client.listCrossOrgPermissionChecks({
      source_org_id: "org_1",
      target_org_id: "org_2",
      allowed: true,
      limit: 20,
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when server omits checks", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    const result = await client.listCrossOrgPermissionChecks();
    expect(result).toEqual([]);
  });
});

// ── Anomaly Response ──────────────────────────────────────────────────────────

describe("listAnomalyResponseRules", () => {
  it("GETs /v1/anomaly-response/rules and returns rules array", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/anomaly-response/rules");
      return jsonResponse({ rules: [ANOMALY_RULE] });
    });
    const client = makeClient(fetchMock);
    const result = await client.listAnomalyResponseRules();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("rule_1");
  });

  it("returns empty array when server omits rules", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    const result = await client.listAnomalyResponseRules();
    expect(result).toEqual([]);
  });
});

describe("createAnomalyResponseRule", () => {
  it("POSTs to /v1/anomaly-response/rules and returns created rule", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/anomaly-response/rules");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.name).toBe("High anomaly freeze");
      expect(body.anomaly_score_threshold).toBe(80);
      return jsonResponse(ANOMALY_RULE);
    });
    const client = makeClient(fetchMock);
    const result = await client.createAnomalyResponseRule({
      name: "High anomaly freeze",
      anomaly_score_threshold: 80,
      action_type: "freeze_agent",
    });
    expect(result.id).toBe("rule_1");
    expect(result.action_type).toBe("freeze_agent");
  });
});

describe("updateAnomalyResponseRule", () => {
  it("POSTs to /v1/anomaly-response/rules/:id/update and returns updated rule", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/anomaly-response/rules/rule_1/update");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.anomaly_score_threshold).toBe(90);
      return jsonResponse({ ...ANOMALY_RULE, anomaly_score_threshold: 90 });
    });
    const client = makeClient(fetchMock);
    const result = await client.updateAnomalyResponseRule("rule_1", {
      anomaly_score_threshold: 90,
    });
    expect(result.anomaly_score_threshold).toBe(90);
  });
});

describe("deleteAnomalyResponseRule", () => {
  it("POSTs to /v1/anomaly-response/rules/:id/delete and returns void", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/anomaly-response/rules/rule_1/delete");
      return jsonResponse({});
    });
    const client = makeClient(fetchMock);
    const result = await client.deleteAnomalyResponseRule("rule_1");
    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("triggerAnomalyResponse", () => {
  it("POSTs to /v1/anomaly-response/trigger and returns events array", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/anomaly-response/trigger");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.execution_id).toBe("exec_1");
      expect(body.anomaly_score).toBe(85);
      return jsonResponse({ events: [ANOMALY_EVENT] });
    });
    const client = makeClient(fetchMock);
    const result = await client.triggerAnomalyResponse({
      execution_id: "exec_1",
      anomaly_score: 85,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("evt_1");
  });

  it("returns empty array when no events triggered", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ events: [] }));
    const client = makeClient(fetchMock);
    const result = await client.triggerAnomalyResponse({
      execution_id: "exec_x",
      anomaly_score: 5,
    });
    expect(result).toEqual([]);
  });
});

describe("listAnomalyResponseEvents", () => {
  it("GETs /v1/anomaly-response/events and returns events array", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/anomaly-response/events");
      return jsonResponse({ events: [ANOMALY_EVENT] });
    });
    const client = makeClient(fetchMock);
    const result = await client.listAnomalyResponseEvents();
    expect(result).toHaveLength(1);
    expect(result[0]!.rule_id).toBe("rule_1");
  });

  it("passes execution_id and limit query params", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toContain("execution_id=exec_1");
      expect(url).toContain("limit=10");
      return jsonResponse({ events: [] });
    });
    const client = makeClient(fetchMock);
    const result = await client.listAnomalyResponseEvents({ execution_id: "exec_1", limit: 10 });
    expect(result).toEqual([]);
  });
});

// ── Budget Exceptions ─────────────────────────────────────────────────────────

describe("listBudgetExceptions", () => {
  it("GETs /v1/budget-exceptions and returns exceptions array", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/budget-exceptions");
      return jsonResponse({ exceptions: [BUDGET_EXCEPTION] });
    });
    const client = makeClient(fetchMock);
    const result = await client.listBudgetExceptions();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("exc_1");
  });

  it("passes status, budget_policy_id, limit and offset params", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toContain("status=pending");
      expect(url).toContain("budget_policy_id=bp_1");
      expect(url).toContain("limit=5");
      expect(url).toContain("offset=0");
      return jsonResponse({ exceptions: [] });
    });
    const client = makeClient(fetchMock);
    const result = await client.listBudgetExceptions({
      status: "pending",
      budget_policy_id: "bp_1",
      limit: 5,
      offset: 0,
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when server omits exceptions", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    const result = await client.listBudgetExceptions();
    expect(result).toEqual([]);
  });
});

describe("getBudgetException", () => {
  it("GETs /v1/budget-exceptions/:id and returns exception", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/budget-exceptions/exc_1");
      return jsonResponse(BUDGET_EXCEPTION);
    });
    const client = makeClient(fetchMock);
    const result = await client.getBudgetException("exc_1");
    expect(result.id).toBe("exc_1");
    expect(result.amount_requested).toBe(5000);
  });
});

describe("createBudgetException", () => {
  it("POSTs to /v1/budget-exceptions and returns created exception", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/budget-exceptions");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.amount_requested).toBe(5000);
      expect(body.reason).toBe("Q3 campaign overage");
      return jsonResponse(BUDGET_EXCEPTION);
    });
    const client = makeClient(fetchMock);
    const result = await client.createBudgetException({
      amount_requested: 5000,
      reason: "Q3 campaign overage",
    });
    expect(result.id).toBe("exc_1");
    expect(result.status).toBe("pending");
  });
});

describe("approveBudgetException", () => {
  it("POSTs to /v1/budget-exceptions/:id/approve and returns updated exception", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/budget-exceptions/exc_1/approve");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.approved_amount).toBe(4000);
      return jsonResponse({ ...BUDGET_EXCEPTION, status: "approved", approved_amount: 4000 });
    });
    const client = makeClient(fetchMock);
    const result = await client.approveBudgetException("exc_1", { approved_amount: 4000 });
    expect(result.status).toBe("approved");
    expect(result.approved_amount).toBe(4000);
  });
});

describe("rejectBudgetException", () => {
  it("POSTs to /v1/budget-exceptions/:id/reject with notes", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/budget-exceptions/exc_1/reject");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.review_notes).toBe("Exceeds policy");
      return jsonResponse({ ...BUDGET_EXCEPTION, status: "rejected" });
    });
    const client = makeClient(fetchMock);
    const result = await client.rejectBudgetException("exc_1", "Exceeds policy");
    expect(result.status).toBe("rejected");
  });

  it("POSTs without notes when omitted", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ ...BUDGET_EXCEPTION, status: "rejected" }),
    );
    const client = makeClient(fetchMock);
    const result = await client.rejectBudgetException("exc_1");
    expect(result.status).toBe("rejected");
  });
});

describe("cancelBudgetException", () => {
  it("POSTs to /v1/budget-exceptions/:id/cancel and returns updated exception", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/budget-exceptions/exc_1/cancel");
      return jsonResponse({ ...BUDGET_EXCEPTION, status: "cancelled" });
    });
    const client = makeClient(fetchMock);
    const result = await client.cancelBudgetException("exc_1");
    expect(result.status).toBe("cancelled");
  });
});

// ── Regulatory Escalation ─────────────────────────────────────────────────────

describe("listRegulatoryAuthorityLevels", () => {
  it("GETs /v1/regulatory/authority-levels and returns levels array", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/regulatory/authority-levels");
      return jsonResponse({ levels: [AUTHORITY_LEVEL] });
    });
    const client = makeClient(fetchMock);
    const result = await client.listRegulatoryAuthorityLevels();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("lvl_1");
  });

  it("returns empty array when server omits levels", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    const result = await client.listRegulatoryAuthorityLevels();
    expect(result).toEqual([]);
  });
});

describe("createRegulatoryAuthorityLevel", () => {
  it("POSTs to /v1/regulatory/authority-levels and returns created level", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/regulatory/authority-levels");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.name).toBe("Tier 1");
      expect(body.level).toBe(1);
      return jsonResponse(AUTHORITY_LEVEL);
    });
    const client = makeClient(fetchMock);
    const result = await client.createRegulatoryAuthorityLevel({
      name: "Tier 1",
      level: 1,
      escalation_sla_hours: 24,
    });
    expect(result.id).toBe("lvl_1");
    expect(result.escalation_sla_hours).toBe(24);
  });
});

describe("listRegulatoryEscalations", () => {
  it("GETs /v1/regulatory/escalations and returns escalations array", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/regulatory/escalations");
      return jsonResponse({ escalations: [REGULATORY_ESCALATION] });
    });
    const client = makeClient(fetchMock);
    const result = await client.listRegulatoryEscalations();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("regesc_1");
  });

  it("passes status, subject_type and subject_id params", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toContain("status=pending");
      expect(url).toContain("subject_type=execution");
      expect(url).toContain("subject_id=exec_1");
      return jsonResponse({ escalations: [] });
    });
    const client = makeClient(fetchMock);
    const result = await client.listRegulatoryEscalations({
      status: "pending",
      subject_type: "execution",
      subject_id: "exec_1",
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when server omits escalations", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    const result = await client.listRegulatoryEscalations();
    expect(result).toEqual([]);
  });
});

describe("createRegulatoryEscalation", () => {
  it("POSTs to /v1/regulatory/escalations and returns created escalation", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/regulatory/escalations");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.from_level_id).toBe("lvl_1");
      expect(body.reason).toBe("policy breach");
      return jsonResponse(REGULATORY_ESCALATION);
    });
    const client = makeClient(fetchMock);
    const result = await client.createRegulatoryEscalation({
      from_level_id: "lvl_1",
      to_level_id: "lvl_2",
      subject_type: "execution",
      subject_id: "exec_1",
      reason: "policy breach",
    });
    expect(result.id).toBe("regesc_1");
    expect(result.status).toBe("pending");
  });
});

describe("acknowledgeRegulatoryEscalation", () => {
  it("POSTs to /v1/regulatory/escalations/:id/acknowledge and returns escalation", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/regulatory/escalations/regesc_1/acknowledge");
      return jsonResponse({ ...REGULATORY_ESCALATION, status: "acknowledged" });
    });
    const client = makeClient(fetchMock);
    const result = await client.acknowledgeRegulatoryEscalation("regesc_1");
    expect(result.status).toBe("acknowledged");
  });
});

describe("resolveRegulatoryEscalation", () => {
  it("POSTs to /v1/regulatory/escalations/:id/resolve with resolution", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/regulatory/escalations/regesc_1/resolve");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.resolution).toBe("issue mitigated");
      expect(body.resolution_details).toEqual({ remediation: "patched" });
      return jsonResponse({ ...REGULATORY_ESCALATION, status: "resolved" });
    });
    const client = makeClient(fetchMock);
    const result = await client.resolveRegulatoryEscalation(
      "regesc_1",
      "issue mitigated",
      { remediation: "patched" },
    );
    expect(result.status).toBe("resolved");
  });

  it("resolves without optional resolution_details", async () => {
    const fetchMock = mockFetch((url, init) => {
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.resolution).toBe("closed");
      return jsonResponse({ ...REGULATORY_ESCALATION, status: "resolved" });
    });
    const client = makeClient(fetchMock);
    const result = await client.resolveRegulatoryEscalation("regesc_1", "closed");
    expect(result.status).toBe("resolved");
  });
});

describe("overrideRegulatoryEscalation", () => {
  it("POSTs to /v1/regulatory/escalations/:id/override with reason", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/regulatory/escalations/regesc_1/override");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.reason).toBe("emergency exception");
      return jsonResponse({ ...REGULATORY_ESCALATION, status: "overridden" });
    });
    const client = makeClient(fetchMock);
    const result = await client.overrideRegulatoryEscalation("regesc_1", "emergency exception");
    expect(result.status).toBe("overridden");
  });
});

// ── Signal Feedback ───────────────────────────────────────────────────────────

describe("listSignalActions", () => {
  it("GETs /v1/governance/signals/:id/actions and returns actions array", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/governance/signals/sig_1/actions");
      return jsonResponse({ actions: [SIGNAL_ACTION] });
    });
    const client = makeClient(fetchMock);
    const result = await client.listSignalActions("sig_1");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("act_1");
  });

  it("returns empty array when server omits actions", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    const result = await client.listSignalActions("sig_x");
    expect(result).toEqual([]);
  });
});

describe("recordSignalAction", () => {
  it("POSTs to /v1/governance/signals/:id/actions and returns action", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/governance/signals/sig_1/actions");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.action_type).toBe("accepted");
      return jsonResponse(SIGNAL_ACTION);
    });
    const client = makeClient(fetchMock);
    const result = await client.recordSignalAction("sig_1", { action_type: "accepted" });
    expect(result.id).toBe("act_1");
    expect(result.action_type).toBe("accepted");
  });
});

describe("recordSignalOutcome", () => {
  it("POSTs to /v1/governance/signals/:id/actions/:aid/outcome and returns action", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/governance/signals/sig_1/actions/act_1/outcome");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.outcome_score).toBe(0.9);
      return jsonResponse({ ...SIGNAL_ACTION, outcome_score: 0.9 });
    });
    const client = makeClient(fetchMock);
    const result = await client.recordSignalOutcome("sig_1", "act_1", { outcome_score: 0.9 });
    expect(result.outcome_score).toBe(0.9);
  });
});

describe("getSignalActionSummary", () => {
  it("GETs /v1/governance/signals/actions/summary and returns summary", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/governance/signals/actions/summary");
      return jsonResponse(SIGNAL_SUMMARY);
    });
    const client = makeClient(fetchMock);
    const result = await client.getSignalActionSummary();
    expect(result.total_signals).toBe(10);
    expect(result.acted_on).toBe(7);
    expect(result.dismissed).toBe(3);
  });
});

// ── Cross-Org Impersonation ───────────────────────────────────────────────────

describe("listImpersonationGrants", () => {
  it("GETs /v1/cross-org/impersonation/grants and returns grants array", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/cross-org/impersonation/grants");
      return jsonResponse({ grants: [IMPERSONATION_GRANT] });
    });
    const client = makeClient(fetchMock);
    const result = await client.listImpersonationGrants();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("grant_1");
  });

  it("returns empty array when server omits grants", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);
    const result = await client.listImpersonationGrants();
    expect(result).toEqual([]);
  });
});

describe("createImpersonationGrant", () => {
  it("POSTs to /v1/cross-org/impersonation/grants and returns grant", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/cross-org/impersonation/grants");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.grantee_org_id).toBe("org_2");
      expect(body.impersonated_role).toBe("auditor");
      return jsonResponse(IMPERSONATION_GRANT);
    });
    const client = makeClient(fetchMock);
    const result = await client.createImpersonationGrant({
      grantee_org_id: "org_2",
      grantee_service_account_id: "sa_1",
      impersonated_role: "auditor",
      allowed_actions: ["read"],
      allowed_resource_types: ["executions"],
    });
    expect(result.id).toBe("grant_1");
    expect(result.impersonated_role).toBe("auditor");
  });
});

describe("revokeImpersonationGrant", () => {
  it("POSTs to /v1/cross-org/impersonation/grants/:id/revoke and returns void", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/cross-org/impersonation/grants/grant_1/revoke");
      return jsonResponse({});
    });
    const client = makeClient(fetchMock);
    const result = await client.revokeImpersonationGrant("grant_1");
    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("issueImpersonationToken", () => {
  it("POSTs to /v1/cross-org/impersonation/grants/:id/token and returns token", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/cross-org/impersonation/grants/grant_1/token");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.requested_duration_seconds).toBe(1800);
      return jsonResponse(IMPERSONATION_TOKEN);
    });
    const client = makeClient(fetchMock);
    const result = await client.issueImpersonationToken("grant_1", 1800);
    expect(result.token).toBe("imp_tok_abc123");
    expect(result.grant_id).toBe("grant_1");
  });

  it("issues token without optional duration", async () => {
    const fetchMock = mockFetch((url, init) => {
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.requested_duration_seconds).toBeUndefined();
      return jsonResponse(IMPERSONATION_TOKEN);
    });
    const client = makeClient(fetchMock);
    const result = await client.issueImpersonationToken("grant_1");
    expect(result.token).toBe("imp_tok_abc123");
  });
});

describe("validateImpersonationToken", () => {
  it("POSTs to /v1/cross-org/impersonation/validate and returns validation result", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/cross-org/impersonation/validate");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.token).toBe("imp_tok_abc123");
      return jsonResponse({
        valid: true,
        impersonated_role: "auditor",
        allowed_actions: ["read"],
        allowed_resource_types: ["executions"],
      });
    });
    const client = makeClient(fetchMock);
    const result = await client.validateImpersonationToken("imp_tok_abc123");
    expect(result.valid).toBe(true);
    expect(result.impersonated_role).toBe("auditor");
  });

  it("returns valid=false for an invalid token", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ valid: false, error: "token expired" }),
    );
    const client = makeClient(fetchMock);
    const result = await client.validateImpersonationToken("stale_tok");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("token expired");
  });
});

// ── Authority Intelligence ──────────────────────────────────────────────────

const EXPLAIN_AUTHORITY_STUB = {
  organization_id: "org_1",
  principal_id: "principal_1",
  requested_scope: "production:deployment.production.approve",
  resource_id: null,
  authority_found: true,
  paths: [
    {
      mechanism: "role_capability",
      matched: true,
      edges: [
        {
          source_table: "user_roles",
          evidence_posture: "direct",
          authority_basis: "role_grant",
          role: "deployer",
        },
      ],
    },
  ],
  unresolved: [],
};

describe("explainAuthority", () => {
  it("GETs /v1/authority-intelligence/explain-authority with all params", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/authority-intelligence/explain-authority");
      expect(url).toContain("principal_id=principal_1");
      expect(url).toContain(
        "requested_scope=production%3Adeployment.production.approve",
      );
      expect(url).toContain("resource_id=res_1");
      return jsonResponse(EXPLAIN_AUTHORITY_STUB);
    });
    const client = makeClient(fetchMock);
    const result = await client.explainAuthority({
      principalId: "principal_1",
      requestedScope: "production:deployment.production.approve",
      resourceId: "res_1",
    });
    expect(result.organization_id).toBe("org_1");
    expect(result.principal_id).toBe("principal_1");
    expect(result.authority_found).toBe(true);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.mechanism).toBe("role_capability");
    expect(result.unresolved).toEqual([]);
  });

  it("omits resource_id from the query string when not supplied", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toContain("principal_id=principal_1");
      expect(url).toContain("requested_scope=");
      expect(url).not.toContain("resource_id");
      return jsonResponse({ ...EXPLAIN_AUTHORITY_STUB, resource_id: null });
    });
    const client = makeClient(fetchMock);
    const result = await client.explainAuthority({
      principalId: "principal_1",
      requestedScope: "production:deployment.production.approve",
    });
    expect(result.resource_id).toBeNull();
  });

  it("surfaces an unresolved finding when authority is not found", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({
        ...EXPLAIN_AUTHORITY_STUB,
        authority_found: false,
        paths: [],
        unresolved: [
          {
            finding_type: "NO_AUTHORITY_PATH_FOUND",
            reason: "no matching grant, delegation, or role capability",
          },
        ],
      }),
    );
    const client = makeClient(fetchMock);
    const result = await client.explainAuthority({
      principalId: "principal_1",
      requestedScope: "production:deployment.production.approve",
    });
    expect(result.authority_found).toBe(false);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!.finding_type).toBe("NO_AUTHORITY_PATH_FOUND");
  });

  it("throws bad_request when principalId is empty", async () => {
    const fetchMock = mockFetch(() => jsonResponse(EXPLAIN_AUTHORITY_STUB));
    const client = makeClient(fetchMock);
    await expect(
      client.explainAuthority({
        principalId: "",
        requestedScope: "production:deployment.production.approve",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws bad_request when requestedScope is empty", async () => {
    const fetchMock = mockFetch(() => jsonResponse(EXPLAIN_AUTHORITY_STUB));
    const client = makeClient(fetchMock);
    await expect(
      client.explainAuthority({ principalId: "principal_1", requestedScope: "" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a non-2xx response as AtlaSentError", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse(
        { error: { message: "missing authority_intelligence:read scope" } },
        { status: 403 },
      ),
    );
    const client = makeClient(fetchMock);
    await expect(
      client.explainAuthority({
        principalId: "principal_1",
        requestedScope: "production:deployment.production.approve",
      }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
});
