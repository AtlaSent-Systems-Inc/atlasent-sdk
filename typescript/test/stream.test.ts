/**
 * Tests for AtlaSentClient.protectStream (SSE streaming evaluate).
 *
 * `protectStream()` talks to the real V2-D4 `/v1-evaluate-stream` contract
 * (`atlasent-api` `supabase/functions/v1-evaluate-stream/handler.ts`, body-
 * compatible with `/v1/evaluate/batch` — see `src/v2.ts`'s `authorizeStream`
 * for the canonical reference implementation of this same contract):
 *
 *   request:  {items: [{action_type, actor_id, context, ...}]}
 *   response: SSE frames — `event: decision` (one per item, the same
 *             canonical {decision, permit_token, reason, audit_hash,
 *             timestamp} shape as a /v1-evaluate response, prefixed with
 *             `index`), `event: error` (per-item RPC failure, `{index,
 *             error_code, message}`), terminating in `event: complete`
 *             (`{batch_id, count, partial}`).
 *
 * `TestProtectStreamRequestShape`-equivalent tests below assert the actual
 * *outgoing* request body/headers, not just that some request was sent and
 * some mocked response was handled — this is exactly the gap that let a
 * flat {action, agent, context, api_key} body ship undetected (see
 * atlasent-sdk#500/#501): the real handler's `!Array.isArray(body.items)`
 * check rejects that shape outright, but a test that only exercises
 * response parsing against a self-consistent (wrong) fixture would never
 * catch it.
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

async function collect(
  iter: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

// ── SSE frame builders — shaped like the REAL /v1-evaluate-stream wire ─────
//
// A `decision` frame is `{index, ...<v1-evaluate response>}`: the same
// canonical {decision, permit_token, reason, audit_hash, timestamp} shape
// evaluate() parses, never a stream-specific {permitted, decision_id,
// is_final} shape. There is no `is_final` field on the real wire at all —
// the stream's true terminal signal is the `complete` frame below.

function decisionWire(opts: {
  index?: number;
  decision?: string;
  permit_token?: string;
  reason?: string;
  audit_hash?: string;
  timestamp?: string;
} = {}): string {
  const data = JSON.stringify({
    index: opts.index ?? 0,
    decision: opts.decision ?? "allow",
    permit_token: opts.permit_token ?? "pt.v4.stream-token",
    reason: opts.reason ?? "ok",
    audit_hash: opts.audit_hash ?? "h1",
    timestamp: opts.timestamp ?? "2026-04-30T00:00:00Z",
  });
  return `event: decision\ndata: ${data}\n\n`;
}

function errorWire(opts: { index?: number; error_code?: string; message?: string } = {}): string {
  const data = JSON.stringify({
    index: opts.index ?? 0,
    error_code: opts.error_code ?? "item_failed",
    message: opts.message ?? "boom",
  });
  return `event: error\ndata: ${data}\n\n`;
}

function completeWire(opts: { batch_id?: string; count?: number; partial?: boolean } = {}): string {
  const data = JSON.stringify({
    batch_id: opts.batch_id ?? "b1",
    count: opts.count ?? 1,
    partial: opts.partial ?? false,
  });
  return `event: complete\ndata: ${data}\n\n`;
}

// ── Legacy/generic shapes — kept to prove the SDK still tolerates them ─────

function decisionLegacy(opts: {
  permitted?: boolean;
  decision_id?: string;
  reason?: string;
  audit_hash?: string;
  timestamp?: string;
  is_final?: boolean;
} = {}): string {
  const data = JSON.stringify({
    permitted: opts.permitted ?? true,
    decision_id: opts.decision_id ?? "dec_s1",
    reason: opts.reason ?? "ok",
    audit_hash: opts.audit_hash ?? "h1",
    timestamp: opts.timestamp ?? "2026-04-30T00:00:00Z",
    is_final: opts.is_final ?? true,
  });
  return `event: decision\ndata: ${data}\n\n`;
}

function doneWire(): string {
  return "event: done\ndata: {}\n\n";
}

// ── request-shape tests (the actual regression coverage for #500/#501) ─────

describe("protectStream request shape", () => {
  it("sends the real V2-D4 items-array body, not a flat {action,agent,api_key} body", async () => {
    let capturedInit: RequestInit | undefined;
    const chunks = [decisionWire(), completeWire()];
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(sseResponse(chunks));
    });

    await collect(
      makeClient(fetch).protectStream({
        agent: "svc:app",
        action: "my_action",
        context: { env: "prod" },
      }),
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)?.["Accept"]).toBe(
      "text/event-stream",
    );

    const sentBody = JSON.parse(capturedInit?.body as string);

    // The bug: this used to be a flat {action, agent, context, api_key}
    // body. The real handler requires `items` to be an array at all —
    // assert the exact contract, not merely "a body was sent".
    expect(Object.keys(sentBody)).toEqual(["items"]);
    expect(Array.isArray(sentBody.items)).toBe(true);
    expect(sentBody.items).toHaveLength(1);
    expect(sentBody.items[0]).toEqual({
      action_type: "my_action",
      actor_id: "svc:app",
      context: { env: "prod" },
    });

    // Field names the old buggy payload used instead — must be absent.
    expect(sentBody).not.toHaveProperty("action");
    expect(sentBody).not.toHaveProperty("agent");
    expect(sentBody).not.toHaveProperty("api_key");
    expect(sentBody).not.toHaveProperty("context"); // context belongs inside the item
  });

  it("defaults context to an empty object inside the item", async () => {
    let capturedInit: RequestInit | undefined;
    const chunks = [decisionWire(), completeWire()];
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(sseResponse(chunks));
    });

    await collect(makeClient(fetch).protectStream({ agent: "bot", action: "read" }));

    const sentBody = JSON.parse(capturedInit?.body as string);
    expect(sentBody.items[0].context).toEqual({});
  });

  it("carries auth via the Authorization header, never a body api_key field", async () => {
    let capturedInit: RequestInit | undefined;
    const chunks = [decisionWire(), completeWire()];
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(sseResponse(chunks));
    });

    await collect(makeClient(fetch).protectStream({ agent: "bot", action: "read" }));

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    const sentBody = JSON.parse(capturedInit?.body as string);
    expect(sentBody).not.toHaveProperty("api_key");
  });

  it("accepts canonical {action_type, actor_id} input and sends the same wire shape", async () => {
    let capturedInit: RequestInit | undefined;
    const chunks = [decisionWire(), completeWire()];
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(sseResponse(chunks));
    });

    await collect(
      makeClient(fetch).protectStream({
        action_type: "production.deploy",
        actor_id: "deploy-bot",
        context: { commit: "abc123" },
      }),
    );

    const sentBody = JSON.parse(capturedInit?.body as string);
    expect(sentBody.items[0]).toEqual({
      action_type: "production.deploy",
      actor_id: "deploy-bot",
      context: { commit: "abc123" },
    });
  });
});

// ── response-parsing tests, against the REAL wire response shape ───────────

describe("protectStream (real V2-D4 wire shape)", () => {
  it("yields a decision and completes on the real `complete` frame", async () => {
    const chunks = [decisionWire({ permit_token: "pt.v4.final" }), completeWire()];

    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);
    const events = await collect(client.protectStream({ agent: "bot", action: "read" }));

    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev?.type).toBe("decision");
    if (ev?.type === "decision") {
      expect(ev.decision).toBe("allow");
      // permit_id resolves from the canonical `permit_token` field.
      expect(ev.permitId).toBe("pt.v4.final");
      // The real wire never sends `is_final` at all — since protectStream()
      // always submits a single-item `items` array, this decision IS the
      // final (and only) one for the call and must be marked final so the
      // documented `if (event.isFinal) verifyPermit(...)` pattern fires.
      expect(ev.isFinal).toBe(true);
    }
  });

  it("fires the documented `if (event.isFinal) verifyPermit(...)` pattern exactly once for a real single-item response", async () => {
    // Mirrors protectStream()'s own doc example verbatim, against a real
    // V2-D4 response (decision frame with no `is_final`, then `complete`).
    const chunks = [decisionWire({ permit_token: "pt.v4.verify-me" }), completeWire()];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    const verifyPermit = vi.fn();
    for await (const event of client.protectStream({ agent: "bot", action: "read" })) {
      if (event.type === "decision" && event.isFinal) {
        verifyPermit(event.permitId);
      }
    }

    expect(verifyPermit).toHaveBeenCalledTimes(1);
    expect(verifyPermit).toHaveBeenCalledWith("pt.v4.verify-me");
  });

  it("yields a deny decision", async () => {
    const chunks = [decisionWire({ decision: "deny", permit_token: "" }), completeWire()];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    const events = await collect(client.protectStream({ agent: "bot", action: "read" }));

    expect(events).toHaveLength(1);
    if (events[0]?.type === "decision") expect(events[0].decision).toBe("deny");
  });

  it("yields progress then a decision, before the real complete frame", async () => {
    const chunks = [
      `event: progress\ndata: ${JSON.stringify({ stage: "context_enrichment" })}\n\n`,
      decisionWire(),
      completeWire(),
    ];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    const events = await collect(client.protectStream({ agent: "bot", action: "read" }));

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("progress");
    if (events[0]?.type === "progress") expect(events[0].stage).toBe("context_enrichment");
    expect(events[1]?.type).toBe("decision");
  });

  it("prefers permit_token over decision_id when both are present", async () => {
    const data = JSON.stringify({
      index: 0,
      decision: "allow",
      permit_token: "pt.v4.canonical",
      decision_id: "dec_legacy_should_be_ignored",
      reason: "ok",
      audit_hash: "h1",
      timestamp: "2026-04-30T00:00:00Z",
    });
    const chunks = [`event: decision\ndata: ${data}\n\n`, completeWire()];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    const events = await collect(client.protectStream({ agent: "bot", action: "read" }));

    expect(events).toHaveLength(1);
    if (events[0]?.type === "decision") {
      expect(events[0].permitId).toBe("pt.v4.canonical");
    }
  });

  it("raises on an error event using the real error_code field", async () => {
    const chunks = [errorWire({ error_code: "item_failed", message: "upstream timeout" })];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    let caught: unknown;
    try {
      await collect(client.protectStream({ agent: "bot", action: "read" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("upstream timeout");
    expect((caught as { code?: string }).code).toBe("item_failed");
  });

  it("stops at complete before further events", async () => {
    // A decision frame arriving after `complete` is ignored — `complete` is
    // the real terminal frame, same as `done` was for the legacy shape.
    const chunks = [completeWire(), decisionWire()];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    const events = await collect(client.protectStream({ agent: "bot", action: "read" }));

    expect(events).toEqual([]);
  });

  it("silently skips unknown event types (forward compat)", async () => {
    const chunks = [
      `event: unknown_future_event\ndata: ${JSON.stringify({ foo: "bar" })}\n\n`,
      decisionWire(),
      completeWire(),
    ];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    const events = await collect(client.protectStream({ agent: "bot", action: "read" }));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("decision");
  });

  it("handles chunked SSE split across multiple reads", async () => {
    const full = decisionWire({ permit_token: "pt.v4.chunked" }) + completeWire();
    const mid = Math.floor(full.length / 3);
    const chunks = [full.slice(0, mid), full.slice(mid, mid * 2), full.slice(mid * 2)];

    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    const events = await collect(client.protectStream({ agent: "bot", action: "read" }));

    expect(events).toHaveLength(1);
    if (events[0]?.type === "decision") expect(events[0].permitId).toBe("pt.v4.chunked");
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

  it("throws on a decision frame with neither `decision` nor legacy `permitted`", async () => {
    const chunks = [
      `event: decision\ndata: ${JSON.stringify({ index: 0, reason: "no decision field at all" })}\n\n`,
    ];
    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);

    await expect(
      collect(client.protectStream({ agent: "bot", action: "read" })),
    ).rejects.toThrow(/Malformed decision event/);
  });
});

// ── legacy/generic-shape backward compatibility ─────────────────────────────
//
// The parser also tolerates the older {permitted, decision_id, is_final}
// decision shape, `code` (instead of `error_code`) error frames, and the
// generic `event: done` terminal marker, in case any caller's mocked
// transport or an older server build still emits them.

describe("protectStream (legacy/generic shape compatibility)", () => {
  it("yields a final decision event and stops at done", async () => {
    const chunks = [decisionLegacy({ decision_id: "dec_stream_1" }), doneWire()];

    const fetch = vi.fn(() => Promise.resolve(sseResponse(chunks)));
    const client = makeClient(fetch);
    const events = await collect(client.protectStream({ agent: "bot", action: "read" }));

    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev?.type).toBe("decision");
    if (ev?.type === "decision") {
      expect(ev.decision).toBe("allow");
      expect(ev.permitId).toBe("dec_stream_1");
      expect(ev.isFinal).toBe(true);
    }
  });

  it("yields interim decisions followed by a final one", async () => {
    const interim = decisionLegacy({
      decision_id: "dec_interim",
      reason: "partial",
      audit_hash: "h2",
      timestamp: "2026-04-30T00:00:01Z",
      is_final: false,
    });
    const final = decisionLegacy({
      decision_id: "dec_final",
      reason: "approved",
      audit_hash: "h3",
      timestamp: "2026-04-30T00:00:02Z",
      is_final: true,
    });
    const chunks = [interim, final + doneWire()];

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

  it("yields a deny decision (isFinal true, decision DENY)", async () => {
    const deny = decisionLegacy({
      permitted: false,
      decision_id: "dec_deny_1",
      reason: "policy denied",
      audit_hash: "h5",
      timestamp: "2026-04-30T00:00:04Z",
      is_final: true,
    });
    const chunks = [deny + doneWire()];

    const events = await collect(
      makeClient(vi.fn(() => Promise.resolve(sseResponse(chunks)))).protectStream({
        agent: "bot",
        action: "delete",
      }),
    );

    expect(events).toHaveLength(1);
    if (events[0]?.type === "decision") {
      expect(events[0].decision).toBe("deny");
      expect(events[0].isFinal).toBe(true);
    }
  });

  it("throws AtlaSentError on event:error using the legacy code field", async () => {
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
});
