import { describe, expect, it, vi, type MockedFunction } from "vitest";

import { AtlaSentClient, AtlaSentError } from "../src/index.js";
import type { EvaluateStreamEvent } from "../src/index.js";

type FetchMock = MockedFunction<typeof fetch>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sseBody(...events: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = events.map((e) =>
    encoder.encode(`data: ${JSON.stringify(e)}\n\n`),
  );
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function sseResponse(
  ...events: object[]
): Response {
  return new Response(sseBody(...events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ message: "error" }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(impl: () => Response | Promise<Response>): FetchMock {
  return vi.fn(async () => impl()) as unknown as FetchMock;
}

function makeClient(fetchImpl: FetchMock) {
  return new AtlaSentClient({ apiKey: "ask_live_test", fetch: fetchImpl });
}

async function collectStream(
  gen: AsyncGenerator<EvaluateStreamEvent>,
): Promise<EvaluateStreamEvent[]> {
  const events: EvaluateStreamEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

// ---------------------------------------------------------------------------
// Wire fixtures
// ---------------------------------------------------------------------------

const REASONING_WIRE = { type: "reasoning", content: "Checking policies…" };
const POLICY_CHECK_WIRE = {
  type: "policy_check",
  policy_id: "pol_abc",
  outcome: "pass",
  reason: "Policy allows action",
};
const DECISION_PERMIT_WIRE = {
  type: "decision",
  permitted: true,
  decision_id: "dec_stream_1",
  reason: "All policies passed",
  audit_hash: "h_stream",
  timestamp: "2026-04-17T12:00:00Z",
};
const DECISION_DENY_WIRE = {
  type: "decision",
  permitted: false,
  decision_id: "dec_stream_2",
  reason: "Policy blocked",
  audit_hash: "",
  timestamp: "2026-04-17T12:01:00Z",
};

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe("AtlaSentClient.evaluateStream — happy path", () => {
  it("yields all events in order", async () => {
    const client = makeClient(
      mockFetch(() =>
        sseResponse(REASONING_WIRE, POLICY_CHECK_WIRE, DECISION_PERMIT_WIRE),
      ),
    );

    const events = await collectStream(
      client.evaluateStream({ agent: "agent-1", action: "read_phi" }),
    );

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("reasoning");
    expect(events[0].content).toBe("Checking policies…");
    expect(events[1].type).toBe("policy_check");
    expect(events[1].policyId).toBe("pol_abc");
    expect(events[1].outcome).toBe("pass");
    expect(events[2].type).toBe("decision");
    expect(events[2].permitted).toBe(true);
    expect(events[2].permitId).toBe("dec_stream_1");
    expect(events[2].auditHash).toBe("h_stream");
  });

  it("maps snake_case wire fields to camelCase", async () => {
    const client = makeClient(
      mockFetch(() => sseResponse(DECISION_PERMIT_WIRE)),
    );

    const [ev] = await collectStream(
      client.evaluateStream({ agent: "a", action: "b" }),
    );

    expect(ev.permitId).toBe("dec_stream_1");
    expect(ev.auditHash).toBe("h_stream");
  });

  it("yields DENY decision without throwing", async () => {
    const client = makeClient(
      mockFetch(() => sseResponse(DECISION_DENY_WIRE)),
    );

    const events = await collectStream(
      client.evaluateStream({ agent: "a", action: "b" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].permitted).toBe(false);
  });

  it("stops at [DONE] sentinel", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(REASONING_WIRE)}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(DECISION_PERMIT_WIRE)}\n\n`),
        );
        controller.close();
      },
    });
    const client = makeClient(
      mockFetch(
        () =>
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    );

    const events = await collectStream(
      client.evaluateStream({ agent: "a", action: "b" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("reasoning");
  });

  it("skips non-data lines (comments, blanks)", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(DECISION_PERMIT_WIRE)}\n\n`),
        );
        controller.close();
      },
    });
    const client = makeClient(
      mockFetch(
        () =>
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    );

    const events = await collectStream(
      client.evaluateStream({ agent: "a", action: "b" }),
    );
    expect(events).toHaveLength(1);
  });

  it("skips malformed JSON lines without throwing", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {not valid json}\n\n"));
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(DECISION_PERMIT_WIRE)}\n\n`),
        );
        controller.close();
      },
    });
    const client = makeClient(
      mockFetch(
        () =>
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    );

    const events = await collectStream(
      client.evaluateStream({ agent: "a", action: "b" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("decision");
  });

  it("sends correct request headers", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return sseResponse(DECISION_PERMIT_WIRE);
    }) as unknown as FetchMock;

    const client = makeClient(fetchImpl);
    await collectStream(client.evaluateStream({ agent: "a", action: "b" }));

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("text/event-stream");
    expect(headers["Authorization"]).toBe("Bearer ask_live_test");
  });
});

// ---------------------------------------------------------------------------
// Error tests
// ---------------------------------------------------------------------------

describe("AtlaSentClient.evaluateStream — errors", () => {
  it("throws AtlaSentError on 401", async () => {
    const client = makeClient(mockFetch(() => errorResponse(401)));

    await expect(
      collectStream(client.evaluateStream({ agent: "a", action: "b" })),
    ).rejects.toThrow(AtlaSentError);

    await expect(
      collectStream(client.evaluateStream({ agent: "a", action: "b" })),
    ).rejects.toMatchObject({ code: "invalid_api_key" });
  });

  it("throws AtlaSentError on 403", async () => {
    const client = makeClient(mockFetch(() => errorResponse(403)));

    await expect(
      collectStream(client.evaluateStream({ agent: "a", action: "b" })),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("throws AtlaSentError on 429", async () => {
    const client = makeClient(mockFetch(() => errorResponse(429)));

    await expect(
      collectStream(client.evaluateStream({ agent: "a", action: "b" })),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("throws AtlaSentError on 500", async () => {
    const client = makeClient(mockFetch(() => errorResponse(500)));

    await expect(
      collectStream(client.evaluateStream({ agent: "a", action: "b" })),
    ).rejects.toMatchObject({ code: "server_error" });
  });

  it("throws AtlaSentError on network failure", async () => {
    const client = makeClient(
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as FetchMock,
    );

    await expect(
      collectStream(client.evaluateStream({ agent: "a", action: "b" })),
    ).rejects.toThrow(AtlaSentError);
  });
});
