import { describe, expect, it, vi, type MockedFunction } from "vitest";

import {
  AtlaSentClient,
  hitlRequiredApproverCount,
  type HitlEscalation,
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

const ESCALATION: HitlEscalation = {
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
};

describe("hitlRequiredApproverCount", () => {
  it("single_approver always returns 1", () => {
    for (const pool of [1, 2, 5, 100]) {
      expect(hitlRequiredApproverCount("single_approver", pool)).toBe(1);
    }
  });

  it("simple_majority is floor(N/2)+1", () => {
    expect(hitlRequiredApproverCount("simple_majority", 1)).toBe(1);
    expect(hitlRequiredApproverCount("simple_majority", 3)).toBe(2);
    expect(hitlRequiredApproverCount("simple_majority", 4)).toBe(3);
    expect(hitlRequiredApproverCount("simple_majority", 5)).toBe(3);
  });

  it("two_thirds is ceil(2N/3)", () => {
    expect(hitlRequiredApproverCount("two_thirds", 3)).toBe(2);
    expect(hitlRequiredApproverCount("two_thirds", 5)).toBe(4);
    expect(hitlRequiredApproverCount("two_thirds", 6)).toBe(4);
    expect(hitlRequiredApproverCount("two_thirds", 9)).toBe(6);
  });

  it("unanimous is N", () => {
    expect(hitlRequiredApproverCount("unanimous", 4)).toBe(4);
  });

  it("non-positive pool collapses to 1", () => {
    expect(hitlRequiredApproverCount("simple_majority", 0)).toBe(1);
    expect(hitlRequiredApproverCount("two_thirds", -3)).toBe(1);
  });
});

describe("AtlaSentClient HITL methods", () => {
  it("listHitlEscalations passes status filter as query param", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toContain("/v1/hitl");
      expect(url).toContain("status=pending");
      expect(url).toContain("limit=25");
      return jsonResponse({ escalations: [ESCALATION], total: 1 });
    });
    const client = makeClient(fetchMock);
    const result = await client.listHitlEscalations({
      status: "pending",
      limit: 25,
    });
    expect(result.data.escalations).toHaveLength(1);
    expect(result.data.escalations[0]!.id).toBe("esc_1");
  });

  it("getHitlEscalation hits the right path", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/hitl/esc_1");
      return jsonResponse(ESCALATION);
    });
    const client = makeClient(fetchMock);
    const result = await client.getHitlEscalation("esc_1");
    expect(result.escalation.quorum_required).toBe("two_thirds");
  });

  it("approveHitlEscalation POSTs with note body", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/hitl/esc_1/approve");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.note).toBe("looks good");
      return jsonResponse({ ...ESCALATION, status: "pending" });
    });
    const client = makeClient(fetchMock);
    await client.approveHitlEscalation("esc_1", { note: "looks good" });
  });

  it("rejectHitlEscalation hits /reject", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/hitl/esc_1/reject");
      return jsonResponse({ ...ESCALATION, status: "rejected" });
    });
    const client = makeClient(fetchMock);
    const result = await client.rejectHitlEscalation("esc_1");
    expect(result.escalation.status).toBe("rejected");
  });

  it("escalateHitlEscalation forwards to_role / reason", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(url).toContain("/v1/hitl/esc_1/escalate");
      const body = JSON.parse((init.body as string) ?? "{}");
      expect(body.to_role).toBe("security_lead");
      expect(body.reason).toBe("higher tier needed");
      return jsonResponse({ ...ESCALATION, status: "escalated" });
    });
    const client = makeClient(fetchMock);
    await client.escalateHitlEscalation("esc_1", {
      to_role: "security_lead",
      reason: "higher tier needed",
    });
  });

  it("listHitlApprovals returns the approvals array", async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({
        approvals: [
          {
            id: "vote_1",
            user_id: "user_1",
            actor_label: null,
            decision: "approve",
            note: null,
            quorum_at_vote: "two_thirds",
            created_at: "2026-05-07T01:00:00Z",
          },
        ],
      }),
    );
    const client = makeClient(fetchMock);
    const result = await client.listHitlApprovals("esc_1");
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]!.decision).toBe("approve");
  });

  it("timeoutHitlEscalation sends an empty POST body", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/hitl/esc_1/timeout");
      expect(init.body).toBe("{}");
      return jsonResponse({ ...ESCALATION, status: "timed_out" });
    });
    const client = makeClient(fetchMock);
    const result = await client.timeoutHitlEscalation("esc_1");
    expect(result.escalation.status).toBe("timed_out");
  });
});
