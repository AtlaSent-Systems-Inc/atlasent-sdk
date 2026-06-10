import { describe, expect, it, vi, type MockedFunction } from "vitest";

import { AtlaSentClient } from "../src/index.js";
import { submitEnterpriseInquiry } from "../src/enterpriseInquiry.js";

type FetchMock = MockedFunction<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  });
}

// ── submitEnterpriseInquiry ───────────────────────────────────────────────────

describe("submitEnterpriseInquiry", () => {
  it("POSTs to /v1/enterprise-inquiry and returns id + submitted_at", async () => {
    const mockResponse = { id: "inq_abc123", submitted_at: "2026-06-09T00:00:00Z" };
    const fetchMock = mockFetch(() => jsonResponse(mockResponse));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await submitEnterpriseInquiry("https://api.atlasent.io", {
      company_name: "Acme Corp",
      company_size: "201-500",
      industry: "Healthcare",
      use_cases: ["ai_agent_governance"],
      contact_name: "Jane Doe",
      contact_email: "jane@acme.com",
      deployment_posture: "saas",
    });

    expect(result.id).toBe("inq_abc123");
    expect(result.submitted_at).toBe("2026-06-09T00:00:00Z");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.atlasent.io/v1/enterprise-inquiry");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("strips trailing slash from baseUrl", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ id: "inq_1", submitted_at: "2026-06-09T00:00:00Z" }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await submitEnterpriseInquiry("https://api.atlasent.io/", {
      company_name: "Test",
      company_size: "1-10",
      industry: "Tech",
      use_cases: [],
      contact_name: "A",
      contact_email: "a@test.com",
      deployment_posture: "self_hosted",
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.atlasent.io/v1/enterprise-inquiry");
  });

  it("throws on non-OK response", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ error: "bad" }, 400));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      submitEnterpriseInquiry("https://api.atlasent.io", {
        company_name: "X",
        company_size: "1",
        industry: "Other",
        use_cases: [],
        contact_name: "A",
        contact_email: "a@x.com",
        deployment_posture: "air_gapped",
      }),
    ).rejects.toThrow(/EnterpriseInquiry POST failed \(400\)/);
  });
});

// ── AtlaSentClient — RBAC rules ───────────────────────────────────────────────

const RULE_STUB = {
  id: "rule_1",
  org_id: "org_abc",
  role: "approver",
  condition: { type: "environment", environment: "prod" },
  effect: "restrict",
  created_at: "2026-06-09T00:00:00Z",
  updated_at: "2026-06-09T00:00:00Z",
};

describe("AtlaSentClient.listRbacRules", () => {
  it("GETs /v1/rbac-rules with org_id param", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ rules: [RULE_STUB], total: 1 }),
    );
    const client = makeClient(fetchMock);

    const result = await client.listRbacRules("org_abc");

    expect(result.total).toBe(1);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.id).toBe("rule_1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/rbac-rules");
    expect(url).toContain("org_id=org_abc");
  });

  it("passes limit and offset params", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ rules: [], total: 0 }),
    );
    const client = makeClient(fetchMock);

    await client.listRbacRules("org_abc", { limit: 10, offset: 20 });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=20");
  });
});

describe("AtlaSentClient.createRbacRule", () => {
  it("POSTs to /v1/rbac-rules and returns the rule", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ rule: RULE_STUB }));
    const client = makeClient(fetchMock);

    const rule = await client.createRbacRule({
      org_id: "org_abc",
      role: "approver",
      condition: { type: "environment", environment: "prod" },
      effect: "restrict",
    });

    expect(rule.id).toBe("rule_1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/rbac-rules");
    expect((init as RequestInit).method).toBe("POST");
  });
});

describe("AtlaSentClient.deleteRbacRule", () => {
  it("DELETEs /v1/rbac-rules/{id}", async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    const client = makeClient(fetchMock);

    await client.deleteRbacRule("rule_1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/rbac-rules/rule_1");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});

// ── AtlaSentClient — Approvals SLA ───────────────────────────────────────────

const SLA_STUB = {
  pending_count: 3,
  avg_resolution_hours: 12.5,
  sla_breached_count: 1,
  on_track_count: 2,
  items: [],
};

describe("AtlaSentClient.getApprovalSla", () => {
  it("GETs /v1/approvals/sla with org_id param", async () => {
    const fetchMock = mockFetch(() => jsonResponse(SLA_STUB));
    const client = makeClient(fetchMock);

    const result = await client.getApprovalSla("org_abc");

    expect(result).toMatchObject({ pending_count: 3, sla_breached_count: 1 });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/approvals/sla");
    expect(url).toContain("org_id=org_abc");
  });

  it("passes days param", async () => {
    const fetchMock = mockFetch(() => jsonResponse(SLA_STUB));
    const client = makeClient(fetchMock);

    await client.getApprovalSla("org_abc", { days: 7 });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("days=7");
  });
});
