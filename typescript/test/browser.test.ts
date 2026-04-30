// @vitest-environment jsdom
/**
 * Browser-environment smoke tests for AtlaSentClient.
 *
 * Runs in jsdom so the DOM globals (Response, Headers, DOMException, etc.)
 * come from jsdom rather than Node builtins.  Validates that the client
 * works end-to-end without referencing `process`, `Buffer`, or other
 * Node-only globals at request time.
 *
 * Note on the User-Agent header: vitest runs test code inside Node even
 * when the environment is "jsdom", so `NODE_VERSION` is captured at
 * module-load time and the UA reads `node/<version>` in this context.
 * The real browser path (where `process` never exists) is exercised by
 * the module-level `isNode` check — the eager `NODE_VERSION` capture
 * ensures `process` is never accessed lazily in the request path.
 */
import { describe, expect, it, vi, type MockedFunction } from "vitest";

import { AtlaSentClient, AtlaSentError } from "../src/index.js";

type FetchMock = MockedFunction<typeof fetch>;

const EVALUATE_PERMIT_WIRE = {
  permitted: true,
  decision_id: "dec_browser_001",
  reason: "Allowed by policy",
  audit_hash: "hash_browser_001",
  timestamp: "2026-04-30T00:00:00Z",
};

const EVALUATE_DENY_WIRE = {
  permitted: false,
  decision_id: "dec_browser_002",
  reason: "Denied by policy",
  audit_hash: "hash_browser_002",
  timestamp: "2026-04-30T00:00:01Z",
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

function makeClient(fetchImpl: FetchMock) {
  return new AtlaSentClient({
    apiKey: "ask_live_browser_test",
    fetch: fetchImpl,
    timeoutMs: 5_000,
  });
}

describe("AtlaSentClient — browser environment (jsdom)", () => {
  it("constructs without throwing", () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    expect(() => makeClient(fetchImpl)).not.toThrow();
  });

  it("evaluate() round-trips an ALLOW", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl);

    const result = await client.evaluate({
      agent: "browser-agent",
      action: "read_dashboard",
      context: { userId: "u_123" },
    });

    expect(result.decision).toBe("ALLOW");
    expect(result.permitId).toBe("dec_browser_001");
    expect(result.reason).toBe("Allowed by policy");
    expect(result.rateLimit).toBeNull();
  });

  it("evaluate() DENY response is returned, not thrown", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_DENY_WIRE));
    const client = makeClient(fetchImpl);

    const result = await client.evaluate({ agent: "browser-agent", action: "admin_action" });

    expect(result.decision).toBe("DENY");
    expect(result.permitId).toBe("dec_browser_002");
  });

  it("User-Agent header is set and follows the expected SDK format", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl);

    await client.evaluate({ agent: "a", action: "b" });

    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    // The UA is either "node/<version>" (when running under Node/jsdom) or
    // "browser" (in a real browser where process is absent from module load).
    // Either way it must start with the SDK version prefix.
    expect(headers["User-Agent"]).toMatch(
      /^@atlasent\/sdk\/\d+\.\d+\.\d+ (node\/.+|browser)$/,
    );
  });

  it("sets Authorization and X-Request-ID headers", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE));
    const client = makeClient(fetchImpl);

    await client.evaluate({ agent: "a", action: "b" });

    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ask_live_browser_test");
    expect(headers["X-Request-ID"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("throws AtlaSentError on HTTP 401", async () => {
    const fetchImpl = mockFetch(() => new Response("unauthorized", { status: 401 }));
    const client = makeClient(fetchImpl);

    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      name: "AtlaSentError",
      status: 401,
      code: "invalid_api_key",
    });
  });

  it("throws AtlaSentError(code: network) on fetch failure", async () => {
    const fetchImpl = mockFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const client = makeClient(fetchImpl);

    await expect(client.evaluate({ agent: "a", action: "b" })).rejects.toMatchObject({
      name: "AtlaSentError",
      code: "network",
    });
  });

  it("constructor throws a clear error when AbortSignal.timeout is unavailable", () => {
    // Simulate an older browser that lacks AbortSignal.timeout.
    const original = AbortSignal.timeout;
    try {
      // @ts-expect-error — intentionally deleting to simulate old browser
      delete AbortSignal.timeout;
      expect(() => makeClient(mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE)))).toThrow(
        AtlaSentError,
      );
      expect(() => makeClient(mockFetch(() => jsonResponse(EVALUATE_PERMIT_WIRE)))).toThrow(
        /AbortSignal\.timeout/,
      );
    } finally {
      AbortSignal.timeout = original;
    }
  });
});

