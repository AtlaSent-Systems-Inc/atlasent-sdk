import { describe, expect, it, vi } from "vitest";

import { V2Client, V2Error, type DecisionEvent } from "../src/index.js";

function streamResponse(body: string, init?: ResponseInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...init,
  });
}

function emptyResponse(status = 200): Response {
  return new Response(null, { status });
}

describe("V2Client.subscribeDecisions", () => {
  it("yields one DecisionEvent per SSE frame", async () => {
    const wire =
      'id: 1\ndata: {"id":"1","type":"permit_issued","org_id":"o","emitted_at":"2026-04-27T16:00:00Z"}\n\n' +
      'id: 2\ndata: {"id":"2","type":"verified","org_id":"o","emitted_at":"2026-04-27T16:00:01Z"}\n\n';
    const fetchSpy: typeof fetch = vi.fn(async () =>
      streamResponse(wire),
    ) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    const events: DecisionEvent[] = [];
    for await (const ev of client.subscribeDecisions()) events.push(ev);
    expect(events.map((e) => e.id)).toEqual(["1", "2"]);
    expect(events[0]?.type).toBe("permit_issued");
    expect(events[1]?.type).toBe("verified");
  });

  it("requests /v2/decisions:subscribe with the right Accept header", async () => {
    let captured: { url: string; headers: Headers | undefined } = {
      url: "",
      headers: undefined,
    };
    const fetchSpy: typeof fetch = vi.fn(async (url, init) => {
      captured = {
        url: String(url),
        headers: new Headers(init?.headers),
      };
      return streamResponse("");
    }) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "ask", fetch: fetchSpy });
    for await (const _ of client.subscribeDecisions()) {
      /* no-op */
    }

    expect(captured.url).toBe("https://api.atlasent.io/v2/decisions:subscribe");
    expect(captured.headers?.get("accept")).toBe("text/event-stream");
    expect(captured.headers?.get("authorization")).toBe("Bearer ask");
  });

  it("sends Last-Event-ID when lastEventId is provided", async () => {
    let lastEventId: string | null = null;
    const fetchSpy: typeof fetch = vi.fn(async (_url, init) => {
      const headers = new Headers(init?.headers);
      lastEventId = headers.get("last-event-id");
      return streamResponse("");
    }) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    for await (const _ of client.subscribeDecisions({ lastEventId: "abc-123" })) {
      /* no-op */
    }
    expect(lastEventId).toBe("abc-123");
  });

  it("does NOT send Last-Event-ID when none provided", async () => {
    let lastEventId: string | null | undefined = undefined;
    const fetchSpy: typeof fetch = vi.fn(async (_url, init) => {
      const headers = new Headers(init?.headers);
      lastEventId = headers.get("last-event-id");
      return streamResponse("");
    }) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    for await (const _ of client.subscribeDecisions()) {
      /* no-op */
    }
    expect(lastEventId).toBeNull();
  });

  it("forwards unknown event types as opaque strings (forward-compat)", async () => {
    const wire =
      'data: {"id":"1","type":"future_event_kind","org_id":"o","emitted_at":"2026-04-27T16:00:00Z","payload":{"new_field":42}}\n\n';
    const fetchSpy: typeof fetch = vi.fn(async () =>
      streamResponse(wire),
    ) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    const events: DecisionEvent[] = [];
    for await (const ev of client.subscribeDecisions()) events.push(ev);
    expect(events[0]?.type).toBe("future_event_kind");
    expect(events[0]?.payload).toEqual({ new_field: 42 });
  });

  it("skips frames whose data isn't valid JSON, keeps streaming", async () => {
    const wire =
      "data: {malformed\n\n" +
      'data: {"id":"2","type":"verified","org_id":"o","emitted_at":"2026-04-27T16:00:01Z"}\n\n';
    const fetchSpy: typeof fetch = vi.fn(async () =>
      streamResponse(wire),
    ) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    const events: DecisionEvent[] = [];
    for await (const ev of client.subscribeDecisions()) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("2");
  });

  it("skips comment frames (`:` keepalives)", async () => {
    const wire =
      ": keepalive\n\n" +
      'data: {"id":"7","type":"consumed","org_id":"o","emitted_at":"x"}\n\n';
    const fetchSpy: typeof fetch = vi.fn(async () =>
      streamResponse(wire),
    ) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    const events: DecisionEvent[] = [];
    for await (const ev of client.subscribeDecisions()) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("7");
  });

  it("raises V2Error on 401 before yielding", async () => {
    const fetchSpy: typeof fetch = vi.fn(async () =>
      emptyResponse(401),
    ) as unknown as typeof fetch;
    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    const iter = client.subscribeDecisions();
    await expect(iter.next()).rejects.toMatchObject({
      name: "V2Error",
      status: 401,
      code: "invalid_api_key",
    });
  });

  it("raises V2Error on 5xx before yielding", async () => {
    const fetchSpy: typeof fetch = vi.fn(async () =>
      emptyResponse(503),
    ) as unknown as typeof fetch;
    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    const iter = client.subscribeDecisions();
    await expect(iter.next()).rejects.toMatchObject({
      name: "V2Error",
      status: 503,
      code: "http_error",
    });
  });

  it("raises V2Error(network) when fetch throws non-abort", async () => {
    const fetchSpy: typeof fetch = vi.fn(async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    const iter = client.subscribeDecisions();
    await expect(iter.next()).rejects.toMatchObject({
      name: "V2Error",
      code: "network",
    });
  });

  it("ends silently when AbortSignal already fires before fetch", async () => {
    const fetchSpy: typeof fetch = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    const ac = new AbortController();
    ac.abort();
    const events: DecisionEvent[] = [];
    for await (const ev of client.subscribeDecisions({ signal: ac.signal })) {
      events.push(ev);
    }
    expect(events).toEqual([]);
  });

  it("raises bad_response when response has no body", async () => {
    const fetchSpy: typeof fetch = vi.fn(async () => {
      // Construct a Response with body=null deliberately.
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    const iter = client.subscribeDecisions();
    await expect(iter.next()).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});
