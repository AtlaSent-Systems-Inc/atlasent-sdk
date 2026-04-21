import { afterEach, describe, expect, it, vi, type MockedFunction } from "vitest";

import {
  AtlaSentClient,
  AtlaSentError,
  PermissionDeniedError,
  TTLCache,
  authorize,
  configure,
  evaluate,
  gate,
  resetDefaultClient,
  verifyPermit,
} from "../src/index.js";

type FetchMock = MockedFunction<typeof fetch>;

const PERMIT_WIRE = {
  permitted: true,
  decision_id: "dec_alpha",
  reason: "ok",
  audit_hash: "hash_alpha",
  timestamp: "2026-04-17T10:00:00Z",
};

const DENY_WIRE = {
  permitted: false,
  decision_id: "dec_deny",
  reason: "policy blocks this",
  audit_hash: "",
  timestamp: "2026-04-17T10:00:00Z",
};

const VERIFY_OK_WIRE = {
  verified: true,
  outcome: "verified",
  permit_hash: "permit_alpha",
  timestamp: "2026-04-17T10:00:01Z",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function scriptedFetch(responses: Array<() => Response | Promise<Response>>): FetchMock {
  let i = 0;
  return vi.fn(async () => {
    const handler = responses[i++];
    if (!handler) throw new Error(`scriptedFetch: no response for call ${i}`);
    return handler();
  }) as unknown as FetchMock;
}

function makeClient(
  fetchImpl: FetchMock,
  overrides: Partial<ConstructorParameters<typeof AtlaSentClient>[0]> = {},
) {
  return new AtlaSentClient({
    apiKey: "ask_live_test",
    fetch: fetchImpl,
    timeoutMs: 5_000,
    maxRetries: 0,
    sleep: async () => {},
    ...overrides,
  });
}

describe("gate()", () => {
  it("evaluates then verifies on permit", async () => {
    const fetchImpl = scriptedFetch([
      () => jsonResponse(PERMIT_WIRE),
      () => jsonResponse(VERIFY_OK_WIRE),
    ]);
    const client = makeClient(fetchImpl);
    const result = await client.gate({ agent: "a", action: "b" });
    expect(result.evaluation.decision).toBe("ALLOW");
    expect(result.evaluation.permitId).toBe("dec_alpha");
    expect(result.verification.verified).toBe(true);
    expect(result.verification.permitHash).toBe("permit_alpha");
    expect(fetchImpl.mock.calls).toHaveLength(2);
  });

  it("verify receives permit_id from evaluate as decision_id", async () => {
    const fetchImpl = scriptedFetch([
      () => jsonResponse(PERMIT_WIRE),
      () => jsonResponse(VERIFY_OK_WIRE),
    ]);
    const client = makeClient(fetchImpl);
    await client.gate({
      agent: "agent-1",
      action: "read_phi",
      context: { patientId: "PT-001" },
    });
    const [, verifyInit] = fetchImpl.mock.calls[1]!;
    const body = JSON.parse(verifyInit!.body as string);
    expect(body.decision_id).toBe("dec_alpha");
    expect(body.action).toBe("read_phi");
    expect(body.agent).toBe("agent-1");
    expect(body.context).toEqual({ patientId: "PT-001" });
  });

  it("throws PermissionDeniedError on deny (does not call verify)", async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse(DENY_WIRE)]);
    const client = makeClient(fetchImpl);
    await expect(client.gate({ agent: "a", action: "b" })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it("PermissionDeniedError is an AtlaSentError (single catch covers both)", async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse(DENY_WIRE)]);
    const client = makeClient(fetchImpl);
    await expect(client.gate({ agent: "a", action: "b" })).rejects.toBeInstanceOf(
      AtlaSentError,
    );
  });
});

describe("authorize()", () => {
  it("returns permitted:true with permitHash when verify:true (default)", async () => {
    const fetchImpl = scriptedFetch([
      () => jsonResponse(PERMIT_WIRE),
      () => jsonResponse(VERIFY_OK_WIRE),
    ]);
    const client = makeClient(fetchImpl);
    const result = await client.authorize({
      agent: "clinical-data-agent",
      action: "modify_patient_record",
      context: { user: "dr_smith" },
    });
    expect(result).toMatchObject({
      permitted: true,
      agent: "clinical-data-agent",
      action: "modify_patient_record",
      context: { user: "dr_smith" },
      permitId: "dec_alpha",
      auditHash: "hash_alpha",
      permitHash: "permit_alpha",
      verified: true,
    });
  });

  it("skips verify when verify:false", async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse(PERMIT_WIRE)]);
    const client = makeClient(fetchImpl);
    const result = await client.authorize({
      agent: "a",
      action: "b",
      verify: false,
    });
    expect(result.permitted).toBe(true);
    expect(result.permitHash).toBe("");
    expect(result.verified).toBe(false);
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it("returns permitted:false on deny by default (does not throw)", async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse(DENY_WIRE)]);
    const client = makeClient(fetchImpl);
    const result = await client.authorize({ agent: "a", action: "b" });
    expect(result.permitted).toBe(false);
    expect(result.reason).toBe("policy blocks this");
    expect(result.permitHash).toBe("");
    expect(result.verified).toBe(false);
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it("throws PermissionDeniedError on deny when raiseOnDeny:true", async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse(DENY_WIRE)]);
    const client = makeClient(fetchImpl);
    await expect(
      client.authorize({ agent: "a", action: "b", raiseOnDeny: true }),
    ).rejects.toMatchObject({
      name: "PermissionDeniedError",
      permitId: "dec_deny",
      reason: "policy blocks this",
    });
  });
});

