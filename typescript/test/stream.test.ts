/**
 * Tests for AtlaSentClient.protectStream (SSE streaming evaluate).
 */

import { describe, expect, it, vi } from "vitest";
import { AtlaSentClient } from "../src/index.js";
import type { StreamEvent } from "../src/index.js";

const BASE_URL = "https://api.atlasent.io";
const API_KEY = "ask_test_stream";

function makeSseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i++]!));
    },
  });
}

function sseResponse(chunks: string[], status = 200): Response {
  return new Response(makeSseBody(chunks), {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function makeClient(fetch: typeof globalThis.fetch): AtlaSentClient {
  return new AtlaSentClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch });
}

// ── helpers ────────────────────────────────────────────────────────────────────

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe("protectStream", () => {
  it("yields a final decision event and stops at done", async () => {
    const chunks = [
      "event: decision\ndata: " +
        JSON.stringify({
          permitted: true,
          decision_id: "dec_stream_1",
          reason: "ok",
          audit_hash: "h1",
          timestamp: "2026-04-30T00:00:00Z",
          is_final: true,
        }) +
        "\n\n",
      "event: done\ndata: {}\n\n",
    ];

    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);
    const events = await collect(client.protectStream({ agent: "bot", action: "read" }));

    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev?.type).toBe("decision");
    if (ev?.type === "decision") {
      expect(ev.decision).toBe("ALLOW");
      expect(ev.permitId).toBe("dec_stream_1");
      expect(ev.isFinal).toBe(true);
    }
  });

  it("yields interim decisions followed by a final one", async () => {
    const interim = {
      permitted: true,
      decision_id: "dec_interim",
      reason: "partial",
      audit_hash: "h2",
      timestamp: "2026-04-30T00:00:01Z",
      is_final: false,
    };
    const final = {
      permitted: true,
      decision_id: "dec_final",
      reason: "approved",
      audit_hash: "h3",
      timestamp: "2026-04-30T00:00:02Z",
      is_final: true,
    };
    const chunks = [
      `event: decision\ndata: ${JSON.stringify(interim)}\n\n`,
      `event: decision\ndata: ${JSON.stringify(final)}\n\nevent: done\ndata: {}\n\n`,
    ];

    const events = await collect(
      makeClient(vi.fn(() => Promise.resolve(sseResponse(chunks)))).protectStream({
        agent: "bot",
        action: "write",
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("decision");
    if (events[0]?.type === "decision") expect(events[0].isFinal).toBe(false);
    expect(events[1]?.type).toBe("decision");
    if (events[1]?.type === "decision") expect(events[1].isFinal).toBe(true);
  });

  it("yields progress events before the final decision", async () => {
    const progress = { stage: "policy_loading" };
    const final = {
      permitted: true,
      decision_id: "dec_prog_1",
      reason: "ok",
      audit_hash: "h4",
      timestamp: "2026-04-30T00:00:03Z",
      is_final: true,
    };
    const chunks = [
      `event: progress\ndata: ${JSON.stringify(progress)}\n\n`,
      `event: decision\ndata: ${JSON.stringify(final)}\n\nevent: done\ndata: {}\n\n`,
    ];

    const events = await collect(
      makeClient(vi.fn(() => Promise.resolve(sseResponse(chunks)))).protectStream({
        agent: "bot",
        action: "read",
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("progress");
    if (events[0]?.type === "progress") expect(events[0].stage).toBe("policy_loading");
    expect(events[1]?.type).toBe("decision");
  });

  it("yields a deny decision (isFinal true, decision DENY)", async () => {
    const deny = {
      permitted: false,
      decision_id: "dec_deny_1",
      reason: "policy denied",
      audit_hash: "h5",
      timestamp: "2026-04-30T00:00:04Z",
      is_final: true,
    };
    const chunks = [
      `event: decision\ndata: ${JSON.stringify(deny)}\n\nevent: done\ndata: {}\n\n`,
    ];

    const events = await collect(
      makeClient(vi.fn(() => Promise.resolve(sseResponse(chunks)))).protectStream({
        agent: "bot",
        action: "delete",
      }),
    );

    expect(events).toHaveLength(1);
    if (events[0]?.type === "decision") {
      expect(events[0].decision).toBe("DENY");
      expect(events[0].isFinal).toBe(true);
    }
  });

  it("throws AtlaSentError on event:error", async () => {
    const errEvent = { code: "server_error", message: "upstream timeout", request_id: "req_abc" };
    const chunks = [`event: error\ndata: ${JSON.stringify(errEvent)}\n\n`];

    await expect(
      collect(
        makeClient(vi.fn(() => Promise.resolve(sseResponse(chunks)))).protectStream({
          agent: "bot",
          action: "read",
        }),
      ),
    ).rejects.toThrow("upstream timeout");
  });

  it("throws AtlaSentError on HTTP 403", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      collect(makeClient(fetch).protectStream({ agent: "bot", action: "read" })),
    ).rejects.toThrow();
  });

  it("sends the correct POST body and Accept header", async () => {
    let capturedInit: RequestInit | undefined;
    const chunks = [
      `event: decision\ndata: ${JSON.stringify({ permitted: true, decision_id: "d1", reason: "", audit_hash: "", timestamp: "", is_final: true })}\n\n`,
      "event: done\ndata: {}\n\n",
    ];
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(sseResponse(chunks));
    });

    await collect(
      makeClient(fetch).protectStream({ agent: "svc:app", action: "my_action", context: { env: "prod" } }),
    );

    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)?.["Accept"]).toBe(
      "text/event-stream",
    );
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.agent).toBe("svc:app");
    expect(body.action).toBe("my_action");
    expect(body.context).toEqual({ env: "prod" });
    expect(body.api_key).toBe(API_KEY);
  });

  it("handles chunked SSE split across multiple reads", async () => {
    const full =
      "event: decision\ndata: " +
      JSON.stringify({
        permitted: true,
        decision_id: "dec_chunked",
        reason: "ok",
        audit_hash: "hc",
        timestamp: "2026-04-30T00:00:00Z",
        is_final: true,
      }) +
      "\n\nevent: done\ndata: {}\n\n";

    // Split the full SSE block into 3 arbitrary chunks
    const mid = Math.floor(full.length / 3);
    const chunks = [full.slice(0, mid), full.slice(mid, mid * 2), full.slice(mid * 2)];

    const events = await collect(
      makeClient(vi.fn(() => Promise.resolve(sseResponse(chunks)))).protectStream({
        agent: "bot",
        action: "read",
      }),
    );

    expect(events).toHaveLength(1);
    if (events[0]?.type === "decision") expect(events[0].permitId).toBe("dec_chunked");
  });

  it("silently skips unknown event types (forward compat)", async () => {
    const final = {
      permitted: true,
      decision_id: "dec_unk",
      reason: "",
      audit_hash: "",
      timestamp: "",
      is_final: true,
    };
    const chunks = [
      `event: unknown_future_event\ndata: ${JSON.stringify({ foo: "bar" })}\n\n`,
      `event: decision\ndata: ${JSON.stringify(final)}\n\nevent: done\ndata: {}\n\n`,
    ];

    const events = await collect(
      makeClient(vi.fn(() => Promise.resolve(sseResponse(chunks)))).protectStream({
        agent: "bot",
        action: "read",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("decision");
  });
});
