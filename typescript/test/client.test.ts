import { describe, expect, it, vi, type MockedFunction } from "vitest";

import { AtlaSentClient, AtlaSentError } from "../src/index.js";

type FetchMock = MockedFunction<typeof fetch>;

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

  it("rejects malformed apiKey", () => {
    expect(() => new AtlaSentClient({ apiKey: "not_a_real_key" })).toThrow(/ask_/);
  });

  it("rejects whitespace-padded apiKey", () => {
    expect(
      () => new AtlaSentClient({ apiKey: " ask_test_xxxxxxxx " }),
    ).toThrow(/ask_/);
  });

  it("accepts ask_live_ and ask_test_ prefixes", () => {
    expect(() => new AtlaSentClient({ apiKey: "ask_live_abc123" })).not.toThrow();
    expect(() => new AtlaSentClient({ apiKey: "ask_test_abc123" })).not.toThrow();
  });

  it("strips trailing slashes from baseUrl", () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl, { baseUrl: "https://staging.atlasent.io///" });
    return client.evaluate({ agent: "a", action: "b" }).then(() => {
      const [url] = fetchImpl.mock.calls[0]!;
      expect(url).toBe("https://staging.atlasent.io/v1-evaluate");
    });
  });

  it("rejects http:// baseUrl", () => {
    expect(
      () => new AtlaSentClient({ apiKey: "ask_test_xxxxxxxx", baseUrl: "http://api.atlasent.io" }),
    ).toThrow(/https/);
  });

  it("allows http:// when ATLASENT_ALLOW_INSECURE_HTTP=1", () => {
    const prev = process.env.ATLASENT_ALLOW_INSECURE_HTTP;
    process.env.ATLASENT_ALLOW_INSECURE_HTTP = "1";
    try {
      const c = new AtlaSentClient({ apiKey: "ask_test_xxxxxxxx", baseUrl: "http://localhost:8000" });
      expect(c).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.ATLASENT_ALLOW_INSECURE_HTTP;
      else process.env.ATLASENT_ALLOW_INSECURE_HTTP = prev;
    }
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
      // Headerless response → no rate-limit state surfaced.
      rateLimit: null,
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
      action_type: "act",
      actor_id: "agent-X",
      context: { u: "v" },
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

  it("maps permit_hash → permitHash", async () => {
    const client = makeClient(mockFetch(() => jsonResponse(VERIFY_OK_WIRE)));
    const result = await client.verifyPermit({ permitId: "dec_alpha" });
    expect(result.permitHash).toBe("permit_alpha");
    expect(result.verified).toBe(true);
  });

  it("sends the wire-format body with permit_id → permit_token (canonical)", async () => {
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
    // Canonical wire — no `context`, no `api_key`. Verify handler reads
    // only permit_token / action_type / actor_id.
    expect(body).toEqual({
      permit_token: "dec_alpha",
      action_type: "read_phi",
      actor_id: "agent-1",
    });
  });
});

