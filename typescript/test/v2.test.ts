/**
 * Tests for the V2 Wave-A endpoints (V2-D3/D4/D8).
 *
 * Covers: happy paths, flag-off 404 → FeatureNotEnabledError, transport
 * errors, SSE parser edge cases, and input validation.
 */

import { describe, expect, it, vi } from "vitest";

import { AtlaSentError } from "../src/errors.js";
import {
  authorizeStream,
  evaluateMany,
  FeatureNotEnabledError,
  graphql,
  V2_BATCH_PATH,
  V2_GRAPHQL_PATH,
  V2_MAX_BATCH_ITEMS,
  V2_STREAM_PATH,
  type StreamDecisionFrame,
  type StreamErrorFrame,
  type V2Transport,
} from "../src/v2.js";

const BASE = "https://api.atlasent.io";
const API_KEY = "ask_test_v2wave";
const VALID_BATCH_ID = "12345678-1234-5678-1234-567812345678";

// ── helpers ────────────────────────────────────────────────────────────

function makeFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  // Cast through `unknown` because the global `fetch` type
  // signature varies slightly between Node versions.
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(responder(String(url), init ?? {}))) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Request-ID": "req_v2_test",
    ...(init.headers ?? {}),
  });
  return new Response(JSON.stringify(body), {
    ...init,
    status: init.status ?? 200,
    headers,
  });
}

function sseResponse(lines: ReadonlyArray<string>, status = 200): Response {
  // Build a ReadableStream<Uint8Array> from the lines.
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream", "X-Request-ID": "req_v2_stream" },
  });
}

function makeTransport(responder: Parameters<typeof makeFetch>[0]): V2Transport {
  return { baseUrl: BASE, apiKey: API_KEY, fetch: makeFetch(responder) };
}

// ── FeatureNotEnabledError ─────────────────────────────────────────────

describe("FeatureNotEnabledError", () => {
  it("exposes feature, endpoint, status, and code", () => {
    const err = new FeatureNotEnabledError({
      feature: "batch",
      endpoint: V2_BATCH_PATH,
    });
    expect(err.feature).toBe("batch");
    expect(err.endpoint).toBe(V2_BATCH_PATH);
    expect(err.status).toBe(404);
    expect(err.code).toBe("feature_disabled");
    expect(err.name).toBe("FeatureNotEnabledError");
    expect(err.message).toContain("v2_batch");
  });

  it("is an instance of AtlaSentError", () => {
    const err = new FeatureNotEnabledError({
      feature: "streaming",
      endpoint: V2_STREAM_PATH,
    });
    expect(err).toBeInstanceOf(AtlaSentError);
  });

  it("forwards requestId when supplied", () => {
    const err = new FeatureNotEnabledError({
      feature: "graphql",
      endpoint: V2_GRAPHQL_PATH,
      requestId: "req_abc",
    });
    expect(err.requestId).toBe("req_abc");
  });
});

// ── evaluateMany ──────────────────────────────────────────────────────────

