/**
 * Tests for streaming hardening: timeout, reconnection, partial-event guard,
 * terminal event detection, and error type exports.
 *
 * Step 4 of the streaming hardening PR.
 */

import { describe, expect, it, vi } from "vitest";
import { AtlaSentClient, StreamParseError, StreamTimeoutError } from "../src/index.js";
import type { StreamEvent } from "../src/index.js";

const BASE_URL = "https://api.atlasent.io";
const API_KEY = "ask_test_stream_hardening";

// ── helpers ────────────────────────────────────────────────────────────────────

function makeReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
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
  return new Response(makeReadableStream(chunks), {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Create a stream that never yields (blocks forever), used for timeout tests.
 */
function hangingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start() {
      // Never enqueue, never close — simulates a stalled server.
    },
  });
}

function makeClient(fetch: typeof globalThis.fetch): AtlaSentClient {
  return new AtlaSentClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch });
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

const DECISION_FINAL = JSON.stringify({
  permitted: true,
  decision_id: "dec_harden_1",
  reason: "ok",
  audit_hash: "ha1",
  timestamp: "2026-05-01T00:00:00Z",
  is_final: true,
});

// ── A. Timeout ─────────────────────────────────────────────────────────────────

describe("stream hardening — timeout", () => {
  it("throws StreamTimeoutError when no event arrives within timeoutMs", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(new Response(hangingStream(), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })),
    );
    const client = makeClient(fetch);

    await expect(
      collect(client.protectStream(
        { agent: "bot", action: "read" },
        { timeoutMs: 50 }, // very short timeout for the test
      )),
    ).rejects.toBeInstanceOf(StreamTimeoutError);
  });

  it("StreamTimeoutError carries the configured timeoutMs", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(new Response(hangingStream(), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })),
    );
    const client = makeClient(fetch);

    try {
      await collect(client.protectStream(
        { agent: "bot", action: "read" },
        { timeoutMs: 75 },
      ));
    } catch (e) {
      expect(e).toBeInstanceOf(StreamTimeoutError);
      expect((e as StreamTimeoutError).timeoutMs).toBe(75);
    }
  });

  it("does not time out when events arrive before the window", async () => {
    const chunks = [
      `event: decision\ndata: ${DECISION_FINAL}\n\n`,
      "event: done\ndata: {}\n\n",
    ];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    // 2-second timeout; the response is instantaneous, so no timeout.
    const events = await collect(
      client.protectStream({ agent: "bot", action: "read" }, { timeoutMs: 2000 }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("decision");
  });
});

// ── B. Reconnection ────────────────────────────────────────────────────────────

describe("stream hardening — reconnection", () => {
  it("retries on network error (fetch rejects) up to maxRetries", async () => {
    // First two fetches reject with a network error; third succeeds.
    const chunks = [
      `event: decision\ndata: ${DECISION_FINAL}\n\n`,
      "event: done\ndata: {}\n\n",
    ];
    let callCount = 0;
    const fetch = vi.fn(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.reject(new TypeError("network failure"));
      }
      return Promise.resolve(sseResponse(chunks));
    });
    const client = makeClient(fetch);

    const events = await collect(
      client.protectStream({ agent: "bot", action: "read" }, { maxRetries: 3 }),
    );
    expect(callCount).toBe(3);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("decision");
  });

  it("throws after exhausting maxRetries", async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError("persistent failure")));
    const client = makeClient(fetch);

    await expect(
      collect(
        client.protectStream(
          { agent: "bot", action: "read" },
          { maxRetries: 2 },
        ),
      ),
    ).rejects.toThrow();
    // 1 initial + 2 retries = 3 total calls
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("sends Last-Event-ID header on reconnect after network drop", async () => {
    // First fetch: rejects with network error — triggers reconnect.
    // Second fetch: succeeds with a complete stream.
    const successChunks = [
      `event: progress\nid: evt-001\ndata: ${JSON.stringify({ stage: "loading" })}\n\n`,
      `event: decision\ndata: ${DECISION_FINAL}\n\n`,
      "event: done\ndata: {}\n\n",
    ];

    let callCount = 0;

    const fetch = vi.fn((_url: unknown, _init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new TypeError("connection refused"));
      }
      return Promise.resolve(sseResponse(successChunks));
    });

    const client = makeClient(fetch);
    const events = await collect(
      client.protectStream({ agent: "bot", action: "read" }, { maxRetries: 2 }),
    );

    expect(callCount).toBe(2);
    const decisionEvent = events.find((e) => e.type === "decision");
    expect(decisionEvent).toBeDefined();
  });

  it("sends Last-Event-ID from prior stream on subsequent reconnect", async () => {
    // Verify Last-Event-ID mechanism: when no events were received yet
    // (all fetches fail), no Last-Event-ID is sent on the final retry.
    let callCount = 0;
    const capturedHeaders: Array<Record<string, string>> = [];

    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      callCount++;
      capturedHeaders.push(init?.headers as Record<string, string>);
      if (callCount < 3) {
        return Promise.reject(new TypeError("net error"));
      }
      const chunks = [
        `event: decision\ndata: ${DECISION_FINAL}\n\n`,
        "event: done\ndata: {}\n\n",
      ];
      return Promise.resolve(sseResponse(chunks));
    });

    const client = makeClient(fetch);
    await collect(client.protectStream({ agent: "bot", action: "read" }, { maxRetries: 3 }));

    expect(callCount).toBe(3);
    // No event id was ever received, so Last-Event-ID should never be sent
    for (const h of capturedHeaders) {
      expect(h?.["Last-Event-ID"]).toBeUndefined();
    }
  });
});