describe("HTTP error mapping", () => {
  it("401 → AtlaSentError(code: invalid_api_key)", async () => {
    const client = makeClient(
      mockFetch(() => new Response("unauthorized", { status: 401 })),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      name: "AtlaSentError",
      status: 401,
      code: "invalid_api_key",
    });
  });

  it("403 → AtlaSentError(code: forbidden)", async () => {
    const client = makeClient(
      mockFetch(() => new Response("nope", { status: 403 })),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
  });

  it("429 → AtlaSentError(code: rate_limited) with retryAfterMs from Retry-After header", async () => {
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

  it("429 → retryAfterMs parsed from HTTP-date Retry-After header", async () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const client = makeClient(
      mockFetch(() =>
        new Response("too many", {
          status: 429,
          headers: { "Retry-After": future },
        }),
      ),
    );
    let thrown: AtlaSentError | undefined;
    try {
      await client.evaluate({ agent: "a", action: "b" });
    } catch (err) {
      thrown = err as AtlaSentError;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.code).toBe("rate_limited");
    // Allow some slack for scheduling; the header encodes ~45s out.
    expect(thrown!.retryAfterMs).toBeGreaterThan(30_000);
    expect(thrown!.retryAfterMs).toBeLessThanOrEqual(45_000);
  });

  it("429 → Retry-After HTTP-date in the past clamps to 0", async () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    const client = makeClient(
      mockFetch(() =>
        new Response("too many", {
          status: 429,
          headers: { "Retry-After": past },
        }),
      ),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 0,
    });
  });

  it("500 with a body whose .text() throws still yields code: server_error", async () => {
    // Simulate a Response whose body stream errors on consumption — the
    // SDK should swallow the read failure and fall back to a default
    // server_error message rather than crash.
    const client = makeClient(
      mockFetch(() => {
        const response = new Response(null, { status: 500 });
        Object.defineProperty(response, "text", {
          value: () => Promise.reject(new Error("stream broken")),
        });
        return response;
      }),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      status: 500,
      code: "server_error",
    });
  });

  it("500 → AtlaSentError(code: server_error)", async () => {
    const client = makeClient(
      mockFetch(() => new Response("oops", { status: 500 })),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      status: 500,
      code: "server_error",
    });
  });

  it("422 (other 4xx) → AtlaSentError(code: bad_request) surfaces server message", async () => {
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

  it("generic AbortError (non-DOMException) also maps to code: timeout", async () => {
    // Some runtimes surface an Error whose name is "AbortError" rather
    // than a DOMException("TimeoutError"). Both should map to timeout.
    const client = makeClient(
      mockFetch(() => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }),
    );
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("invalid JSON body → code: bad_response", async () => {
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

  it("JSON object missing required evaluate fields → code: bad_response", async () => {
    const client = makeClient(mockFetch(() => jsonResponse({ foo: "bar" })));
    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("JSON object missing required verifyPermit fields → code: bad_response", async () => {
    const client = makeClient(mockFetch(() => jsonResponse({ outcome: "ok" })));
    await expect(client.verifyPermit({ permitId: "x" })).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});

describe("X-RateLimit-* header parsing", () => {
  const RESET_SECONDS = 1_714_068_060; // 2026-05-12 arbitrary instant
  const RESET_DATE_MS = RESET_SECONDS * 1000;

  function rateLimitResponse(
    body: unknown,
    headers: Record<string, string>,
  ): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  it("exposes rateLimit on evaluate when all three headers are present", async () => {
    const client = makeClient(
      mockFetch(() =>
        rateLimitResponse(EVALUATE_PERMIT_WIRE, {
          "X-RateLimit-Limit": "1000",
          "X-RateLimit-Remaining": "762",
          "X-RateLimit-Reset": String(RESET_SECONDS),
        }),
      ),
    );
    const result = await client.evaluate({ agent: "a", action: "b" });
    expect(result.rateLimit).toEqual({
      limit: 1000,
      remaining: 762,
      resetAt: new Date(RESET_DATE_MS),
    });
  });

  it("exposes rateLimit on verifyPermit when all three headers are present", async () => {
    const client = makeClient(
      mockFetch(() =>
        rateLimitResponse(VERIFY_OK_WIRE, {
          "X-RateLimit-Limit": "600",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(RESET_SECONDS),
        }),
      ),
    );
    const result = await client.verifyPermit({ permitId: "dec_alpha" });
    expect(result.rateLimit).toEqual({
      limit: 600,
      remaining: 0,
      resetAt: new Date(RESET_DATE_MS),
    });
  });

  it("accepts ISO 8601 string for X-RateLimit-Reset", async () => {
    const iso = new Date(RESET_DATE_MS).toISOString();
    const client = makeClient(
      mockFetch(() =>
        rateLimitResponse(EVALUATE_PERMIT_WIRE, {
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": "50",
          "X-RateLimit-Reset": iso,
        }),
      ),
    );
    const result = await client.evaluate({ agent: "a", action: "b" });
    expect(result.rateLimit?.resetAt.getTime()).toBe(RESET_DATE_MS);
  });

  it("rateLimit === null when headers absent (older deployments)", async () => {
    const client = makeClient(mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE)));
    const result = await client.evaluate({ agent: "a", action: "b" });
    expect(result.rateLimit).toBeNull();
  });

  it("rateLimit === null when one header is missing", async () => {
    const client = makeClient(
      mockFetch(() =>
        rateLimitResponse(EVALUATE_PERMIT_WIRE, {
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": "50",
          // Reset intentionally missing
        }),
      ),
    );
    const result = await client.evaluate({ agent: "a", action: "b" });
    expect(result.rateLimit).toBeNull();
  });

  it("rateLimit === null when numeric header is NaN", async () => {
    const client = makeClient(
      mockFetch(() =>
        rateLimitResponse(EVALUATE_PERMIT_WIRE, {
          "X-RateLimit-Limit": "not-a-number",
          "X-RateLimit-Remaining": "50",
          "X-RateLimit-Reset": String(RESET_SECONDS),
        }),
      ),
    );
    const result = await client.evaluate({ agent: "a", action: "b" });
    expect(result.rateLimit).toBeNull();
  });

  it("rateLimit === null when reset header is unparseable", async () => {
    const client = makeClient(
      mockFetch(() =>
        rateLimitResponse(EVALUATE_PERMIT_WIRE, {
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": "50",
          "X-RateLimit-Reset": "whenever",
        }),
      ),
    );
    const result = await client.evaluate({ agent: "a", action: "b" });
    expect(result.rateLimit).toBeNull();
  });
});

describe("keySelf()", () => {
  const KEY_SELF_WIRE = {
    key_id: "550e8400-e29b-41d4-a716-446655440000",
    organization_id: "123e4567-e89b-12d3-a456-426614174000",
    environment: "live",
    scopes: ["evaluate", "audit.read"],
    allowed_cidrs: ["10.0.0.0/8"],
    rate_limit_per_minute: 1000,
    client_ip: "10.2.3.4",
    expires_at: "2026-12-31T23:59:59Z",
  };

  it("issues a GET to /v1-api-key-self and maps snake_case → camelCase", async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toMatch(/\/v1-api-key-self$/);
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer ask_live_test",
      );
      return jsonResponse(KEY_SELF_WIRE);
    });
    const client = makeClient(fetchImpl);
    const result = await client.keySelf();

    expect(result).toEqual({
      keyId: "550e8400-e29b-41d4-a716-446655440000",
      organizationId: "123e4567-e89b-12d3-a456-426614174000",
      environment: "live",
      scopes: ["evaluate", "audit.read"],
      allowedCidrs: ["10.0.0.0/8"],
      rateLimitPerMinute: 1000,
      clientIp: "10.2.3.4",
      expiresAt: "2026-12-31T23:59:59Z",
      // Headerless response → no rate-limit state surfaced.
      rateLimit: null,
    });
  });

  it("surfaces rateLimit when X-RateLimit-* headers are present", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(JSON.stringify(KEY_SELF_WIRE), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Limit": "1000",
          "X-RateLimit-Remaining": "987",
          "X-RateLimit-Reset": "1714068060",
        },
      }),
    );
    const client = makeClient(fetchImpl);
    const result = await client.keySelf();
    expect(result.rateLimit).toEqual({
      limit: 1000,
      remaining: 987,
      resetAt: new Date(1_714_068_060 * 1000),
    });
  });

  it("defaults allowed_cidrs to null and expires_at to null when absent", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        key_id: "k",
        organization_id: "o",
        environment: "test",
        rate_limit_per_minute: 60,
        // allowed_cidrs, client_ip, expires_at, scopes all omitted
      }),
    );
    const client = makeClient(fetchImpl);
    const result = await client.keySelf();
    expect(result.allowedCidrs).toBeNull();
    expect(result.clientIp).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.scopes).toEqual([]);
  });

  it("throws bad_response when required fields are missing", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ environment: "live", rate_limit_per_minute: 60 }),
    );
    const client = makeClient(fetchImpl);
    await expect(client.keySelf()).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("propagates 401 as a typed AtlaSentError", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(JSON.stringify({ error: "invalid_api_key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = makeClient(fetchImpl);
    await expect(client.keySelf()).rejects.toBeInstanceOf(AtlaSentError);
  });
});