describe("evaluateMany", () => {
  it("posts the batch body and parses the response in input order", async () => {
    let captured: { url: string; body: string } = { url: "", body: "" };
    const transport = makeTransport((url, init) => {
      captured = { url, body: String(init.body) };
      return jsonResponse({
        batch_id: VALID_BATCH_ID,
        items: [
          {
            index: 0,
            decision: "allow",
            decision_id: "dec_0",
            permit_token: "pt_0",
          },
          {
            index: 1,
            decision: "deny",
            reason: "policy",
          },
        ],
        partial: false,
      });
    });

    const result = await evaluateMany(transport, {
      items: [
        { action_type: "read", actor_id: "a1" },
        { action_type: "write", actor_id: "a2" },
      ],
      batchId: VALID_BATCH_ID,
    });

    expect(captured.url).toBe(`${BASE}${V2_BATCH_PATH}`);
    const sent = JSON.parse(captured.body) as Record<string, unknown>;
    expect(sent["batch_id"]).toBe(VALID_BATCH_ID);
    expect(result.batchId).toBe(VALID_BATCH_ID);
    expect(result.partial).toBe(false);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.decision).toBe("allow");
    expect(result.items[0]?.permitToken).toBe("pt_0");
    expect(result.items[1]?.decision).toBe("deny");
    expect(result.items[1]?.reason).toBe("policy");
  });

  it("omits batch_id when not provided", async () => {
    let captured = "";
    const transport = makeTransport((_url, init) => {
      captured = String(init.body);
      return jsonResponse({ batch_id: "auto", items: [], partial: false });
    });
    await evaluateMany(transport, {
      items: [{ action_type: "x", actor_id: "y" }],
    });
    const sent = JSON.parse(captured) as Record<string, unknown>;
    expect(sent["batch_id"]).toBeUndefined();
  });

  it("propagates per-item error_code / error_message fields", async () => {
    const transport = makeTransport(() =>
      jsonResponse({
        batch_id: VALID_BATCH_ID,
        items: [
          {
            index: 0,
            error_code: "upstream_timeout",
            error_message: "policy engine timed out",
          },
        ],
        partial: true,
      }),
    );
    const result = await evaluateMany(transport, {
      items: [{ action_type: "x", actor_id: "y" }],
    });
    expect(result.partial).toBe(true);
    expect(result.items[0]?.decision).toBeUndefined();
    expect(result.items[0]?.errorCode).toBe("upstream_timeout");
    expect(result.items[0]?.errorMessage).toBe("policy engine timed out");
  });

  it("throws FeatureNotEnabledError on 404", async () => {
    const transport = makeTransport(() =>
      jsonResponse({ error: "off" }, { status: 404 }),
    );
    await expect(
      evaluateMany(transport, { items: [{ action_type: "x" }] }),
    ).rejects.toBeInstanceOf(FeatureNotEnabledError);
  });

  it("throws AtlaSentError(server_error) on 5xx", async () => {
    const transport = makeTransport(() =>
      jsonResponse({ error: "boom" }, { status: 500 }),
    );
    try {
      await evaluateMany(transport, { items: [{ action_type: "x" }] });
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AtlaSentError);
      expect((e as AtlaSentError).code).toBe("server_error");
    }
  });

  it("throws AtlaSentError(bad_request) on 4xx (not 404)", async () => {
    const transport = makeTransport(() =>
      jsonResponse({ error: "bad" }, { status: 400 }),
    );
    try {
      await evaluateMany(transport, { items: [{ action_type: "x" }] });
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AtlaSentError).code).toBe("bad_request");
    }
  });

  it("throws AtlaSentError(bad_response) on malformed JSON", async () => {
    const transport = makeTransport(
      () => new Response("not-json", { status: 200 }),
    );
    try {
      await evaluateMany(transport, { items: [{ action_type: "x" }] });
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AtlaSentError).code).toBe("bad_response");
    }
  });

  it("rejects empty items", async () => {
    const transport = makeTransport(() => jsonResponse({}));
    await expect(evaluateMany(transport, { items: [] })).rejects.toThrow(
      /non-empty/,
    );
  });

  it("rejects oversized items", async () => {
    const transport = makeTransport(() => jsonResponse({}));
    const items = Array.from({ length: V2_MAX_BATCH_ITEMS + 1 }, () => ({
      action_type: "x",
    }));
    await expect(evaluateMany(transport, { items })).rejects.toThrow(
      /exceeds maximum/,
    );
  });

  it("rejects non-UUID batch_id", async () => {
    const transport = makeTransport(() => jsonResponse({}));
    await expect(
      evaluateMany(transport, {
        items: [{ action_type: "x" }],
        batchId: "not-a-uuid",
      }),
    ).rejects.toThrow(/valid UUID/);
  });

  it("rejects oversize body", async () => {
    const transport = makeTransport(() => jsonResponse({}));
    const big = "z".repeat(1_100_000);
    await expect(
      evaluateMany(transport, {
        items: [{ action_type: "x", ctx: big }],
      }),
    ).rejects.toThrow(/exceeds maximum/);
  });
});

