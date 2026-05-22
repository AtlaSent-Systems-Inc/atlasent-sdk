import { describe, expect, it, vi, type MockedFunction } from "vitest";

import {
  AtlaSentClient,
  AtlaSentError,
  highestAgentFindingSeverity,
  type GovernanceAgent,
  type GovernanceAgentEvaluation,
  type GovernanceAgentFinding,
} from "../src/index.js";

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

// ── Fixtures ─────────────────────────────────────────────────────────────────

function agent(over: Partial<GovernanceAgent> = {}): GovernanceAgent {
  return {
    slug: "migration_review",
    version: "v1",
    name: "Migration Review",
    description: "SQL static analysis",
    applicable_subject_kinds: ["pull_request", "schema_migration"],
    authority_class: "advisory",
    can_authorize: false,
    capabilities: ["rls_coverage", "destructive_op"],
    is_active: true,
    created_at: "2026-05-20T00:00:00Z",
    retired_at: null,
    ...over,
  };
}

function finding(over: Partial<GovernanceAgentFinding> = {}): GovernanceAgentFinding {
  return {
    id: "f-1",
    org_id: "org-1",
    evaluation_id: "e-1",
    change_id: "c-1",
    agent_slug: "migration_review",
    agent_version: "v1",
    finding_type: "rls_missing_policy",
    severity: "blocker",
    confidence: 0.9,
    summary: "RLS enabled without policies",
    evidence_refs: [{ kind: "file", ref: "m.sql:L10" }],
    required_authority: "security",
    recommended_action: "Add SELECT policy",
    can_authorize: false,
    supersedes_finding_id: null,
    payload: {},
    created_at: "2026-05-22T07:00:00Z",
    routed_gate_id: null,
    ...over,
  };
}

function evaluation(
  over: Partial<GovernanceAgentEvaluation> = {},
): GovernanceAgentEvaluation {
  return {
    id: "e-1",
    org_id: "org-1",
    change_id: "c-1",
    agent_slug: "migration_review",
    agent_version: "v1",
    input_hash: "sha256:abc",
    status: "completed",
    highest_severity: "blocker",
    findings_count: 1,
    summary: "1 finding",
    runtime_ms: 12,
    failure_reason: null,
    invoked_by_kind: "service_account",
    invoked_by: "github-action",
    started_at: "2026-05-22T07:00:00Z",
    completed_at: "2026-05-22T07:00:01Z",
    ...over,
  };
}

// ─── highestAgentFindingSeverity ────────────────────────────────────────────

describe("highestAgentFindingSeverity", () => {
  it("returns null on empty input", () => {
    expect(highestAgentFindingSeverity([])).toBeNull();
  });

  it("picks blocker over high over medium", () => {
    expect(
      highestAgentFindingSeverity([
        { severity: "medium" },
        { severity: "blocker" },
        { severity: "high" },
      ]),
    ).toBe("blocker");
  });

  it("returns info when all findings are info", () => {
    expect(
      highestAgentFindingSeverity([
        { severity: "info" },
        { severity: "info" },
      ]),
    ).toBe("info");
  });
});

// ─── listGovernanceAgents ───────────────────────────────────────────────────

describe("listGovernanceAgents", () => {
  it("calls GET /v1/governance/agents and returns the agents array", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toContain("/v1/governance/agents");
      return jsonResponse({ agents: [agent(), agent({ slug: "authority_boundary" })] });
    });
    const client = makeClient(fetchImpl);
    const out = await client.listGovernanceAgents();
    expect(out).toHaveLength(2);
    expect(out[0]!.authority_class).toBe("advisory");
    expect(out[0]!.can_authorize).toBe(false);
  });

  it("returns [] when the server returns an empty list", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ agents: [] }));
    expect(await makeClient(fetchImpl).listGovernanceAgents()).toEqual([]);
  });

  it("sends Authorization: Bearer <apiKey>", async () => {
    const fetchImpl = mockFetch((_url, init) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer ask_live_test");
      return jsonResponse({ agents: [] });
    });
    await makeClient(fetchImpl).listGovernanceAgents();
  });
});

// ─── listGovernanceFindings ─────────────────────────────────────────────────

describe("listGovernanceFindings", () => {
  it("requires change_id", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ findings: [] }));
    await expect(
      makeClient(fetchImpl).listGovernanceFindings({ change_id: "" }),
    ).rejects.toBeInstanceOf(AtlaSentError);
  });

  it("includes change_id in the query string", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toContain("change_id=c-1");
      return jsonResponse({ findings: [finding()] });
    });
    const out = await makeClient(fetchImpl).listGovernanceFindings({
      change_id: "c-1",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.can_authorize).toBe(false);
  });

  it("includes agent_slug filter when supplied", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toContain("change_id=c-1");
      expect(url).toContain("agent_slug=migration_review");
      return jsonResponse({ findings: [] });
    });
    await makeClient(fetchImpl).listGovernanceFindings({
      change_id: "c-1",
      agent_slug: "migration_review",
    });
  });

  it("returns the wire severity verbatim (no client-side translation)", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        findings: [
          finding({ severity: "blocker" }),
          finding({ id: "f-2", severity: "info" }),
        ],
      }),
    );
    const out = await makeClient(fetchImpl).listGovernanceFindings({
      change_id: "c-1",
    });
    expect(out.map((f) => f.severity)).toEqual(["blocker", "info"]);
  });
});

// ─── listGovernanceEvaluations ──────────────────────────────────────────────

describe("listGovernanceEvaluations", () => {
  it("requires change_id", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ evaluations: [] }));
    await expect(
      makeClient(fetchImpl).listGovernanceEvaluations({ change_id: "" }),
    ).rejects.toBeInstanceOf(AtlaSentError);
  });

  it("includes change_id and optional agent_slug in the query string", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toContain("change_id=c-1");
      expect(url).toContain("agent_slug=migration_review");
      return jsonResponse({
        evaluations: [evaluation()],
      });
    });
    const out = await makeClient(fetchImpl).listGovernanceEvaluations({
      change_id: "c-1",
      agent_slug: "migration_review",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("completed");
    expect(out[0]!.findings_count).toBe(1);
  });

  it("includes failed and timeout terminal statuses verbatim", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        evaluations: [
          evaluation({ id: "e-1", status: "failed", failure_reason: "boom" }),
          evaluation({ id: "e-2", status: "timeout" }),
          evaluation({ id: "e-3", status: "completed", findings_count: 0 }),
        ],
      }),
    );
    const out = await makeClient(fetchImpl).listGovernanceEvaluations({
      change_id: "c-1",
    });
    expect(out.map((e) => e.status)).toEqual(["failed", "timeout", "completed"]);
  });
});

// ─── doctrine surface checks (structural type assertions) ───────────────────

describe("structural invariants", () => {
  it("GovernanceAgent.can_authorize is the literal false at the type level", () => {
    // Compile-time test: the const below typechecks only because
    // can_authorize is `false` (not `boolean`) on the wire type.
    const a = agent();
    const ca: false = a.can_authorize;
    expect(ca).toBe(false);
  });

  it("GovernanceAgentFinding.can_authorize is the literal false at the type level", () => {
    const f = finding();
    const ca: false = f.can_authorize;
    expect(ca).toBe(false);
  });
});