describe("listAuditEvents()", () => {
  const EVENT_ALPHA = {
    id: "evt_a",
    org_id: "org-1",
    sequence: 1,
    type: "evaluate.allow",
    decision: "allow" as const,
    actor_id: "agent-1",
    resource_type: null,
    resource_id: null,
    payload: { action: "read_data" },
    hash: "a".repeat(64),
    previous_hash: "0".repeat(64),
    occurred_at: "2026-04-21T00:00:00Z",
    created_at: "2026-04-21T00:00:01Z",
  };

  const EVENTS_PAGE_WIRE = {
    events: [EVENT_ALPHA],
    total: 1,
    next_cursor: "cursor_beta",
  };

  it("issues a GET to /v1-audit/events and preserves snake_case wire fields", async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toMatch(/\/v1-audit\/events$/);
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer ask_live_test",
      );
      return jsonResponse(EVENTS_PAGE_WIRE);
    });
    const client = makeClient(fetchImpl);
    const result = await client.listAuditEvents();

    expect(result.total).toBe(1);
    expect(result.next_cursor).toBe("cursor_beta");
    expect(result.events[0]).toMatchObject({
      id: "evt_a",
      previous_hash: "0".repeat(64),
      hash: "a".repeat(64),
      decision: "allow",
    });
    expect(result.rateLimit).toBeNull();
  });

  it("serializes all query fields as snake_case URL params", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toContain("/v1-audit/events?");
      const parsed = new URL(url);
      expect(parsed.searchParams.get("types")).toBe(
        "evaluate.allow,policy.updated",
      );
      expect(parsed.searchParams.get("actor_id")).toBe("agent-1");
      expect(parsed.searchParams.get("from")).toBe("2026-04-20T00:00:00Z");
      expect(parsed.searchParams.get("to")).toBe("2026-04-22T00:00:00Z");
      expect(parsed.searchParams.get("limit")).toBe("25");
      expect(parsed.searchParams.get("cursor")).toBe("abc");
      return jsonResponse({ events: [], total: 0 });
    });
    const client = makeClient(fetchImpl);
    await client.listAuditEvents({
      types: "evaluate.allow,policy.updated",
      actor_id: "agent-1",
      from: "2026-04-20T00:00:00Z",
      to: "2026-04-22T00:00:00Z",
      limit: 25,
      cursor: "abc",
    });
  });

  it("sends no query string when the filter is empty", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toMatch(/\/v1-audit\/events$/);
      expect(url).not.toContain("?");
      return jsonResponse({ events: [], total: 0 });
    });
    const client = makeClient(fetchImpl);
    await client.listAuditEvents({});
  });

  it("surfaces rateLimit when X-RateLimit-* headers are present", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(JSON.stringify(EVENTS_PAGE_WIRE), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Limit": "500",
          "X-RateLimit-Remaining": "499",
          "X-RateLimit-Reset": "1714070000",
        },
      }),
    );
    const client = makeClient(fetchImpl);
    const result = await client.listAuditEvents();
    expect(result.rateLimit).toEqual({
      limit: 500,
      remaining: 499,
      resetAt: new Date(1_714_070_000 * 1000),
    });
  });

  it("throws bad_response when events is not an array", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ total: 0 }));
    const client = makeClient(fetchImpl);
    await expect(client.listAuditEvents()).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("throws bad_response when total is missing", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ events: [] }));
    const client = makeClient(fetchImpl);
    await expect(client.listAuditEvents()).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});

