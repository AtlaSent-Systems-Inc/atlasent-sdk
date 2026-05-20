import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  configureApprovalRuntime,
  createEscalation,
  waitForEscalationApproval,
  protectOrEscalate,
  requestOverride,
  EscalationDeniedError,
  EscalationTimeoutError,
} from "../src/approvalRuntime.js";
import { AtlaSentDeniedError, AtlaSentError } from "../src/errors.js";
import { configure, __resetSharedClientForTests } from "../src/protect.js";

// ── Wire shapes ────────────────────────────────────────────────────────────────

const EVALUATE_ALLOW_WIRE = {
  permitted: true,
  decision_id: "dec_1",
  reason: "Policy allowed",
  audit_hash: "audit_1",
  timestamp: "2026-01-01T00:00:00Z",
};

// Use canonical v2 wire format for hold so the client doesn't map it to "deny".
// The legacy `permitted: false` path maps to decision="deny"; we need `decision: "hold"`.
const EVALUATE_HOLD_WIRE = {
  decision: "hold",
  permit_token: "dec_hold",
  reason: "Hold pending approval",
  audit_hash: "audit_hold",
  timestamp: "2026-01-01T00:00:00Z",
};

const VERIFY_OK_WIRE = {
  verified: true,
  outcome: "verified",
  permit_hash: "ph_1",
  timestamp: "2026-01-01T00:00:01Z",
};

const HITL_ESCALATION_BASE = {
  id: "escl_1",
  org_id: "org_1",
  agent_id: "agent_1",
  sandbox_run_id: null,
  escalation_reason: "Policy hold — awaiting human approval",
  proposed_action: null,
  risk_score: null,
  assigned_to_user_id: null,
  assigned_to_role: "manager",
  resolved_by: null,
  resolution_note: null,
  auto_approved_reason: null,
  resolved_at: null,
  timeout_at: null,
  created_at: "2026-01-01T00:00:00Z",
  quorum_required: "single_approver" as const,
  min_approvers: 1,
  approver_pool_size: 1,
  escalation_depth: 0,
  max_escalation_depth: 3,
  fallback_decision: "reject" as const,
  governance_advisory_id: null,
  expired_reason: null,
  metadata: null,
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
  process.env["ATLASENT_API_KEY"] = "ask_test_approval_runtime";
  configureApprovalRuntime({ apiKey: "ask_test_approval_runtime", baseUrl: "https://api.atlasent.io" });
});

afterEach(() => {
  __resetSharedClientForTests();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  delete process.env["ATLASENT_API_KEY"];
});

// ── configureApprovalRuntime ───────────────────────────────────────────────────

describe("configureApprovalRuntime()", () => {
  it("merges subsequent calls rather than replacing", async () => {
    configureApprovalRuntime({ apiKey: "ask_test_first_key" });
    configureApprovalRuntime({ baseUrl: "https://api.atlasent.io" });

    // If apiKey was discarded we'd get an error on the next call — success
    // means the merge kept it.
    globalThis.fetch = vi.fn(async () =>
      jsonOk({ ...HITL_ESCALATION_BASE }),
    ) as unknown as typeof globalThis.fetch;

    const handle = await createEscalation({ agent_id: "a", escalation_reason: "test" });
    expect(handle.escalationId).toBe("escl_1");
  });
});

// ── createEscalation ──────────────────────────────────────────────────────────