// ── authorizeStream ──────────────────────────────────────────────────────────

describe("authorizeStream", () => {
  it("dispatches decision frames and resolves with the complete payload", async () => {
    const lines = [
      "event: decision",
      `data: ${JSON.stringify({ index: 0, decision: "allow", decision_id: "dec_0", permit_token: "pt_0" })}`,
      "",
      "event: decision",
      `data: ${JSON.stringify({ index: 1, decision: "deny", reason: "policy" })}`,
      "",
      "event: complete",
      `data: ${JSON.stringify({ batch_id: VALID_BATCH_ID, count: 2, partial: false })}`,
      "",
    ];
    const transport = makeTransport(() => sseResponse(lines));

    const decisions: StreamDecisionFrame[] = [];
    const errors: StreamErrorFrame[] = [];
    const result = await authorizeStream(
      transport,
      {
        items: [
          { action_type: "read", actor_id: "a" },
          { action_type: "delete", actor_id: "b" },
        ],
        batchId: VALID_BATCH_ID,
      },
      { onDecision: (f) => decisions.push(f), onError: (f) => errors.push(f) },
    );

    expect(result.batchId).toBe(VALID_BATCH_ID);
    expect(result.count).toBe(2);
    expect(result.partial).toBe(false);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.decisionId).toBe("dec_0");
    expect(decisions[1]?.decision).toBe("deny");
    expect(errors).toEqual([]);
  });

  it("dispatches error frames without tearing down the stream", async () => {
    const lines = [
      "event: decision",
      `data: ${JSON.stringify({ index: 0, decision: "allow" })}`,
      "",
      "event: error",
      `data: ${JSON.stringify({ index: 1, error_code: "upstream_timeout", message: "policy engine timeout" })}`,
      "",
      "event: decision",
      `data: ${JSON.stringify({ index: 2, decision: "allow" })}`,
      "",
      "event: complete",
      `data: ${JSON.stringify({ batch_id: VALID_BATCH_ID, count: 3, partial: true })}`,
      "",
    ];
    const transport = makeTransport(() => sseResponse(lines));
    const decisions: StreamDecisionFrame[] = [];
    const errors: StreamErrorFrame[] = [];
    const result = await authorizeStream(
      transport,
      { items: new Array(3).fill({ action_type: "x" }) },
      { onDecision: (f) => decisions.push(f), onError: (f) => errors.push(f) },
    );
    expect(result.partial).toBe(true);
    expect(decisions).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.errorCode).toBe("upstream_timeout");
  });

  it("ignores keep-alive comments and malformed frames", async () => {
    const lines = [
      ": heartbeat",
      "",
      "event: decision",
      "data: not-json-at-all",
      "",
      "event: decision",
      "data: [1,2,3]",
      "",
      "event: complete",
      `data: ${JSON.stringify({ batch_id: "b", count: 0, partial: false })}`,
      "",
    ];
    const transport = makeTransport(() => sseResponse(lines));
    const decisions: StreamDecisionFrame[] = [];
    const result = await authorizeStream(
      transport,
      { items: [{ action_type: "x" }] },
      { onDecision: (f) => decisions.push(f) },
    );
    expect(decisions).toEqual([]);
    expect(result.batchId).toBe("b");
  });

  it("tolerates CRLF line separators", async () => {
    // Build a raw \r\n stream by joining ourselves.
    const transport: V2Transport = {
      baseUrl: BASE,
      apiKey: API_KEY,
      fetch: makeFetch(() => {
        const text =
          "event: complete\r\n" +
          `data: ${JSON.stringify({ batch_id: "b", count: 1, partial: false })}\r\n` +
          "\r\n";
        return new Response(new TextEncoder().encode(text), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    };
    const result = await authorizeStream(transport, {
      items: [{ action_type: "x" }],
    });
    expect(result.count).toBe(1);
  });

  it("throws FeatureNotEnabledError on 404", async () => {
    const transport = makeTransport(() => sseResponse([], 404));
    await expect(
      authorizeStream(transport, { items: [{ action_type: "x" }] }),
    ).rejects.toBeInstanceOf(FeatureNotEnabledError);
  });

  it("throws AtlaSentError(server_error) on 5xx", async () => {
    const transport = makeTransport(() => sseResponse([], 500));
    try {
      await authorizeStream(transport, { items: [{ action_type: "x" }] });
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AtlaSentError).code).toBe("server_error");
    }
  });

  it("throws AtlaSentError(bad_request) on 4xx (not 404)", async () => {
    const transport = makeTransport(() => sseResponse([], 400));
    try {
      await authorizeStream(transport, { items: [{ action_type: "x" }] });
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AtlaSentError).code).toBe("bad_request");
    }
  });

  it("throws when stream closes without a complete frame", async () => {
    const lines = [
      "event: decision",
      `data: ${JSON.stringify({ index: 0, decision: "allow" })}`,
      "",
    ];
    const transport = makeTransport(() => sseResponse(lines));
    await expect(
      authorizeStream(
        transport,
        { items: [{ action_type: "x" }] },
        { onDecision: () => {} },
      ),
    ).rejects.toThrow(/without a `complete`/);
  });

  it("rejects empty items", async () => {
    const transport = makeTransport(() => sseResponse([]));
    await expect(
      authorizeStream(transport, { items: [] }),
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects oversized items", async () => {
    const transport = makeTransport(() => sseResponse([]));
    const items = Array.from({ length: V2_MAX_BATCH_ITEMS + 1 }, () => ({
      action_type: "x",
    }));
    await expect(authorizeStream(transport, { items })).rejects.toThrow(
      /exceeds maximum/,
    );
  });

  it("rejects invalid batchId", async () => {
    const transport = makeTransport(() => sseResponse([]));
    await expect(
      authorizeStream(transport, {
        items: [{ action_type: "x" }],
        batchId: "nope",
      }),
    ).rejects.toThrow(/valid UUID/);
  });

  it("throws on null response body", async () => {
    // Build a Response with body=null (some edge runtimes do this).
    const transport: V2Transport = {
      baseUrl: BASE,
      apiKey: API_KEY,
      fetch: makeFetch(() => new Response(null, { status: 200 })),
    };
    await expect(
      authorizeStream(transport, { items: [{ action_type: "x" }] }),
    ).rejects.toThrow(/no response body/);
  });

  it("works without any handlers (drops decisions silently)", async () => {
    const lines = [
      "event: decision",
      `data: ${JSON.stringify({ index: 0, decision: "allow" })}`,
      "",
      "event: error",
      `data: ${JSON.stringify({ index: 1, error_code: "x", message: "y" })}`,
      "",
      "event: complete",
      `data: ${JSON.stringify({ batch_id: "b", count: 2, partial: true })}`,
      "",
    ];
    const transport = makeTransport(() => sseResponse(lines));
    const result = await authorizeStream(transport, {
      items: new Array(2).fill({ action_type: "x" }),
    });
    expect(result.partial).toBe(true);
  });
});

