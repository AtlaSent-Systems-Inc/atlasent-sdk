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
      action: "production.deploy",
      context: { commit: "abc123", environment: "production" },
    });

    expect(permit).toEqual({
      permitId: "dec_alpha",
      permitHash: "permit_alpha",
      auditHash: "hash_alpha",
      reason: "GxP policy authorized operator",
      timestamp: "2026-04-22T10:00:01Z",
      permitExpiresAt: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws AtlaSentDeniedError on policy DENY — never returns a decision", async () => {
    const fetchImpl = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    let caught: unknown;
    try {
      await atlasent.protect({ agent: "a", action: "test.action", context: { environment: "production" } });
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
      await atlasent.protect({ agent: "a", action: "test.action", context: { environment: "production" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AtlaSentDeniedError);
    const denied = caught as AtlaSentDeniedError;
    expect(denied.decision).toBe("deny");
    expect(denied.evaluationId).toBe("dec_alpha");
    expect(denied.reason).toMatch(/revoked/);
  });

  // Phase B.6 — parametrize the four PermitOutcome values so a future
  // outcome added to PermitOutcome but missed in protect's deny-path
  // is caught by the test suite, not by a customer's audit log.
  it.each([
    ["permit_consumed", "isConsumed"] as const,
    ["permit_expired", "isExpired"] as const,
    ["permit_revoked", "isRevoked"] as const,
    ["permit_not_found", "isNotFound"] as const,
  ])(
    "surfaces %s outcome and lights the matching predicate",
    async (wireOutcome, predicate) => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse({
          verified: false,
          outcome: wireOutcome,
          permit_hash: "permit_alpha",
          timestamp: "2026-04-22T10:00:01Z",
        }),
      ]);
      configure({ apiKey: "ask_live_test", fetch: fetchImpl });

      let caught: unknown;
      try {
        await atlasent.protect({ agent: "a", action: "test.action", context: { environment: "production" } });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.outcome).toBe(wireOutcome);
      expect((denied as unknown as Record<string, boolean>)[predicate]).toBe(
        true,
      );
    },
  );

  it("lets transport errors propagate as AtlaSentError (not AtlaSentDeniedError)", async () => {
    const fetchImpl = mockFetchSequence([
      new Response("server boom", { status: 500 }),
    ]);
    configure({
      apiKey: "ask_live_test",
      fetch: fetchImpl,
      retryPolicy: { maxAttempts: 1 },
    });

    let caught: unknown;
    try {
      await atlasent.protect({ agent: "a", action: "test.action", context: { environment: "production" } });
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
      await atlasent.protect({ agent: "a", action: "test.action", context: { environment: "production" } });
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

    const permit = await atlasent.protect({ agent: "a", action: "test.action", context: { environment: "production" } });
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

    configure({ apiKey: "ask_test_1", fetch: first });
    await atlasent.protect({ agent: "a", action: "test.action", context: { environment: "production" } });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(0);

    configure({ apiKey: "ask_test_2", fetch: second });
    await atlasent.protect({ agent: "a", action: "test.action", context: { environment: "production" } });
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

    await atlasent.protect({ agent: "a", action: "test.action", context: { environment: "production" } });
    await atlasent.protect({ agent: "a", action: "test.action", context: { environment: "production" } });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("forwards context to BOTH evaluate and verifyPermit so the server can cross-check", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const ctx = { commit: "abc123", approver: "alice", environment: "production" };
    await atlasent.protect({
      agent: "deploy-bot",
      action: "production.deploy",
      context: ctx,
    });

    const [, evalInit] = fetchImpl.mock.calls[0]!;
    const evalBody = JSON.parse(evalInit!.body as string);
    expect(evalBody.context).toEqual(ctx);

    const [, verifyInit] = fetchImpl.mock.calls[1]!;
    const verifyBody = JSON.parse(verifyInit!.body as string);
    // Canonical wire: no `context`, action_type / actor_id / permit_token.
    expect(verifyBody.context).toBeUndefined();
    expect(verifyBody.permit_token).toBe("dec_alpha");
    expect(verifyBody.actor_id).toBe("deploy-bot");
    expect(verifyBody.action_type).toBe("production.deploy");
  });

  it("omits context when caller omits it", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await atlasent.protect({ agent: "a", action: "test.action", context: { environment: "production" } });

    const [, evalInit] = fetchImpl.mock.calls[0]!;
    const evalBody = JSON.parse(evalInit!.body as string);
    expect(evalBody.context).toEqual({ environment: "production" });
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

import { protectWithEvidence } from "../src/protect.js";

describe("protectWithEvidence", () => {
  beforeEach(() => {
    __resetSharedClientForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetSharedClientForTests();
  });

  it("returns PermitWithEvidence on allow (no signing)", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_test_protect_evidence_k1", fetch: fetchMock, retryPolicy: { maxAttempts: 1 } });

    const result = await protectWithEvidence({ agent: "bot", action: "production.deploy", context: { environment: "staging" } });
    expect(result.permitId).toBe("dec_alpha");
    expect(result.receipt).toBeDefined();
    expect(result.receipt.decision).toBe("allow");
    expect(result.receipt.algorithm).toBe("none");
    expect(result.receipt.signature).toBeNull();
  });

  it("signs the receipt when signingSecret is provided", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_test_protect_evidence_k1", fetch: fetchMock, retryPolicy: { maxAttempts: 1 } });

    const result = await protectWithEvidence(
      { agent: "bot", action: "production.deploy", context: { environment: "staging" } },
      { signingSecret: "super-secret-key", signingKeyId: "key-v1" },
    );
    expect(result.receipt.algorithm).toBe("hmac-sha256");
    expect(result.receipt.signature).not.toBeNull();
    expect(result.receipt.signing_key_id).toBe("key-v1");
  });

  it("throws AtlaSentDeniedError on deny", async () => {
    const fetchMock = mockFetchSequence([jsonResponse(EVALUATE_DENY_WIRE)]);
    configure({ apiKey: "ask_test_protect_evidence_k1", fetch: fetchMock, retryPolicy: { maxAttempts: 1 } });

    await expect(
      protectWithEvidence({ agent: "bot", action: "production.deploy", context: { environment: "staging" } }),
    ).rejects.toBeInstanceOf(AtlaSentDeniedError);
  });

  it("includes why_trace when constraintTrace is provided", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_test_protect_evidence_k1", fetch: fetchMock, retryPolicy: { maxAttempts: 1 } });

    const constraintTrace = { stages: [], rules_evaluated: [] } as const;
    const result = await protectWithEvidence(
      { agent: "bot", action: "production.deploy", context: { environment: "staging" } },
      { constraintTrace },
    );
    expect(result.receipt.why_trace).not.toBeNull();
  });

  it("sets why_trace to null when constraintTrace is not provided", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_test_protect_evidence_k1", fetch: fetchMock, retryPolicy: { maxAttempts: 1 } });

    const result = await protectWithEvidence({ agent: "bot", action: "production.deploy", context: { environment: "staging" } });
    expect(result.receipt.why_trace).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Execution payload binding (AC-5).
//
// Supplying a digest is what makes PAYLOAD_MISMATCH a real check. Without it
// the runtime binds the permit to its OWN hash of the whole evaluate request,
// which a caller's payload digest can never equal — so nothing about the
// payload actually constrains execution.
//
// EVERY ASSERTION HERE IS ON THE WIRE BODY, not on the arguments handed to the
// client. That is deliberate and load-bearing: `atlasent-llm-integrations`
// shipped a wrapper whose unit test asserted the digest at the kwargs level
// and passed green for months while the value was being nested under `context`
// (where the runtime never reads it) and `sha256:`-prefixed (which the runtime
// silently drops). A kwargs-level assertion cannot see either mistake.
// ───────────────────────────────────────────────────────────────────────────

const HEX64 = "a".repeat(64);

/** Parse the JSON body of the Nth fetch call (0-indexed). */
function bodyOfCall(fetchImpl: FetchMock, n: number): Record<string, unknown> {
  const init = fetchImpl.mock.calls[n]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("protect — execution payload binding", () => {
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

  it("sends the digest at the TOP LEVEL of the evaluate body, never inside context", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await atlasent.protect({
      agent: "deploy-bot",
      action: "production.deploy",
      context: { environment: "production" },
      executionPayloadHash: HEX64,
    });

    const body = bodyOfCall(fetchImpl, 0);
    expect(body.execution_payload_hash).toBe(HEX64);
    // The runtime destructures it ALONGSIDE context. A nested copy is never a
    // binding, so its presence there would be a false reassurance.
    expect((body.context as Record<string, unknown>).execution_payload_hash).toBeUndefined();
  });

  it("survives the legacy {agent, action} normalization path", async () => {
    // `protect()` always uses the legacy field names, so every one of its
    // requests goes through `normalizeEvaluateRequest`'s branch that REBUILDS
    // the request field by field. A field missing from that whitelist is
    // dropped with no error — this test is what stops that regression, and it
    // is the exact trap this change had to be written around.
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await atlasent.protect({
      agent: "deploy-bot",
      action: "production.deploy",
      context: { environment: "production" },
      executionPayloadHash: HEX64,
    });

    expect(bodyOfCall(fetchImpl, 0).execution_payload_hash).toBe(HEX64);
  });

  it("strips a sha256: prefix rather than sending a value the runtime drops", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await atlasent.protect({
      agent: "deploy-bot",
      action: "production.deploy",
      context: { environment: "production" },
      executionPayloadHash: `sha256:${HEX64}`,
    });

    expect(bodyOfCall(fetchImpl, 0).execution_payload_hash).toBe(HEX64);
  });

  it("lowercases an uppercase digest, because the runtime normalizes before binding", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await atlasent.protect({
      agent: "deploy-bot",
      action: "production.deploy",
      context: { environment: "production" },
      executionPayloadHash: "A".repeat(64),
    });

    expect(bodyOfCall(fetchImpl, 0).execution_payload_hash).toBe(HEX64);
  });

  it("THROWS on a malformed digest instead of sending one the runtime silently drops", async () => {
    // Fail-closed at the client boundary. Sending it would produce allow,
    // permit, 200, no error — and an execution the caller believes is bound to
    // its payload and is not. No evaluate call should even be attempted.
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await expect(
      atlasent.protect({
        agent: "deploy-bot",
        action: "production.deploy",
        context: { environment: "production" },
        executionPayloadHash: "not-a-digest",
      }),
    ).rejects.toBeInstanceOf(AtlaSentError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("omitting the digest sends a body with no execution_payload_hash key at all", async () => {
    // The additive guarantee: an existing caller's request is unchanged. Not
    // `undefined`, not `null` — absent, so nothing about the serialized body
    // moves for callers who never adopt this.
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await atlasent.protect({
      agent: "deploy-bot",
      action: "production.deploy",
      context: { environment: "production" },
    });

    expect("execution_payload_hash" in bodyOfCall(fetchImpl, 0)).toBe(false);
  });

  it("does not mutate the caller's request object", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    const req = {
      agent: "deploy-bot",
      action: "production.deploy",
      context: { environment: "production" },
      executionPayloadHash: `sha256:${HEX64}`,
    };
    await atlasent.protect(req);

    expect(req.executionPayloadHash).toBe(`sha256:${HEX64}`);
    expect("execution_payload_hash" in req).toBe(false);
  });
});

describe("protect — the verify boundary presents the digest that was BOUND", () => {
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

  it("presents the CALLER's digest at verify when one was supplied, not the evaluate-payload hash", async () => {
    // `v1-verify-permit` resolves ONE callerPayloadHash (`payload_hash`, else
    // `execution_hash` as a back-compat alias) and compares it against the
    // permit's bound hash. When the caller supplied a digest, THAT is what the
    // runtime bound — so presenting the computed evaluate-payload hash instead
    // is a DETERMINISTIC PAYLOAD_MISMATCH on every call: a hash of the request
    // can never equal a hash of the payload.
    //
    // This is the defect the first draft of this change shipped. No test here
    // talks to a real runtime, so nothing failed; it was found by reading the
    // verify handler's absence/comparison policy. This test is what stops it
    // coming back.
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await atlasent.protect({
      agent: "deploy-bot",
      action: "production.deploy",
      context: { environment: "production" },
      executionPayloadHash: HEX64,
    });

    const evaluateBody = bodyOfCall(fetchImpl, 0);
    const verifyBody = bodyOfCall(fetchImpl, 1);
    expect(evaluateBody.execution_payload_hash).toBe(HEX64);
    // The same value on both sides. Anything else cannot match what was bound.
    expect(verifyBody.execution_hash).toBe(HEX64);
  });

  it("still presents the computed evaluate-payload hash when no digest was supplied", async () => {
    // The additive guarantee at the verify boundary: an existing caller's
    // behaviour is unchanged. A 64-hex value is still sent, just not the
    // caller's — there isn't one.
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    await atlasent.protect({
      agent: "deploy-bot",
      action: "production.deploy",
      context: { environment: "production" },
    });

    const verifyBody = bodyOfCall(fetchImpl, 1);
    expect(typeof verifyBody.execution_hash).toBe("string");
    expect(verifyBody.execution_hash).not.toBe(HEX64);
    expect(String(verifyBody.execution_hash)).toMatch(/^[0-9a-f]{64}$/);
  });
});
