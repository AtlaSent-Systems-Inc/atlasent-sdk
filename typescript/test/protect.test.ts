import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";

import atlasent, {
  AtlaSentClient,
  AtlaSentDeniedError,
  AtlaSentError,
  configure,
  protect,
} from "../src/index.js";
import { __resetSharedClientForTests } from "../src/protect.js";

type FetchMock = MockedFunction<typeof fetch>;

const EVALUATE_ALLOW_WIRE = {
  permitted: true,
  decision_id: "dec_alpha",
  reason: "GxP policy authorized operator",
  audit_hash: "hash_alpha",
  timestamp: "2026-04-22T10:00:00Z",
};

const EVALUATE_DENY_WIRE = {
  permitted: false,
  decision_id: "dec_beta",
  reason: "Missing change_reason for critical field",
  audit_hash: "hash_beta",
  timestamp: "2026-04-22T10:01:00Z",
};

const VERIFY_OK_WIRE = {
  verified: true,
  outcome: "verified",
  permit_hash: "permit_alpha",
  timestamp: "2026-04-22T10:00:01Z",
};

const VERIFY_REVOKED_WIRE = {
  verified: false,
  outcome: "revoked",
  permit_hash: "permit_alpha",
  timestamp: "2026-04-22T10:00:01Z",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetchSequence(responses: Response[]): FetchMock {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("mock fetch queue exhausted");
    return next;
  }) as unknown as FetchMock;
}

