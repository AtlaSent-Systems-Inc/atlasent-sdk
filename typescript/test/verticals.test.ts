import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { protectPaymentRelease } from "../src/verticals/paymentRelease.js";
import { protectCloseAction } from "../src/verticals/closeGovernance.js";
import { protectDeploy } from "../src/verticals/deployGate.js";
import { protectToolCall, classifyToolRisk } from "../src/verticals/agentTools.js";
import { configure, __resetSharedClientForTests } from "../src/protect.js";
import { configureApprovalRuntime } from "../src/approvalRuntime.js";

// ── Shared wire shapes ─────────────────────────────────────────────────────────

const EVALUATE_ALLOW_WIRE = {
  permitted: true,
  decision_id: "dec_ok",
  reason: "Policy allowed",
  audit_hash: "ah_ok",
  timestamp: "2026-01-01T00:00:00Z",
};

const VERIFY_OK_WIRE = {
  verified: true,
  outcome: "verified",
  permit_hash: "ph_ok",
  timestamp: "2026-01-01T00:00:01Z",
};

// Canonical v2 hold wire — must carry `decision: "hold"` (not the legacy
// `permitted: false` which maps to "deny") so protectOrEscalate branches correctly.
const EVALUATE_HOLD_WIRE = {
  decision: "hold",
  permit_token: "dec_hold",
  reason: "Policy hold — awaiting approval",
  audit_hash: "ah_hold",
  timestamp: "2026-01-01T00:00:00Z",
};

const HITL_ESCALATION_BASE = {
  id: "escl_v",
  org_id: "org_1",
  agent_id: "agent_1",
  sandbox_run_id: null,
  status: "pending",
  escalation_reason: "test",
  proposed_action: null,
  risk_score: null,
  assigned_to_user_id: null,
  assigned_to_role: "approver",
  resolved_by: null,
  resolution_note: null,
  auto_approved_reason: null,
  resolved_at: null,
  timeout_at: null,
  created_at: "2026-01-01T00:00:00Z",
  quorum_required: "single_approver",
  min_approvers: 1,
  approver_pool_size: 1,
  escalation_depth: 0,
  max_escalation_depth: 3,
  fallback_decision: "reject",
  governance_advisory_id: null,
  expired_reason: null,
  metadata: null,
};

const HITL_APPROVED = {
  ...HITL_ESCALATION_BASE,
  status: "approved",
  resolved_by: "approver",
  resolution_note: "approved",
  resolved_at: "2026-01-01T01:00:00Z",
};

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetchSequence(responses: Response[]) {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("mock fetch queue exhausted");
    return next;
  });
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  __resetSharedClientForTests();
  process.env["ATLASENT_API_KEY"] = "ask_test_verticals";
  configureApprovalRuntime({ apiKey: "ask_test_verticals", baseUrl: "https://api.atlasent.io" });
});

afterEach(() => {
  __resetSharedClientForTests();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  delete process.env["ATLASENT_API_KEY"];
  // Clean up CI env vars that some tests set
  delete process.env["GITHUB_ACTOR"];
  delete process.env["GITHUB_SHA"];
  delete process.env["GITHUB_WORKFLOW"];
});

// ── classifyToolRisk ──────────────────────────────────────────────────────────

