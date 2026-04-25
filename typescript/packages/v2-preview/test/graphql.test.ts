/**
 * GraphQL client test suite.
 *
 * Strategy: stub `fetch` via the constructor option and exercise
 * the wire shape, headers, error taxonomy, GraphQL-error-vs-throw
 * boundary, and timeout / network failure paths.
 *
 * Mirrors the v1 client.test.ts patterns so the GraphQL client
 * inherits the same test discipline.
 */

import { describe, expect, it, vi, type MockedFunction } from "vitest";

import {
  buildGraphQLRequest,
  GraphQLClient,
  GraphQLClientError,
} from "../src/graphql/client.js";

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

function makeClient(
  fetchImpl: FetchMock,
  overrides: Partial<ConstructorParameters<typeof GraphQLClient>[0]> = {},
) {
  return new GraphQLClient({
    endpoint: "https://api.atlasent.io/v2/graphql",
    apiKey: "ask_live_test",
    fetch: fetchImpl,
    timeoutMs: 5_000,
    ...overrides,
  });
}

describe("buildGraphQLRequest", () => {
  it("returns a request body with just the query when no variables", () => {
    const body = buildGraphQLRequest("query { policies { id } }");
    expect(body).toEqual({ query: "query { policies { id } }" });
    expect(body.variables).toBeUndefined();
    expect(body.operationName).toBeUndefined();
  });

  it("includes variables when provided", () => {
    const body = buildGraphQLRequest(
      "query Policies($filter: PolicyFilter) { policies(filter: $filter) { id } }",
      { filter: { active: true } },
    );
    expect(body.variables).toEqual({ filter: { active: true } });
  });

  it("includes operationName when provided", () => {
    const body = buildGraphQLRequest(
      "query Policies { policies { id } }",
      undefined,
      "Policies",
    );
    expect(body.operationName).toBe("Policies");
    expect(body.variables).toBeUndefined();
  });

  it("rejects an empty query", () => {
    expect(() => buildGraphQLRequest("")).toThrow(/non-empty/i);
  });

  it("rejects a non-string query", () => {
    expect(() =>
      buildGraphQLRequest(undefined as unknown as string),
    ).toThrow(/non-empty/i);
  });
});

describe("GraphQLClient constructor", () => {
  it("throws when endpoint is missing", () => {
    expect(
      () =>
        new GraphQLClient({
          endpoint: "",
          apiKey: "k",
        }),
    ).toThrow(/endpoint/i);
  });

  it("throws when apiKey is missing", () => {
    expect(
      () =>
        new GraphQLClient({
          endpoint: "https://x",
          apiKey: "",
        }),
    ).toThrow(/apikey/i);
  });
});

describe("GraphQLClient.query — wire shape", () => {
  it("POSTs JSON to the configured endpoint", async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe("https://api.atlasent.io/v2/graphql");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        query: "query { policies { id } }",
        variables: { active: true },
        operationName: "Policies",
      });
      return jsonResponse({ data: { policies: [{ id: "p1" }] } });
    });
    const client = makeClient(fetchImpl);
    const result = await client.query<{ policies: { id: string }[] }>(
      "query { policies { id } }",
      { active: true },
      "Policies",
    );
    expect(result.data).toEqual({ policies: [{ id: "p1" }] });
    expect(result.errors).toBeUndefined();
  });

  it("sets Authorization, Content-Type, Accept, User-Agent, X-Request-ID", async () => {
    const fetchImpl = mockFetch((_, init) => {
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ask_live_test");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers.Accept).toBe("application/json");
      expect(headers["User-Agent"]).toMatch(/@atlasent\/sdk-v2-preview/);
      expect(headers["X-Request-ID"]).toMatch(/^[0-9a-f-]{36}$/);
      return jsonResponse({ data: null });
    });
    await makeClient(fetchImpl).query("query { _ }");
  });

  it("merges custom headers but cannot overwrite locked ones", async () => {
    const fetchImpl = mockFetch((_, init) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Tenant-Id"]).toBe("tenant-1");
      // Even though we asked for a different Authorization, the locked
      // value wins — protects against accidental key leakage.
      expect(headers.Authorization).toBe("Bearer ask_live_test");
      return jsonResponse({ data: null });
    });
    const client = makeClient(fetchImpl, {
      headers: {
        "X-Tenant-Id": "tenant-1",
        Authorization: "Bearer impostor",
      },
    });
    await client.query("query { _ }");
  });
});