describe("atlasent.protect (default export API)", () => {
  const ORIGINAL_ENV = process.env.ATLASENT_API_KEY;

  beforeEach(() => {
    __resetSharedClientForTests();
    delete process.env.ATLASENT_API_KEY;
  });

  afterEach(() => {
    __resetSharedClientForTests();
    if (ORIGINAL_ENV !== undefined) process.env.ATLASENT_API_KEY = ORIGINAL_ENV;
    else delete process.env.ATLASENT_API_KEY;
  });

  it("is reachable as both named import and default-export method", () => {
    expect(typeof protect).toBe("function");
    expect(typeof atlasent.protect).toBe("function");
    expect(atlasent.protect).toBe(protect);
    expect(atlasent.configure).toBe(configure);
  });

  it("returns a verified Permit on ALLOW + verified", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const permit = await atlasent.protect({
      agent: "deploy-bot",
      action: "deploy_to_production",
      context: { commit: "abc123" },
    });

    expect(permit).toEqual({
      permitId: "dec_alpha",
      permitHash: "permit_alpha",
      auditHash: "hash_alpha",
      reason: "GxP policy authorized operator",
      timestamp: "2026-04-22T10:00:01Z",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws AtlaSentDeniedError on policy DENY — never returns a decision", async () => {
    const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    let caught: unknown;
    try {
      await atlasent.protect({ agent: "a", action: "b" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtlaSentDeniedError);
    expect(caught).toBeInstanceOf(AtlaSentError); // part of the same family
    const denied = caught as AtlaSentDeniedError;
    expect(denied.decision).toBe("deny");
    expect(denied.evaluationId).toBe("dec_beta");
    expect(denied.reason).toBe("Missing change_reason for critical field");
    expect(denied.auditHash).toBe("hash_beta");
    // No verifyPermit round-trip on deny.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws AtlaSentDeniedError if the permit fails verification", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_REVOKED_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    let caught: unknown;
    try {
      await atlasent.protect({ agent: "a", action: "b" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AtlaSentDeniedError);
    const denied = caught as AtlaSentDeniedError;
    expect(denied.decision).toBe("deny");
    expect(denied.evaluationId).toBe("dec_alpha");
    expect(denied.reason).toMatch(/revoked/);
  });

  it("lets transport errors propagate as AtlaSentError (not AtlaSentDeniedError)", async () => {
    const fetchImpl = mockFetchSequence([
      new Response("server boom", { status: 500 }),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    let caught: unknown;
    try {
      await atlasent.protect({ agent: "a", action: "b" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AtlaSentError);
    expect(caught).not.toBeInstanceOf(AtlaSentDeniedError);
    expect((caught as AtlaSentError).code).toBe("server_error");
  });

  it("throws a configuration error if neither env var nor configure() provided a key", async () => {
    // No configure(), no ATLASENT_API_KEY set.
    let caught: unknown;
    try {
      await atlasent.protect({ agent: "a", action: "b" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AtlaSentError);
    expect((caught as AtlaSentError).code).toBe("invalid_api_key");
    expect((caught as AtlaSentError).message).toMatch(/ATLASENT_API_KEY/);
  });

  it("falls back to ATLASENT_API_KEY env var when configure() is not called", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    process.env.ATLASENT_API_KEY = "ask_live_from_env";
    // Still have to inject `fetch` for testing; the env only supplies the key.
    configure({ fetch: fetchImpl });

    const permit = await atlasent.protect({ agent: "a", action: "b" });
    expect(permit.permitId).toBe("dec_alpha");
  });

  it("configure() replaces the singleton on subsequent calls", async () => {
    const first = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    const second = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);

    configure({ apiKey: "ask_1", fetch: first });
    await atlasent.protect({ agent: "a", action: "b" });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(0);

    configure({ apiKey: "ask_2", fetch: second });
    await atlasent.protect({ agent: "a", action: "b" });
    // First mock must not get further calls after configure() replaces it.
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("reuses the singleton across protect() calls within one configure", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await atlasent.protect({ agent: "a", action: "b" });
    await atlasent.protect({ agent: "a", action: "b" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("forwards context to BOTH evaluate and verifyPermit so the server can cross-check", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const ctx = { commit: "abc123", approver: "alice" };
    await atlasent.protect({ agent: "deploy-bot", action: "deploy", context: ctx });

    const [, evalInit] = fetchImpl.mock.calls[0]!;
    const evalBody = JSON.parse(evalInit!.body as string);
    expect(evalBody.context).toEqual(ctx);

    const [, verifyInit] = fetchImpl.mock.calls[1]!;
    const verifyBody = JSON.parse(verifyInit!.body as string);
    expect(verifyBody.context).toEqual(ctx);
    expect(verifyBody.decision_id).toBe("dec_alpha");
    expect(verifyBody.agent).toBe("deploy-bot");
    expect(verifyBody.action).toBe("deploy");
  });

  it("omits context when caller omits it", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await atlasent.protect({ agent: "a", action: "b" });

    const [, evalInit] = fetchImpl.mock.calls[0]!;
    const evalBody = JSON.parse(evalInit!.body as string);
    expect(evalBody.context).toEqual({});
  });
});

describe("named-export backward compatibility", () => {
  it("AtlaSentClient named export still works (existing consumers unaffected)", () => {
    const client = new AtlaSentClient({ apiKey: "ask_live_test" });
    expect(client).toBeInstanceOf(AtlaSentClient);
  });
});

describe("AtlaSentDeniedError", () => {
  it("is an AtlaSentError subclass — `catch (err instanceof AtlaSentError)` catches it", () => {
    const err = new AtlaSentDeniedError({
      decision: "deny",
      evaluationId: "dec_x",
      reason: "policy says no",
    });
    expect(err).toBeInstanceOf(AtlaSentError);
    expect(err).toBeInstanceOf(AtlaSentDeniedError);
    expect(err.name).toBe("AtlaSentDeniedError");
  });

  it("carries decision, evaluationId, reason, and auditHash", () => {
    const err = new AtlaSentDeniedError({
      decision: "deny",
      evaluationId: "dec_x",
      reason: "policy says no",
      auditHash: "h_x",
      requestId: "req_42",
    });
    expect(err.decision).toBe("deny");
    expect(err.evaluationId).toBe("dec_x");
    expect(err.reason).toBe("policy says no");
    expect(err.auditHash).toBe("h_x");
    expect(err.requestId).toBe("req_42");
    expect(err.message).toContain("policy says no");
  });

  it("types the decision union including forward-compatible values", () => {
    // Compile-only assertion: `hold` and `escalate` are accepted in the
    // union so callers can `switch` exhaustively from day one even
    // though only `deny` is emitted against today's API.
    const hold = new AtlaSentDeniedError({
      decision: "hold",
      evaluationId: "dec_x",
    });
    const escalate = new AtlaSentDeniedError({
      decision: "escalate",
      evaluationId: "dec_x",
    });
    expect(hold.decision).toBe("hold");
    expect(escalate.decision).toBe("escalate");
  });
});