describe("classifyToolRisk()", () => {
  it("returns critical for bash", () => {
    expect(classifyToolRisk("bash")).toBe("critical");
  });

  it("returns critical for shell", () => {
    expect(classifyToolRisk("shell")).toBe("critical");
  });

  it("returns critical for exec", () => {
    expect(classifyToolRisk("exec")).toBe("critical");
  });

  it("returns critical for deploy", () => {
    expect(classifyToolRisk("deploy")).toBe("critical");
  });

  it("returns critical for make_payment", () => {
    expect(classifyToolRisk("make_payment")).toBe("critical");
  });

  it("returns critical for delete_user", () => {
    expect(classifyToolRisk("delete_user")).toBe("critical");
  });

  it("returns high for sql_execute", () => {
    expect(classifyToolRisk("sql_execute")).toBe("high");
  });

  it("returns high for write_file", () => {
    expect(classifyToolRisk("write_file")).toBe("high");
  });

  it("returns high for send_email", () => {
    expect(classifyToolRisk("send_email")).toBe("high");
  });

  it("returns high for create_pr", () => {
    expect(classifyToolRisk("create_pr")).toBe("high");
  });

  it("returns medium for tool name containing 'create' (not in known sets)", () => {
    expect(classifyToolRisk("create_widget")).toBe("medium");
  });

  it("returns medium for tool name containing 'update'", () => {
    expect(classifyToolRisk("update_record")).toBe("medium");
  });

  it("returns medium for tool name containing 'write' (not in HIGH set)", () => {
    // "write_note" is not in HIGH_RISK_TOOLS, but contains "write" → medium
    expect(classifyToolRisk("write_note")).toBe("medium");
  });

  it("returns low for completely unknown tool", () => {
    expect(classifyToolRisk("unknown_tool")).toBe("low");
  });

  it("returns low for a benign read-only tool", () => {
    expect(classifyToolRisk("read_file")).toBe("low");
  });

  it("normalises case and special chars before classifying", () => {
    // "BASH" → "bash" → critical
    expect(classifyToolRisk("BASH")).toBe("critical");
    // "sql-execute" → "sql_execute" → high
    expect(classifyToolRisk("sql-execute")).toBe("high");
  });
});

// ── protectPaymentRelease ─────────────────────────────────────────────────────