describe("retry / backoff", () => {
  it("retries 500 up to maxRetries times then returns a successful response", async () => {
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const fetchImpl = scriptedFetch([
      () => new Response("boom", { status: 500 }),
      () => new Response("boom", { status: 500 }),
      () => jsonResponse(PERMIT_WIRE),
    ]);
    const client = makeClient(fetchImpl, { maxRetries: 2, retryBackoffMs: 100, sleep });
    const result = await client.evaluate({ agent: "a", action: "b" });
    expect(result.decision).toBe("ALLOW");
    expect(fetchImpl.mock.calls).toHaveLength(3);
    // Exponential: 100ms, 200ms
    expect(sleepCalls).toEqual([100, 200]);
  });

  it("surfaces the last server_error when retries are exhausted", async () => {
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const fetchImpl = scriptedFetch([
      () => new Response("boom", { status: 500 }),
      () => new Response("boom", { status: 503 }),
      () => new Response("boom", { status: 502 }),
    ]);
    const client = makeClient(fetchImpl, { maxRetries: 2, retryBackoffMs: 10, sleep });
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      code: "server_error",
      status: 502,
    });
    expect(fetchImpl.mock.calls).toHaveLength(3);
  });

  it("does NOT retry on 401/403/429/4xx", async () => {
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const fetchImpl = scriptedFetch([() => new Response("nope", { status: 401 })]);
    const client = makeClient(fetchImpl, { maxRetries: 3, sleep });
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      code: "invalid_api_key",
    });
    expect(fetchImpl.mock.calls).toHaveLength(1);
    expect(sleepCalls).toHaveLength(0);
  });

  it("retries on network errors (TypeError from fetch)", async () => {
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const fetchImpl = scriptedFetch([
      () => {
        throw new TypeError("ECONNREFUSED");
      },
      () => jsonResponse(PERMIT_WIRE),
    ]);
    const client = makeClient(fetchImpl, { maxRetries: 1, sleep });
    const result = await client.evaluate({ agent: "a", action: "b" });
    expect(result.decision).toBe("ALLOW");
    expect(sleepCalls).toHaveLength(1);
  });
});

describe("cache integration", () => {
  it("returns cached EvaluateResponse without hitting the network", async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse(PERMIT_WIRE)]);
    const cache = new TTLCache({ ttlMs: 60_000 });
    const client = makeClient(fetchImpl, { cache });

    const first = await client.evaluate({
      agent: "a",
      action: "b",
      context: { x: 1 },
    });
    const second = await client.evaluate({
      agent: "a",
      action: "b",
      context: { x: 1 },
    });

    expect(first).toEqual(second);
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it("does NOT cache DENY decisions", async () => {
    const fetchImpl = scriptedFetch([
      () => jsonResponse(DENY_WIRE),
      () => jsonResponse(PERMIT_WIRE),
    ]);
    const cache = new TTLCache({ ttlMs: 60_000 });
    const client = makeClient(fetchImpl, { cache });

    const denied = await client.evaluate({ agent: "a", action: "b" });
    expect(denied.decision).toBe("DENY");
    const permitted = await client.evaluate({ agent: "a", action: "b" });
    expect(permitted.decision).toBe("ALLOW");
    expect(fetchImpl.mock.calls).toHaveLength(2);
  });
});

describe("module-level convenience helpers", () => {
  afterEach(() => {
    resetDefaultClient();
    delete process.env.ATLASENT_API_KEY;
  });

  it("configure() sets up the default client, authorize() uses it", async () => {
    const fetchImpl = scriptedFetch([
      () => jsonResponse(PERMIT_WIRE),
      () => jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_configured", fetch: fetchImpl });
    const result = await authorize({ agent: "a", action: "b" });
    expect(result.permitted).toBe(true);
    expect(result.permitHash).toBe("permit_alpha");
  });

  it("gate() throws PermissionDeniedError via the default client", async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse(DENY_WIRE)]);
    configure({ apiKey: "ask_live_configured", fetch: fetchImpl });
    await expect(gate({ agent: "a", action: "b" })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("throws when no default client is configured and ATLASENT_API_KEY is unset", async () => {
    resetDefaultClient();
    delete process.env.ATLASENT_API_KEY;
    await expect(authorize({ agent: "a", action: "b" })).rejects.toMatchObject({
      code: "invalid_api_key",
    });
  });

  it("evaluate() and verifyPermit() also route through the default client", async () => {
    const fetchImpl = scriptedFetch([
      () => jsonResponse(PERMIT_WIRE),
      () => jsonResponse(VERIFY_OK_WIRE),
    ]);
    configure({ apiKey: "ask_live_configured", fetch: fetchImpl });

    const evalResult = await evaluate({ agent: "a", action: "b" });
    expect(evalResult.decision).toBe("ALLOW");

    const verifyResult = await verifyPermit({ permitId: evalResult.permitId });
    expect(verifyResult.verified).toBe(true);
  });

  it("lazily constructs a client from ATLASENT_API_KEY + ATLASENT_BASE_URL", async () => {
    resetDefaultClient();
    const fetchImpl = scriptedFetch([() => jsonResponse(PERMIT_WIRE)]);
    process.env.ATLASENT_API_KEY = "ask_live_env";
    process.env.ATLASENT_BASE_URL = "https://staging.atlasent.io";
    try {
      // We can't inject fetch into the env-constructed client, so
      // monkey-patch globalThis.fetch just for this call.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchImpl as unknown as typeof fetch;
      try {
        await evaluate({ agent: "a", action: "b", verify: false } as never);
        const [url] = fetchImpl.mock.calls[0]!;
        expect(url).toBe("https://staging.atlasent.io/v1-evaluate");
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      delete process.env.ATLASENT_BASE_URL;
    }
  });
});