// ── graphql ───────────────────────────────────────────────────────────

describe("graphql", () => {
  it("returns data on success", async () => {
    let captured = "";
    const transport = makeTransport((_url, init) => {
      captured = String(init.body);
      return jsonResponse({
        data: { recentEvaluations: [{ decisionId: "dec_1" }] },
      });
    });
    const result = await graphql<{
      recentEvaluations: Array<{ decisionId: string }>;
    }>(transport, {
      query: "query Q { recentEvaluations(limit: 10) { decisionId } }",
      variables: { x: 1 },
      operationName: "Q",
    });
    expect(result.data?.recentEvaluations[0]?.decisionId).toBe("dec_1");
    expect(result.errors).toBeUndefined();
    const sent = JSON.parse(captured) as Record<string, unknown>;
    expect(sent["query"]).toContain("recentEvaluations");
    expect(sent["variables"]).toEqual({ x: 1 });
    expect(sent["operationName"]).toBe("Q");
  });

  it("surfaces resolver errors on .errors (does not throw)", async () => {
    const transport = makeTransport(() =>
      jsonResponse({
        data: null,
        errors: [
          { message: "Field 'forbidden' requires policy:read scope." },
        ],
      }),
    );
    const result = await graphql(transport, { query: "{ forbidden }" });
    expect(result.data).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(String(result.errors?.[0]?.["message"])).toContain("policy:read");
  });

  it("omits variables and operationName when not provided", async () => {
    let captured = "";
    const transport = makeTransport((_url, init) => {
      captured = String(init.body);
      return jsonResponse({ data: { activeBundle: { id: "b_1" } } });
    });
    await graphql(transport, { query: "{ activeBundle { id } }" });
    const sent = JSON.parse(captured) as Record<string, unknown>;
    expect(sent["variables"]).toBeUndefined();
    expect(sent["operationName"]).toBeUndefined();
  });

  it("throws FeatureNotEnabledError on 404", async () => {
    const transport = makeTransport(() =>
      jsonResponse({ error: "off" }, { status: 404 }),
    );
    try {
      await graphql(transport, { query: "{ activeBundle { id } }" });
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FeatureNotEnabledError);
      expect((e as FeatureNotEnabledError).feature).toBe("graphql");
    }
  });

  it("throws AtlaSentError(server_error) on 5xx", async () => {
    const transport = makeTransport(() =>
      jsonResponse({ error: "boom" }, { status: 500 }),
    );
    try {
      await graphql(transport, { query: "{ x }" });
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AtlaSentError).code).toBe("server_error");
    }
  });

  it("throws AtlaSentError(bad_request) on 4xx (not 404)", async () => {
    const transport = makeTransport(() =>
      jsonResponse({ error: "bad" }, { status: 400 }),
    );
    try {
      await graphql(transport, { query: "{ x }" });
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AtlaSentError).code).toBe("bad_request");
    }
  });

  it("throws AtlaSentError(bad_response) on malformed JSON", async () => {
    const transport = makeTransport(
      () => new Response("not-json", { status: 200 }),
    );
    try {
      await graphql(transport, { query: "{ x }" });
      expect.fail("expected throw");
    } catch (e) {
      expect((e as AtlaSentError).code).toBe("bad_response");
    }
  });

  it("rejects empty / whitespace-only query", async () => {
    const transport = makeTransport(() => jsonResponse({}));
    await expect(graphql(transport, { query: "" })).rejects.toThrow(/non-empty/);
    await expect(graphql(transport, { query: "   " })).rejects.toThrow(/non-empty/);
  });

  it("rejects oversize body", async () => {
    const transport = makeTransport(() => jsonResponse({}));
    const huge = "{ x } # " + "a".repeat(1_100_000);
    await expect(graphql(transport, { query: huge })).rejects.toThrow(
      /exceeds maximum/,
    );
  });

  it("uses global fetch when transport.fetch is omitted", async () => {
    const globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: { activeBundle: null } }));
    try {
      const result = await graphql(
        { baseUrl: BASE, apiKey: API_KEY },
        { query: "{ activeBundle { id } }" },
      );
      expect(globalFetch).toHaveBeenCalledOnce();
      expect(result.data).toEqual({ activeBundle: null });
    } finally {
      globalFetch.mockRestore();
    }
  });
});