describe("createEscalation()", () => {
  it("returns EscalationHandle from POST /v1/hitl", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonOk({ ...HITL_ESCALATION_BASE }),
    ) as unknown as typeof globalThis.fetch;

    const handle = await createEscalation({
      agent_id: "agent_1",
      escalation_reason: "Review required",
    });

    expect(handle.escalationId).toBe("escl_1");
    expect(handle.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(handle.timeoutAt).toBeNull();
    expect(handle.assignedToRole).toBe("manager");
  });

  it("POSTs to the correct URL with Bearer auth", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonOk({ ...HITL_ESCALATION_BASE }),
    ) as unknown as typeof globalThis.fetch;
    globalThis.fetch = fetchSpy;

    await createEscalation({ agent_id: "bot", escalation_reason: "needs review" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/hitl");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ask_test_approval_runtime");
    expect(init.method).toBe("POST");
  });

  it("throws AtlaSentError when an empty API key is supplied", async () => {
    // resolveConfig: `overrides?.apiKey ?? _runtimeConfig.apiKey ?? env`.
    // Passing apiKey="" selects it via ?? (empty string is not null/undefined),
    // then the `!apiKey` guard fires because "" is falsy — throws AtlaSentError.
    await expect(
      createEscalation({ apiKey: "", agent_id: "a", escalation_reason: "r" }),
    ).rejects.toThrow(AtlaSentError);
  });

  it("includes optional fields in the POST body", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonOk({ ...HITL_ESCALATION_BASE }),
    ) as unknown as typeof globalThis.fetch;
    globalThis.fetch = fetchSpy;

    await createEscalation({
      agent_id: "bot",
      escalation_reason: "test",
      risk_score: 0.9,
      assigned_to_role: "admin",
      quorum_required: "simple_majority",
    });

    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.risk_score).toBe(0.9);
    expect(body.assigned_to_role).toBe("admin");
    expect(body.quorum_required).toBe("simple_majority");
  });

  it("returns null timeoutAt when timeout_at is absent", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonOk({ ...HITL_ESCALATION_BASE, timeout_at: null }),
    ) as unknown as typeof globalThis.fetch;

    const handle = await createEscalation({ agent_id: "a", escalation_reason: "r" });
    expect(handle.timeoutAt).toBeNull();
  });

  it("propagates timeout_at from the response", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonOk({ ...HITL_ESCALATION_BASE, timeout_at: "2026-06-01T00:00:00Z" }),
    ) as unknown as typeof globalThis.fetch;

    const handle = await createEscalation({ agent_id: "a", escalation_reason: "r" });
    expect(handle.timeoutAt).toBe("2026-06-01T00:00:00Z");
  });

  it("throws AtlaSentError on 401 response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("Unauthorized", { status: 401 }),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      createEscalation({ agent_id: "a", escalation_reason: "r" }),
    ).rejects.toThrow(AtlaSentError);
  });
});

// ── waitForEscalationApproval ─────────────────────────────────────────────────