describe("protectPaymentRelease()", () => {
  it("throws TypeError for non-3-letter currency code", async () => {
    await expect(
      protectPaymentRelease({
        amount: 100,
        currency: "US",
        vendorId: "v1",
        authorizedBy: "user1",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("throws TypeError for lowercase currency code", async () => {
    await expect(
      protectPaymentRelease({
        amount: 100,
        currency: "usd",
        vendorId: "v1",
        authorizedBy: "user1",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("throws TypeError for 4-letter currency code", async () => {
    await expect(
      protectPaymentRelease({
        amount: 100,
        currency: "USDD",
        vendorId: "v1",
        authorizedBy: "user1",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("throws RangeError when amount is 0", async () => {
    await expect(
      protectPaymentRelease({
        amount: 0,
        currency: "USD",
        vendorId: "v1",
        authorizedBy: "user1",
      }),
    ).rejects.toThrow(RangeError);
  });

  it("throws RangeError when amount is negative", async () => {
    await expect(
      protectPaymentRelease({
        amount: -500,
        currency: "USD",
        vendorId: "v1",
        authorizedBy: "user1",
      }),
    ).rejects.toThrow(RangeError);
  });

  it("calls protect() (not protectOrEscalate) for amount below escalation threshold", async () => {
    const fetchImpl = makeFetchSequence([
      jsonOk(EVALUATE_ALLOW_WIRE),
      jsonOk(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_test_verticals", fetch: fetchImpl as unknown as typeof fetch });

    const result = await protectPaymentRelease({
      amount: 500,
      currency: "USD",
      vendorId: "v1",
      vendorName: "Acme",
      authorizedBy: "user1",
    });

    expect(result).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2); // evaluate + verify (no hitl)
  });

  it("calls protectOrEscalate for amount above default threshold (10000)", async () => {
    // protect() will see a hold → creates escalation
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    globalThis.fetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await protectPaymentRelease({
      amount: 15_000,
      currency: "EUR",
      vendorId: "v2",
      authorizedBy: "user2",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectPaymentRelease>[0] & { pollIntervalMs?: number; waitMs?: number });

    expect(result).toBeDefined();
  });

  it("uses quorumRequired=simple_majority above dual threshold (100000)", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await protectPaymentRelease({
      amount: 150_000,
      currency: "GBP",
      vendorId: "v3",
      authorizedBy: "user3",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectPaymentRelease>[0] & { pollIntervalMs?: number; waitMs?: number });

    const hitlCall = hitlFetch.mock.calls.find(([u]) => u.toString().includes("/v1/hitl"));
    expect(hitlCall).toBeDefined();
    const body = JSON.parse(((hitlCall as unknown as [string, RequestInit])[1]).body as string);
    expect(body.quorum_required).toBe("simple_majority");
  });

  it("uses quorumRequired=single_approver between thresholds", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await protectPaymentRelease({
      amount: 50_000,
      currency: "USD",
      vendorId: "v4",
      authorizedBy: "user4",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectPaymentRelease>[0] & { pollIntervalMs?: number; waitMs?: number });

    const hitlCall = hitlFetch.mock.calls.find(([u]) => u.toString().includes("/v1/hitl"));
    const body = JSON.parse(((hitlCall as unknown as [string, RequestInit])[1]).body as string);
    expect(body.quorum_required).toBe("single_approver");
  });

  it("accepts a custom autoEscalateAbove threshold", async () => {
    // With autoEscalateAbove=1000, amount=1500 should escalate.
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    globalThis.fetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await protectPaymentRelease({
      amount: 1_500,
      currency: "USD",
      vendorId: "v5",
      authorizedBy: "user5",
      autoEscalateAbove: 1_000,
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectPaymentRelease>[0] & { pollIntervalMs?: number; waitMs?: number });

    expect(result).toBeDefined();
  });
});

// ── protectCloseAction ────────────────────────────────────────────────────────

describe("protectCloseAction()", () => {
  it("calls protectOrEscalate for period.close (always escalates)", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    const result = await protectCloseAction({
      action: "period.close",
      periodLabel: "2026-Q1",
      closedBy: "controller",
      entityId: "entity_1",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectCloseAction>[0] & { pollIntervalMs?: number; waitMs?: number });

    expect(result).toBeDefined();
    expect(hitlFetch).toHaveBeenCalled();
  });

  it("uses quorumRequired=simple_majority for period.close by default", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await protectCloseAction({
      action: "period.close",
      periodLabel: "2026-Q1",
      closedBy: "controller",
      entityId: "entity_1",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectCloseAction>[0] & { pollIntervalMs?: number; waitMs?: number });

    const hitlCall = hitlFetch.mock.calls.find(([u]) => u.toString().includes("/v1/hitl"));
    const body = JSON.parse(((hitlCall as unknown as [string, RequestInit])[1]).body as string);
    expect(body.quorum_required).toBe("simple_majority");
  });

  it("uses quorumRequired=single_approver for reconciliation.lock without requireDualApproval", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await protectCloseAction({
      action: "reconciliation.lock",
      periodLabel: "2026-Q1",
      closedBy: "controller",
      entityId: "entity_1",
      requireDualApproval: false,
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectCloseAction>[0] & { pollIntervalMs?: number; waitMs?: number });

    const hitlCall = hitlFetch.mock.calls.find(([u]) => u.toString().includes("/v1/hitl"));
    const body = JSON.parse(((hitlCall as unknown as [string, RequestInit])[1]).body as string);
    expect(body.quorum_required).toBe("single_approver");
  });

  it("uses quorumRequired=simple_majority when requireDualApproval=true for reconciliation.lock", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await protectCloseAction({
      action: "reconciliation.lock",
      periodLabel: "2026-Q1",
      closedBy: "controller",
      entityId: "entity_1",
      requireDualApproval: true,
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectCloseAction>[0] & { pollIntervalMs?: number; waitMs?: number });

    const hitlCall = hitlFetch.mock.calls.find(([u]) => u.toString().includes("/v1/hitl"));
    const body = JSON.parse(((hitlCall as unknown as [string, RequestInit])[1]).body as string);
    expect(body.quorum_required).toBe("simple_majority");
  });

  it("calls protectOrEscalate for reconciliation.certify", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    globalThis.fetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await protectCloseAction({
      action: "reconciliation.certify",
      periodLabel: "2026-Q1",
      closedBy: "controller",
      entityId: "entity_1",
      waitMs: 5_000,
    });

    expect(result).toBeDefined();
  });

  it("uses default assignedToRole of 'controller'", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await protectCloseAction({
      action: "period.close",
      periodLabel: "2026-Q1",
      closedBy: "user",
      entityId: "entity_1",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectCloseAction>[0] & { pollIntervalMs?: number; waitMs?: number });

    const hitlCall = hitlFetch.mock.calls.find(([u]) => u.toString().includes("/v1/hitl"));
    const body = JSON.parse(((hitlCall as unknown as [string, RequestInit])[1]).body as string);
    expect(body.assigned_to_role).toBe("controller");
  });
});

// ── protectDeploy ─────────────────────────────────────────────────────────────

describe("protectDeploy()", () => {
  it("calls protectOrEscalate for production environment", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    const result = await protectDeploy({
      service: "api-server",
      environment: "production",
      actorId: "ci-bot",
      sha: "abc1234",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectDeploy>[0] & { pollIntervalMs?: number; waitMs?: number });

    expect(result).toBeDefined();
    expect(hitlFetch).toHaveBeenCalled();
  });

  it("calls protect() (not protectOrEscalate) for staging without requireApproval", async () => {
    const fetchImpl = makeFetchSequence([
      jsonOk(EVALUATE_ALLOW_WIRE),
      jsonOk(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_test_verticals", fetch: fetchImpl as unknown as typeof fetch });

    // globalThis.fetch should NOT be called (no hitl)
    const hitlFetch = vi.fn();
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    const result = await protectDeploy({
      service: "api-server",
      environment: "staging",
      actorId: "ci-bot",
    });

    expect(result).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(hitlFetch).not.toHaveBeenCalled();
  });

  it("calls protectOrEscalate for non-production when requireApproval=true", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    const result = await protectDeploy({
      service: "api-server",
      environment: "staging",
      actorId: "ci-bot",
      requireApproval: true,
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectDeploy>[0] & { pollIntervalMs?: number; waitMs?: number });

    expect(result).toBeDefined();
    expect(hitlFetch).toHaveBeenCalled();
  });

  it("reads actorId from GITHUB_ACTOR env var when not provided", async () => {
    process.env["GITHUB_ACTOR"] = "git-actor";
    process.env["GITHUB_SHA"] = "sha123";
    process.env["GITHUB_WORKFLOW"] = "ci-workflow";

    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await protectDeploy({
      service: "my-service",
      // no actorId, sha, or workflow — should come from env
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectDeploy>[0] & { pollIntervalMs?: number; waitMs?: number });

    const hitlCall = hitlFetch.mock.calls.find(([u]) => u.toString().includes("/v1/hitl"));
    const body = JSON.parse(((hitlCall as unknown as [string, RequestInit])[1]).body as string);
    // agent_id should be the env actor
    expect(body.agent_id).toBe("git-actor");
  });

  it("falls back to ci-system when no actorId or env var", async () => {
    // Ensure no CI env vars are set
    delete process.env["GITHUB_ACTOR"];
    delete process.env["GITLAB_USER_LOGIN"];
    delete process.env["CIRCLE_USERNAME"];

    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await protectDeploy({
      service: "my-service",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectDeploy>[0] & { pollIntervalMs?: number; waitMs?: number });

    const hitlCall = hitlFetch.mock.calls.find(([u]) => u.toString().includes("/v1/hitl"));
    const body = JSON.parse(((hitlCall as unknown as [string, RequestInit])[1]).body as string);
    expect(body.agent_id).toBe("ci-system");
  });

  it("defaults environment to production", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    // No environment provided → should default to "production" → should escalate
    await protectDeploy({
      service: "my-service",
      actorId: "ci-bot",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectDeploy>[0] & { pollIntervalMs?: number; waitMs?: number });

    // hitlFetch was called → escalation path was taken (production default)
    expect(hitlFetch).toHaveBeenCalled();
  });

  it("uses default assignedToRole of 'release-manager'", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await protectDeploy({
      service: "my-service",
      environment: "production",
      actorId: "ci-bot",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectDeploy>[0] & { pollIntervalMs?: number; waitMs?: number });

    const hitlCall = hitlFetch.mock.calls.find(([u]) => u.toString().includes("/v1/hitl"));
    const body = JSON.parse(((hitlCall as unknown as [string, RequestInit])[1]).body as string);
    expect(body.assigned_to_role).toBe("release-manager");
  });

  it("calls notifySlackWebhook when set and deploy is denied", async () => {
    const denyFetch = makeFetchSequence([
      jsonOk({ permitted: false, reason: "unauthorized actor", audit_hash: "ah_deny", timestamp: "2026-01-01T00:00:00Z" }),
    ]);
    configure({ apiKey: "ask_test_verticals", fetch: denyFetch as unknown as typeof fetch });

    const webhookUrl = "https://hooks.slack.com/services/test-webhook";
    const slackFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = slackFetch as unknown as typeof globalThis.fetch;

    await expect(
      protectDeploy({
        service: "api-server",
        environment: "staging",
        actorId: "ci-bot",
        notifySlackWebhook: webhookUrl,
      }),
    ).rejects.toThrow();

    expect(slackFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = slackFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(webhookUrl);
    const payload = JSON.parse(calledInit.body as string);
    expect(payload.text).toContain("DENIED");
  });

  it("swallows notifySlackWebhook fetch errors and re-throws original deny", async () => {
    const denyFetch = makeFetchSequence([
      jsonOk({ permitted: false, reason: "unauthorized actor", audit_hash: "ah_deny", timestamp: "2026-01-01T00:00:00Z" }),
    ]);
    configure({ apiKey: "ask_test_verticals", fetch: denyFetch as unknown as typeof fetch });

    const webhookUrl = "https://hooks.slack.com/services/test-webhook";
    const slackFetch = vi.fn().mockRejectedValue(new Error("slack network error"));
    globalThis.fetch = slackFetch as unknown as typeof globalThis.fetch;

    // original denial error re-thrown, not the Slack network error
    await expect(
      protectDeploy({
        service: "api-server",
        environment: "staging",
        actorId: "ci-bot",
        notifySlackWebhook: webhookUrl,
      }),
    ).rejects.not.toThrow("slack network error");
  });

  it("does not call globalThis.fetch when notifySlackWebhook is unset and deploy is denied", async () => {
    const denyFetch = makeFetchSequence([
      jsonOk({ permitted: false, reason: "unauthorized actor", audit_hash: "ah_deny", timestamp: "2026-01-01T00:00:00Z" }),
    ]);
    configure({ apiKey: "ask_test_verticals", fetch: denyFetch as unknown as typeof fetch });

    const slackFetch = vi.fn();
    globalThis.fetch = slackFetch as unknown as typeof globalThis.fetch;

    await expect(
      protectDeploy({ service: "api-server", environment: "staging", actorId: "ci-bot" }),
    ).rejects.toThrow();

    expect(slackFetch).not.toHaveBeenCalled();
  });
});

// ── protectToolCall ────────────────────────────────────────────────────────────

describe("protectToolCall()", () => {
  it("mode=observe → calls protectShadow, returns ShadowOutcome", async () => {
    const fetchImpl = makeFetchSequence([
      jsonOk(EVALUATE_ALLOW_WIRE),
      jsonOk(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_test_verticals", fetch: fetchImpl as unknown as typeof fetch });

    const result = await protectToolCall({
      toolName: "read_file",
      toolArgs: { path: "/tmp/file.txt" },
      agentId: "my-agent",
      mode: "observe",
    });

    // ShadowOutcome has `decision`, `permit`, `would_have_blocked`, etc.
    expect(result).toHaveProperty("decision");
    expect(result).toHaveProperty("would_have_blocked");
    expect((result as { mode: string }).mode).toBe("observe");
  });

  it("mode=escalate with critical tool → calls protectOrEscalate", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    globalThis.fetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await protectToolCall({
      toolName: "bash",
      toolArgs: { command: "ls -la" },
      agentId: "my-agent",
      mode: "escalate",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectToolCall>[0] & { pollIntervalMs?: number; waitMs?: number });

    // ApprovalPermit has approvalBasis
    expect(result).toHaveProperty("approvalBasis");
  });

  it("mode=enforce with low-risk tool → calls protect() directly", async () => {
    const fetchImpl = makeFetchSequence([
      jsonOk(EVALUATE_ALLOW_WIRE),
      jsonOk(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_test_verticals", fetch: fetchImpl as unknown as typeof fetch });

    const hitlFetch = vi.fn();
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    const result = await protectToolCall({
      toolName: "read_file",
      toolArgs: { path: "/tmp/file.txt" },
      agentId: "my-agent",
      mode: "enforce",
    });

    // Permit has permitId, permitHash etc. — no escalation fields
    expect(result).toHaveProperty("permitId");
    expect(hitlFetch).not.toHaveBeenCalled();
  });

  it("critical tool without mode defaults to escalate mode", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    // bash is critical → mode defaults to "escalate"
    const result = await protectToolCall({
      toolName: "bash",
      toolArgs: { command: "rm -rf /" },
      agentId: "my-agent",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectToolCall>[0] & { pollIntervalMs?: number; waitMs?: number });

    expect(hitlFetch).toHaveBeenCalled();
    expect(result).toHaveProperty("approvalBasis");
  });

  it("low-risk tool without mode defaults to enforce mode", async () => {
    const fetchImpl = makeFetchSequence([
      jsonOk(EVALUATE_ALLOW_WIRE),
      jsonOk(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_test_verticals", fetch: fetchImpl as unknown as typeof fetch });

    const hitlFetch = vi.fn();
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    // "search_docs" has no mode and is low risk → enforce
    const result = await protectToolCall({
      toolName: "search_docs",
      toolArgs: { query: "how to" },
      agentId: "my-agent",
    });

    expect(result).toHaveProperty("permitId");
    expect(hitlFetch).not.toHaveBeenCalled();
  });

  it("passes sessionId into context when provided", async () => {
    const fetchImpl = makeFetchSequence([
      jsonOk(EVALUATE_ALLOW_WIRE),
      jsonOk(VERIFY_OK_WIRE),
    ]);
    const captureFetch = vi.fn(async (...args: Parameters<typeof fetch>) =>
      (fetchImpl as unknown as typeof fetch)(...args),
    );
    configure({ apiKey: "ask_test_verticals", fetch: captureFetch });

    await protectToolCall({
      toolName: "read_file",
      toolArgs: {},
      agentId: "agent-1",
      sessionId: "sess-42",
      mode: "enforce",
    });

    // The evaluate request body should contain the session_id somewhere in context
    const [, init] = captureFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // flattenActionContext puts extra fields at the top level of context
    expect(JSON.stringify(body)).toContain("sess-42");
  });

  it("uses default assignedToRole of agent-supervisor for escalated tool calls", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await protectToolCall({
      toolName: "bash",
      toolArgs: {},
      agentId: "agent-1",
      mode: "escalate",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectToolCall>[0] & { pollIntervalMs?: number; waitMs?: number });

    const hitlCall = hitlFetch.mock.calls.find(([u]) => u.toString().includes("/v1/hitl"));
    const body = JSON.parse(((hitlCall as unknown as [string, RequestInit])[1]).body as string);
    expect(body.assigned_to_role).toBe("agent-supervisor");
  });

  it("uses riskScore=1.0 for critical tools", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_verticals", fetch: protectFetch as unknown as typeof fetch });

    const hitlFetch = vi.fn(async (input: string | URL | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) return jsonOk(HITL_APPROVED);
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await protectToolCall({
      toolName: "bash",
      toolArgs: {},
      agentId: "agent-1",
      mode: "escalate",
      pollIntervalMs: 10,
      waitMs: 5_000,
    } as Parameters<typeof protectToolCall>[0] & { pollIntervalMs?: number; waitMs?: number });

    const hitlCall = hitlFetch.mock.calls.find(([u]) => u.toString().includes("/v1/hitl"));
    const body = JSON.parse(((hitlCall as unknown as [string, RequestInit])[1]).body as string);
    expect(body.risk_score).toBe(1.0);
  });
});