describe("GraphQLClient.query — response handling", () => {
  it("returns errors in the envelope (not thrown) on a 200 with errors", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        data: null,
        errors: [
          {
            message: "Policy not found",
            path: ["policies", 0],
            extensions: { code: "NOT_FOUND" },
          },
        ],
      }),
    );
    const result = await makeClient(fetchImpl).query("query { _ }");
    expect(result.data).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.message).toBe("Policy not found");
    expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  it("supports partial success (data + errors both populated)", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        data: { policies: [{ id: "p1" }] },
        errors: [{ message: "warning: 1 policy redacted" }],
      }),
    );
    const result = await makeClient(fetchImpl).query("query { _ }");
    expect(result.data).toBeTruthy();
    expect(result.errors).toHaveLength(1);
  });

  it("preserves extensions in the response envelope", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ data: null, extensions: { tracing: { duration: 42 } } }),
    );
    const result = await makeClient(fetchImpl).query("query { _ }");
    expect(result.extensions).toEqual({ tracing: { duration: 42 } });
  });
});

describe("GraphQLClient.query — error taxonomy", () => {
  it("throws GraphQLClientError(http_error) on 4xx", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response("bad request", {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    await expect(makeClient(fetchImpl).query("query { _ }")).rejects.toMatchObject(
      { code: "http_error", status: 400 },
    );
  });

  it("throws GraphQLClientError(http_error) on 5xx", async () => {
    const fetchImpl = mockFetch(
      () => new Response("upstream", { status: 503 }),
    );
    await expect(
      makeClient(fetchImpl).query("query { _ }"),
    ).rejects.toMatchObject({ code: "http_error", status: 503 });
  });

  it("throws GraphQLClientError(parse_error) on non-JSON 200", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response("not json at all", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(makeClient(fetchImpl).query("query { _ }")).rejects.toMatchObject(
      { code: "parse_error" },
    );
  });

  it("throws GraphQLClientError(invalid_response) when body is not an object", async () => {
    const fetchImpl = mockFetch(() => jsonResponse([1, 2, 3]));
    await expect(makeClient(fetchImpl).query("query { _ }")).rejects.toMatchObject(
      { code: "invalid_response" },
    );
  });

  it("throws GraphQLClientError(network) on fetch rejection", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchMock;
    await expect(makeClient(fetchImpl).query("query { _ }")).rejects.toMatchObject(
      { code: "network" },
    );
  });

  it("throws GraphQLClientError(timeout) when AbortSignal.timeout fires", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("aborted", "TimeoutError");
    }) as unknown as FetchMock;
    await expect(makeClient(fetchImpl).query("query { _ }")).rejects.toMatchObject(
      { code: "timeout" },
    );
  });

  it("throws GraphQLClientError(timeout) on AbortError name (older runtimes)", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as FetchMock;
    await expect(makeClient(fetchImpl).query("query { _ }")).rejects.toMatchObject(
      { code: "timeout" },
    );
  });

  it("rethrows GraphQLClientError verbatim from the fetch boundary", async () => {
    const original = new GraphQLClientError("custom", { code: "network" });
    const fetchImpl = vi.fn(async () => {
      throw original;
    }) as unknown as FetchMock;
    await expect(makeClient(fetchImpl).query("query { _ }")).rejects.toBe(
      original,
    );
  });
});