describe("waitForEscalationApproval()", () => {
  it("returns EscalationOutcome with status=approved immediately", async () => {
    const resolved = {
      ...HITL_ESCALATION_BASE,
      status: "approved" as const,
      resolved_by: "admin",
      resolution_note: "ok",
      resolved_at: "2026-01-01T01:00:00Z",
    };

    globalThis.fetch = vi.fn(async () => jsonOk(resolved)) as unknown as typeof globalThis.fetch;

    const outcome = await waitForEscalationApproval({
      escalationId: "escl_1",
      pollIntervalMs: 10,
      waitMs: 5_000,
    });

    expect(outcome.status).toBe("approved");
    expect(outcome.resolvedBy).toBe("admin");
    expect(outcome.resolutionNote).toBe("ok");
    expect(outcome.resolvedAt).toBe("2026-01-01T01:00:00Z");
    expect(outcome.escalation.id).toBe("escl_1");
  });

  it("returns outcome with status=rejected for rejected escalation", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonOk({
        ...HITL_ESCALATION_BASE,
        status: "rejected",
        resolved_by: "reviewer",
        resolution_note: "not approved",
        resolved_at: "2026-01-01T02:00:00Z",
      }),
    ) as unknown as typeof globalThis.fetch;

    const outcome = await waitForEscalationApproval({
      escalationId: "escl_1",
      pollIntervalMs: 10,
      waitMs: 5_000,
    });

    expect(outcome.status).toBe("rejected");
    expect(outcome.resolvedBy).toBe("reviewer");
  });

  it("returns outcome with status=timed_out when server returns timed_out on first poll", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonOk({
        ...HITL_ESCALATION_BASE,
        status: "timed_out",
        resolved_by: null,
        resolution_note: null,
        resolved_at: null,
      }),
    ) as unknown as typeof globalThis.fetch;

    const outcome = await waitForEscalationApproval({
      escalationId: "escl_1",
      pollIntervalMs: 10,
      waitMs: 5_000,
    });

    expect(outcome.status).toBe("timed_out");
  });

  it("maps auto_approved to status=approved", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonOk({
        ...HITL_ESCALATION_BASE,
        status: "auto_approved",
        resolved_by: null,
        resolution_note: "auto-approved by policy",
        resolved_at: "2026-01-01T01:30:00Z",
      }),
    ) as unknown as typeof globalThis.fetch;

    const outcome = await waitForEscalationApproval({
      escalationId: "escl_1",
      pollIntervalMs: 10,
      waitMs: 5_000,
    });

    expect(outcome.status).toBe("approved");
  });

  it("polls until terminal status — first pending, second approved", async () => {
    const fetchSpy = makeFetchSequence([
      jsonOk({ ...HITL_ESCALATION_BASE, status: "pending" }),
      jsonOk({
        ...HITL_ESCALATION_BASE,
        status: "approved",
        resolved_by: "admin",
        resolution_note: "lgtm",
        resolved_at: "2026-01-01T01:00:00Z",
      }),
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const outcome = await waitForEscalationApproval({
      escalationId: "escl_1",
      pollIntervalMs: 10,
      waitMs: 30_000,
    });

    expect(outcome.status).toBe("approved");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("GETs the correct escalation URL", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonOk({ ...HITL_ESCALATION_BASE, status: "approved", resolved_by: "x", resolution_note: null, resolved_at: "2026-01-01T01:00:00Z" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await waitForEscalationApproval({
      escalationId: "escl_abc",
      pollIntervalMs: 10,
      waitMs: 5_000,
    });

    const [url] = fetchSpy.mock.calls[0]! as unknown as [string | URL];
    expect(url).toContain("/v1/escalations/escl_abc");
  });

  it("enforces minimum poll interval of 1000ms by clamping", async () => {
    // We can't easily time the actual sleep in a unit test, but we can
    // verify no error is thrown when pollIntervalMs < 1000.
    globalThis.fetch = vi.fn(async () =>
      jsonOk({
        ...HITL_ESCALATION_BASE,
        status: "approved",
        resolved_by: "a",
        resolution_note: null,
        resolved_at: "2026-01-01T01:00:00Z",
      }),
    ) as unknown as typeof globalThis.fetch;

    const outcome = await waitForEscalationApproval({
      escalationId: "escl_1",
      pollIntervalMs: 1, // below minimum; should be clamped to 1000ms internally
      waitMs: 5_000,
    });

    expect(outcome.status).toBe("approved");
  });
});

// ── protectOrEscalate ─────────────────────────────────────────────────────────

describe("protectOrEscalate()", () => {
  it("returns ApprovalPermit with approvalBasis=direct_policy when protect() succeeds", async () => {
    // protect() uses the configure() singleton; inject fetch there.
    const protectFetch = makeFetchSequence([
      jsonOk(EVALUATE_ALLOW_WIRE),
      jsonOk(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_test_approval_runtime", fetch: protectFetch as unknown as typeof fetch });

    const permit = await protectOrEscalate(
      { agent: "bot", action: "deploy", context: { environment: "production" } },
    );

    expect(permit.approvalBasis).toBe("direct_policy");
    expect(permit.escalationId).toBe("");
    expect(permit.resolvedBy).toBeNull();
    expect(permit.permitId).toBe("dec_1");
  });

  it("creates escalation and returns ApprovalPermit when protect() throws hold", async () => {
    // protect() sees a "hold" decision (treat as denied with decision="hold")
    const protectFetch = makeFetchSequence([
      jsonOk(EVALUATE_HOLD_WIRE),
    ]);
    configure({ apiKey: "ask_test_approval_runtime", fetch: protectFetch as unknown as typeof fetch });

    // globalThis.fetch handles POST /v1/hitl and GET /v1/escalations/:id
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) {
        return jsonOk({ ...HITL_ESCALATION_BASE });
      }
      if (u.includes("/v1/escalations")) {
        return jsonOk({
          ...HITL_ESCALATION_BASE,
          status: "approved",
          resolved_by: "admin",
          resolution_note: "looks good",
          resolved_at: "2026-01-01T01:00:00Z",
        });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const permit = await protectOrEscalate(
      { agent: "bot", action: "deploy", context: { environment: "production" } },
      { pollIntervalMs: 10, waitMs: 5_000 },
    );

    expect(permit.approvalBasis).toBe("human_approval");
    expect(permit.escalationId).toBe("escl_1");
    expect(permit.resolvedBy).toBe("admin");
    expect(permit.resolutionNote).toBe("looks good");
  });

  it("calls onEscalationCreated with the handle after creating the escalation", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_approval_runtime", fetch: protectFetch as unknown as typeof fetch });

    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) {
        return jsonOk({
          ...HITL_ESCALATION_BASE,
          status: "approved",
          resolved_by: "x",
          resolution_note: null,
          resolved_at: "2026-01-01T01:00:00Z",
        });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const onCreated = vi.fn();

    await protectOrEscalate(
      { agent: "bot", action: "deploy" },
      { onEscalationCreated: onCreated, pollIntervalMs: 10, waitMs: 5_000 },
    );

    expect(onCreated).toHaveBeenCalledOnce();
    const handle = onCreated.mock.calls[0]![0];
    expect(handle.escalationId).toBe("escl_1");
  });

  it("throws EscalationDeniedError when escalation is rejected", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_approval_runtime", fetch: protectFetch as unknown as typeof fetch });

    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) {
        return jsonOk({
          ...HITL_ESCALATION_BASE,
          status: "rejected",
          resolved_by: "reviewer",
          resolution_note: "not authorized",
          resolved_at: "2026-01-01T02:00:00Z",
        });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    await expect(
      protectOrEscalate(
        { agent: "bot", action: "deploy" },
        { pollIntervalMs: 10, waitMs: 5_000 },
      ),
    ).rejects.toThrow(EscalationDeniedError);
  });

  it("EscalationDeniedError carries escalationId and outcome", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_approval_runtime", fetch: protectFetch as unknown as typeof fetch });

    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) {
        return jsonOk({
          ...HITL_ESCALATION_BASE,
          status: "rejected",
          resolved_by: "mgr",
          resolution_note: "denied",
          resolved_at: "2026-01-01T02:00:00Z",
        });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    let caught: unknown;
    try {
      await protectOrEscalate(
        { agent: "bot", action: "deploy" },
        { pollIntervalMs: 10, waitMs: 5_000 },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EscalationDeniedError);
    const err = caught as EscalationDeniedError;
    expect(err.escalationId).toBe("escl_1");
    expect(err.outcome.status).toBe("rejected");
    expect(err.outcome.resolutionNote).toBe("denied");
  });

  it("throws EscalationTimeoutError when escalation times out", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_approval_runtime", fetch: protectFetch as unknown as typeof fetch });

    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) {
        return jsonOk({
          ...HITL_ESCALATION_BASE,
          status: "timed_out",
          resolved_by: null,
          resolution_note: null,
          resolved_at: null,
        });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    await expect(
      protectOrEscalate(
        { agent: "bot", action: "deploy" },
        { pollIntervalMs: 10, waitMs: 5_000 },
      ),
    ).rejects.toThrow(EscalationTimeoutError);
  });

  it("rethrows AtlaSentDeniedError with decision=deny (hard deny) without escalating", async () => {
    // A hard deny: decision is "deny", not "hold"/"escalate"
    const denyWire = {
      permitted: false,
      decision_id: "dec_deny",
      reason: "Hard deny from policy",
      audit_hash: "audit_d",
      timestamp: "2026-01-01T00:00:00Z",
    };
    const protectFetch = makeFetchSequence([jsonOk(denyWire)]);
    configure({ apiKey: "ask_test_approval_runtime", fetch: protectFetch as unknown as typeof fetch });

    // globalThis.fetch should never be called for a hard deny
    const hitlFetch = vi.fn();
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await expect(
      protectOrEscalate({ agent: "bot", action: "deploy" }),
    ).rejects.toThrow(AtlaSentDeniedError);

    expect(hitlFetch).not.toHaveBeenCalled();
  });

  it("rethrows transport errors from protect() without escalating", async () => {
    const protectFetch = vi.fn(async () => new Response("boom", { status: 500 }));
    configure({
      apiKey: "ask_test_approval_runtime",
      fetch: protectFetch as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1 },
    });

    const hitlFetch = vi.fn();
    globalThis.fetch = hitlFetch as unknown as typeof globalThis.fetch;

    await expect(
      protectOrEscalate({ agent: "bot", action: "deploy" }),
    ).rejects.toThrow(AtlaSentError);

    expect(hitlFetch).not.toHaveBeenCalled();
  });

  it("uses agentId option as agent_id on the escalation", async () => {
    const protectFetch = makeFetchSequence([jsonOk(EVALUATE_HOLD_WIRE)]);
    configure({ apiKey: "ask_test_approval_runtime", fetch: protectFetch as unknown as typeof fetch });

    const fetchSpy = vi.fn(async (input: string | URL) => {
      const u = input.toString();
      if (u.includes("/v1/hitl")) return jsonOk({ ...HITL_ESCALATION_BASE });
      if (u.includes("/v1/escalations")) {
        return jsonOk({
          ...HITL_ESCALATION_BASE,
          status: "approved",
          resolved_by: "x",
          resolution_note: null,
          resolved_at: "2026-01-01T01:00:00Z",
        });
      }
      throw new Error(`Unexpected URL: ${u}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await protectOrEscalate(
      { agent: "original-agent", action: "deploy" },
      { agentId: "override-agent", pollIntervalMs: 10, waitMs: 5_000 },
    );

    const hitlCall = fetchSpy.mock.calls.find(([u]) => u.toString().includes("/v1/hitl"));
    const body = JSON.parse((hitlCall as unknown as [string, RequestInit])[1].body as string);
    expect(body.agent_id).toBe("override-agent");
  });
});

// ── requestOverride ────────────────────────────────────────────────────────────

describe("requestOverride()", () => {
  it("POSTs to /v1/overrides and returns the OverrideV1 object", async () => {
    const overrideResponse = {
      id: "ovr_1",
      orgId: "org_1",
      evaluationId: "dec_deny",
      reason: "Emergency override",
      status: "pending",
      requestedBy: "admin",
      approvedBy: null,
      revokedBy: null,
      createdAt: "2026-01-01T00:00:00Z",
      approvedAt: null,
      revokedAt: null,
      expiresAt: null,
      metadata: null,
    };

    globalThis.fetch = vi.fn(async () => jsonOk(overrideResponse)) as unknown as typeof globalThis.fetch;

    const result = await requestOverride({
      reason: "Emergency override",
      evaluationId: "dec_deny",
    });

    expect(result.id).toBe("ovr_1");
    expect(result.status).toBe("pending");
    expect(result.reason).toBe("Emergency override");
  });

  it("sends correct body fields to /v1/overrides", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonOk({
        id: "ovr_2",
        orgId: "org_1",
        evaluationId: "ev_1",
        reason: "Justified",
        status: "pending",
        requestedBy: "ops",
        approvedBy: null,
        revokedBy: null,
        createdAt: "2026-01-01T00:00:00Z",
        approvedAt: null,
        revokedAt: null,
        expiresAt: null,
        metadata: null,
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await requestOverride({
      reason: "Justified",
      evaluationId: "ev_1",
      ttlSeconds: 3600,
      metadata: { requestedBy: "ops-team" },
    });

    const [url, init] = fetchSpy.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain("/v1/overrides");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.reason).toBe("Justified");
    expect(body.evaluationId).toBe("ev_1");
    expect(body.ttlSeconds).toBe(3600);
    expect(body.metadata).toEqual({ requestedBy: "ops-team" });
  });

  it("throws AtlaSentError on 403 response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("Forbidden", { status: 403 }),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      requestOverride({ reason: "test", evaluationId: "ev_1" }),
    ).rejects.toThrow(AtlaSentError);
  });
});

// ── EscalationDeniedError ─────────────────────────────────────────────────────

describe("EscalationDeniedError", () => {
  it("includes the escalation id and resolution note in the message", () => {
    const outcome = {
      status: "rejected" as const,
      escalation: { ...HITL_ESCALATION_BASE, status: "rejected" as const },
      resolvedBy: "mgr",
      resolutionNote: "policy violation",
      resolvedAt: "2026-01-01T01:00:00Z",
    };

    const err = new EscalationDeniedError(outcome);
    expect(err.message).toContain("escl_1");
    expect(err.message).toContain("policy violation");
    expect(err.escalationId).toBe("escl_1");
    expect(err.outcome).toBe(outcome);
    expect(err.name).toBe("EscalationDeniedError");
  });

  it("omits resolution note from message when null", () => {
    const outcome = {
      status: "rejected" as const,
      escalation: { ...HITL_ESCALATION_BASE, status: "rejected" as const },
      resolvedBy: null,
      resolutionNote: null,
      resolvedAt: null,
    };

    const err = new EscalationDeniedError(outcome);
    expect(err.message).not.toContain(":");
    expect(err.message).toContain("escl_1");
  });
});

// ── EscalationTimeoutError ────────────────────────────────────────────────────

describe("EscalationTimeoutError", () => {
  it("carries escalationId and outcome", () => {
    const outcome = {
      status: "timed_out" as const,
      escalation: { ...HITL_ESCALATION_BASE, status: "timed_out" as const },
      resolvedBy: null,
      resolutionNote: null,
      resolvedAt: null,
    };

    const err = new EscalationTimeoutError(outcome);
    expect(err.escalationId).toBe("escl_1");
    expect(err.outcome).toBe(outcome);
    expect(err.name).toBe("EscalationTimeoutError");
    expect(err.message).toContain("escl_1");
  });
});