describe("createAuditExport()", () => {
  const BUNDLE_WIRE = {
    export_id: "export-1",
    org_id: "org-1",
    events: [
      {
        id: "evt-1",
        org_id: "org-1",
        sequence: 1,
        type: "policy.event",
        decision: null,
        actor_id: "actor-1",
        resource_type: "policy",
        resource_id: "policy-1",
        payload: { action: "create" },
        hash: "a".repeat(64),
        previous_hash: "0".repeat(64),
        occurred_at: "2026-04-21T00:00:00Z",
        created_at: "2026-04-21T00:00:00Z",
      },
    ],
    chain_head_hash: "a".repeat(64),
    chain_integrity_ok: true,
    tampered_event_ids: [],
    signature: "sig_bytes_base64url",
    signature_status: "signed" as const,
    signing_key_id: "test-key",
    signed_at: "2026-04-21T00:00:00Z",
    event_count: 1,
  };

  it("POSTs to /v1-audit/exports with an empty body by default and returns the bundle verbatim", async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toMatch(/\/v1-audit\/exports$/);
      expect(init.method).toBe("POST");
      expect(init.body).toBe("{}");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/json",
      );
      return jsonResponse(BUNDLE_WIRE);
    });
    const client = makeClient(fetchImpl);
    const result = await client.createAuditExport();

    expect(result.export_id).toBe("export-1");
    expect(result.chain_head_hash).toBe("a".repeat(64));
    expect(result.signature).toBe("sig_bytes_base64url");
    expect(result.signature_status).toBe("signed");
    expect(result.signing_key_id).toBe("test-key");
    expect(result.events).toHaveLength(1);
    expect(result.rateLimit).toBeNull();
  });

  it("forwards the filter fields as JSON body", async () => {
    const fetchImpl = mockFetch((url, init) => {
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        types: "evaluate.allow",
        actor_id: "agent-1",
        from: "2026-04-20T00:00:00Z",
        to: "2026-04-22T00:00:00Z",
      });
      return jsonResponse(BUNDLE_WIRE);
    });
    const client = makeClient(fetchImpl);
    await client.createAuditExport({
      types: "evaluate.allow",
      actor_id: "agent-1",
      from: "2026-04-20T00:00:00Z",
      to: "2026-04-22T00:00:00Z",
    });
  });

  it("surfaces rateLimit when X-RateLimit-* headers are present", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(JSON.stringify(BUNDLE_WIRE), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Limit": "10",
          "X-RateLimit-Remaining": "9",
          "X-RateLimit-Reset": "1714070000",
        },
      }),
    );
    const client = makeClient(fetchImpl);
    const result = await client.createAuditExport();
    expect(result.rateLimit).toEqual({
      limit: 10,
      remaining: 9,
      resetAt: new Date(1_714_070_000 * 1000),
    });
  });

  it("throws bad_response when export_id is missing", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ chain_head_hash: "x", events: [] }),
    );
    const client = makeClient(fetchImpl);
    await expect(client.createAuditExport()).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("throws bad_response when events is not an array", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ export_id: "e", chain_head_hash: "x" }),
    );
    const client = makeClient(fetchImpl);
    await expect(client.createAuditExport()).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});