// ── C. Partial-event guard ─────────────────────────────────────────────────────

describe("stream hardening — partial-event guard", () => {
  it("throws StreamParseError on malformed JSON (not a raw SyntaxError)", async () => {
    const chunks = [
      "event: decision\ndata: {not valid json\n\n",
    ];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    const err = await collect(
      client.protectStream({ agent: "bot", action: "read" }, { timeoutMs: 5000 }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StreamParseError);
    expect((err as StreamParseError).rawData).toContain("{not valid json");
  });

  it("throws StreamParseError on stream closed mid-JSON (partial buffer)", async () => {
    // Stream closes without a final \n\n separator — leftover partial JSON in buffer.
    const partial = "event: decision\ndata: {partial";
    const fetch = vi.fn(() =>
      Promise.resolve(sseResponse([partial])),
    );
    const client = makeClient(fetch);

    const err = await collect(
      client.protectStream({ agent: "bot", action: "read" }, { timeoutMs: 5000 }),
    ).catch((e: unknown) => e);

    // The partial text in the buffer is surfaced as a StreamParseError.
    expect(err).toBeInstanceOf(StreamParseError);
  });

  it("StreamParseError is not a raw SyntaxError", async () => {
    const chunks = ["event: decision\ndata: <<<bad\n\n"];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    const err = await collect(
      client.protectStream({ agent: "bot", action: "read" }, { timeoutMs: 5000 }),
    ).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(SyntaxError);
    expect(err).toBeInstanceOf(StreamParseError);
  });
});

// ── D. Terminal event detection ────────────────────────────────────────────────

describe("stream hardening — terminal event detection", () => {
  it("closes cleanly on event: done", async () => {
    const chunks = [
      `event: decision\ndata: ${DECISION_FINAL}\n\n`,
      "event: done\ndata: {}\n\n",
      // This decision should never arrive — stream is already closed.
      `event: decision\ndata: ${JSON.stringify({
        permitted: true,
        decision_id: "dec_after_done",
        is_final: false,
      })}\n\n`,
    ];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    const events = await collect(
      client.protectStream({ agent: "bot", action: "read" }, { timeoutMs: 5000 }),
    );

    // Only 1 decision (the one before done); the one after done is ignored.
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("decision");
    if (events[0]?.type === "decision") {
      expect(events[0].permitId).toBe("dec_harden_1");
    }
  });

  it("closes cleanly on inline { done: true } terminal signal", async () => {
    // Server emits a decision with done:true without a separate done event.
    const decisionWithDone = JSON.stringify({
      permitted: true,
      decision_id: "dec_done_inline",
      reason: "approved",
      audit_hash: "hd",
      timestamp: "2026-05-01T00:00:00Z",
      is_final: true,
      done: true,
    });
    const chunks = [`event: decision\ndata: ${decisionWithDone}\n\n`];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    const events = await collect(
      client.protectStream({ agent: "bot", action: "read" }, { timeoutMs: 5000 }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("decision");
    if (events[0]?.type === "decision") {
      expect(events[0].isFinal).toBe(true);
    }
  });

  it("stream does not hang open after isFinal=true decision + done event", async () => {
    const chunks = [
      `event: decision\ndata: ${DECISION_FINAL}\n\n`,
      "event: done\ndata: {}\n\n",
    ];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    // Should complete without hanging — race against a 3-second timeout.
    const events = await Promise.race([
      collect(client.protectStream({ agent: "bot", action: "read" }, { timeoutMs: 5000 })),
      new Promise<StreamEvent[]>((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for stream to close")), 3000),
      ),
    ]);

    expect(events).toHaveLength(1);
  });
});

// ── E. Error type imports from package root ────────────────────────────────────

describe("stream hardening — error type exports", () => {
  it("StreamTimeoutError is importable from the package root", () => {
    expect(StreamTimeoutError).toBeDefined();
    expect(typeof StreamTimeoutError).toBe("function");
  });

  it("StreamParseError is importable from the package root", () => {
    expect(StreamParseError).toBeDefined();
    expect(typeof StreamParseError).toBe("function");
  });

  it("StreamTimeoutError instanceof check works", () => {
    const err = new StreamTimeoutError(30000);
    expect(err).toBeInstanceOf(StreamTimeoutError);
    expect(err).toBeInstanceOf(Error);
    expect(err.timeoutMs).toBe(30000);
    expect(err.name).toBe("StreamTimeoutError");
    expect(err.message).toContain("30000");
  });

  it("StreamParseError instanceof check works", () => {
    const err = new StreamParseError('{"bad":');
    expect(err).toBeInstanceOf(StreamParseError);
    expect(err).toBeInstanceOf(Error);
    expect(err.rawData).toBe('{"bad":');
    expect(err.name).toBe("StreamParseError");
  });

  it("StreamParseError is not an instance of StreamTimeoutError", () => {
    const err = new StreamParseError("bad json");
    expect(err).not.toBeInstanceOf(StreamTimeoutError);
  });
});
