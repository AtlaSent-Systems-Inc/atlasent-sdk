import { describe, expect, it, vi, type Mock } from "vitest";

import { AtlaSentClient, AtlaSentError } from "../src/index.js";

type FetchMock = Mock<typeof fetch>;

const EVALUATE_PERMIT_WIRE = {
  permitted: true,
  decision_id: "dec_alpha",
  reason: "Operator authorized under GxP policy",
  audit_hash: "hash_alpha",
  timestamp: "2026-04-17T10:00:00Z",
};

const EVALUATE_DENY_WIRE = {
  permitted: false,
  decision_id: "dec_beta",
  reason: "Missing change_reason for critical field",
  audit_hash: "hash_beta",
  timestamp: "2026-04-17T10:01:00Z",
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

function mockFetch(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchMock {
  return vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return impl(url, init ?? {});
  }) as unknown as FetchMock;
}

function makeClient(fetchImpl: FetchMock, overrides: Partial<ConstructorParameters<typeof AtlaSentClient>[0]> = {}) {
  return new AtlaSentClient({
    apiKey: "ask_live_test",
    fetch: fetchImpl,
    timeoutMs: 5_000,
    ...overrides,
  });
}

describe("AtlaSentClient constructor", () => {
  it("throws if apiKey is missing", () => {
    expect(() => new AtlaSentClient({ apiKey: "" })).toThrow(AtlaSentError);
    // @ts-expect-error — intentionally invalid for the runtime check
    expect(() => new AtlaSentClient({})).toThrow(AtlaSentError);
  });

  it("strips trailing slashes from baseUrl", () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl, { baseUrl: "https://staging.atlasent.io///" });
    return client.evaluate({ agent: "a", action: "b" }).then(() => {
      const [url] = fetchImpl.mock.calls[0]!;
      expect(url).toBe("https://staging.atlasent.io/v1-evaluate");
    });
  });
});

describe("evaluate()", () => {
  it("returns decision: ALLOW on permitted response", async () => {
    const client = makeClient(mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE)));
    const result = await client.evaluate({
      agent: "clinical-data-agent",
      action: "modify_patient_record",
      context: { user: "dr_smith", environment: "production" },
    });
    expect(result).toEqual({
      decision: "ALLOW",
      permitId: "dec_alpha",
      reason: "Operator authorized under GxP policy",
      auditHash: "hash_alpha",
      timestamp: "2026-04-17T10:00:00Z",
    });
  });

  it("returns decision: DENY on non-permitted response (does not throw)", async () => {
    const client = makeClient(mockFetch(() => jsonResponse(EVALUATE_DENY_WIRE)));
    const result = await client.evaluate({ agent: "a", action: "b" });
    expect(result.decision).toBe("DENY");
    expect(result.permitId).toBe("dec_beta");
    expect(result.reason).toBe("Missing change_reason for critical field");
  });

  it("sends the wire-format body (snake_case)", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl);
    await client.evaluate({
      agent: "agent-X",
      action: "act",
      context: { u: "v" },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.atlasent.io/v1-evaluate");
    expect(init!.method).toBe("POST");
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({
      action: "act",
      agent: "agent-X",
      context: { u: "v" },
      api_key: "ask_live_test",
    });
  });

  it("sets Authorization, User-Agent, and X-Request-ID headers", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl);
    await client.evaluate({ agent: "a", action: "b" });
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ask_live_test");
    expect(headers["User-Agent"]).toMatch(/^@atlasent\/sdk\/\d+\.\d+\.\d+ node\//);
    expect(headers["X-Request-ID"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json");
  });

  it("defaults missing context to an empty object", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl);
    await client.evaluate({ agent: "a", action: "b" });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.context).toEqual({});
  });
});

describe("verifyPermit()", () => {
  it("returns the verified payload, no throw when verified: false", async () => {
    const client = makeClient(
      mockFetch(() => jsonResponse({ ...VERIFY_OK_WIRE, verified: false })),
    );
    const result = await client.verifyPermit({ permitId: "dec_alpha" });
    expect(result.verified).toBe(false);
    expect(result.outcome).toBe("verified");
  });

  it("maps permit_hash \u2192 permitHash", async () => {
    const client = makeClient(mockFetch(() => jsonResponse(VERIFY_OK_WIRE)));
    const result = await client.verifyPermit({ permitId: "dec_alpha" });
    expect(result.permitHash).toBe("permit_alpha");
    expect(result.verified).toBe(true);
  });

  it("sends the wire-format body with permit_id \u2192 decision_id", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(VERIFY_OK_WIRE));
    const client = makeClient(fetchImpl);
    await client.verifyPermit({
      permitId: "dec_alpha",
      action: "read_phi",
      agent: "agent-1",
      context: { patientId: "PT-001" },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.atlasent.io/v1-verify-permit");
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({
      decision_id: "dec_alpha",
      action: "read_phi",
      agent: "agent-1",
      context: { patientId: "PT-001" },
      api_key: "ask_live_test",
    });
  });
});

describe("HTTP error mapping", () => {
  it("401 \u2192 AtlaSentError(code: invalid_api_key)", async () => {
    const client = makeClient(
      mockFetch(() => new Response("unauthorized", { status: 401 })),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      name: "AtlaSentError",
      status: 401,
      code: "invalid_api_key",
    });
  });

  it("403 \u2192 AtlaSentError(code: forbidden)", async () => {
    const client = makeClient(
      mockFetch(() => new Response("nope", { status: 403 })),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
  });

  it("429 \u2192 AtlaSentError(code: rate_limited) with retryAfterMs from Retry-After header", async () => {
    const client = makeClient(
      mockFetch(() =>
        new Response("too many", {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
      ),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterMs: 30_000,
    });
  });

  it("500 \u2192 AtlaSentError(code: server_error)", async () => {
    const client = makeClient(
      mockFetch(() => new Response("oops", { status: 500 })),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      status: 500,
      code: "server_error",
    });
  });

  it("422 (other 4xx) \u2192 AtlaSentError(code: bad_request) surfaces server message", async () => {
    const client = makeClient(
      mockFetch(
        () =>
          new Response(JSON.stringify({ message: "bad field: agent" }), {
            status: 422,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      status: 422,
      code: "bad_request",
      message: "bad field: agent",
    });
  });
});

describe("Network / transport errors", () => {
  it("fetch rejecting maps to code: network", async () => {
    const client = makeClient(
      mockFetch(() => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      code: "network",
    });
  });

  it("AbortController timeout maps to code: timeout", async () => {
    const client = makeClient(
      mockFetch(() => {
        const err = new DOMException("timed out", "TimeoutError");
        throw err;
      }),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("invalid JSON body \u2192 code: bad_response", async () => {
    const client = makeClient(
      mockFetch(
        () =>
          new Response("not-json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("JSON object missing required evaluate fields \u2192 code: bad_response", async () => {
    const client = makeClient(mockFetch(() => jsonResponse({ foo: "bar" })));
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("JSON object missing required verifyPermit fields \u2192 code: bad_response", async () => {
    const client = makeClient(mockFetch(() => jsonResponse({ outcome: "ok" })));
    await expect(client.verifyPermit({ permitId: "x" })).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});