describe("response-shape error paths", () => {
  // These guard against stream-or-non-stream JSON malformation that
  // sneaks past the HTTP layer (200 OK, but the body isn't a JSON
  // object). All three paths flow through `post()` so any endpoint
  // call exercises them; we use evaluate() because it's the simplest.

  it("throws bad_response when the body is not parseable JSON", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response("<!doctype html>oops", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = makeClient(fetchImpl);
    await expect(
      client.evaluate({ agent: "a", action: "b" }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("throws bad_response when the body parses to a non-object (null)", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(null));
    const client = makeClient(fetchImpl);
    await expect(
      client.evaluate({ agent: "a", action: "b" }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("throws bad_response when the body parses to a primitive", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(42));
    const client = makeClient(fetchImpl);
    await expect(
      client.evaluate({ agent: "a", action: "b" }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("revokePermit()", () => {
  // Wire shape mirrors the server response: snake_case, decision_id is the
  // permit identifier the SDK exposes as permitId.
  const REVOKE_OK_WIRE = {
    revoked: true,
    decision_id: "dec_to_revoke",
    revoked_at: "2026-04-30T01:00:00Z",
    audit_hash: "hash_revoked",
  };

  it("POSTs to /v1-revoke-permit with decision_id + reason and returns the SDK shape", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(REVOKE_OK_WIRE));
    const client = makeClient(fetchImpl);

    const result = await client.revokePermit({
      permitId: "dec_to_revoke",
      reason: "policy violation",
    });

    expect(fetchImpl.mock.calls).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/v1-revoke-permit");
    expect(init!.method).toBe("POST");
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      decision_id: "dec_to_revoke",
      reason: "policy violation",
      api_key: "ask_live_test",
    });

    expect(result).toMatchObject({
      revoked: true,
      permitId: "dec_to_revoke",
      revokedAt: "2026-04-30T01:00:00Z",
      auditHash: "hash_revoked",
    });
  });

  it("defaults reason to empty string when omitted", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(REVOKE_OK_WIRE));
    const client = makeClient(fetchImpl);
    await client.revokePermit({ permitId: "dec_to_revoke" });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.reason).toBe("");
  });

  it("surfaces revoked=false from the server without throwing", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ ...REVOKE_OK_WIRE, revoked: false }),
    );
    const client = makeClient(fetchImpl);
    const result = await client.revokePermit({ permitId: "dec_to_revoke" });
    expect(result.revoked).toBe(false);
  });

  it("throws bad_response when revoked is not a boolean", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ ...REVOKE_OK_WIRE, revoked: "yes" }),
    );
    const client = makeClient(fetchImpl);
    await expect(
      client.revokePermit({ permitId: "dec_to_revoke" }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("throws bad_response when decision_id is missing", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ revoked: true }),
    );
    const client = makeClient(fetchImpl);
    await expect(
      client.revokePermit({ permitId: "dec_to_revoke" }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });
});
