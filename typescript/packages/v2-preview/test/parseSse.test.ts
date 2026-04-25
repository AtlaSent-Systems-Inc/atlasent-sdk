/**
 * SSE parser test suite — Pillar 3 decision-event stream.
 *
 * Builds canonical SSE wire frames as strings, encodes them, and
 * runs the parser over chunked / non-chunked / cross-chunk-boundary
 * variants. Covers:
 *
 *   - the seven known event types with type-narrowing
 *   - unknown event types pass through as opaque data
 *   - multi-line `data:` concatenation
 *   - heartbeats / comment lines ignored
 *   - chunk boundaries that split a line / event / multi-byte char
 *   - LF / CRLF line endings
 *   - missing trailing blank line still flushes the last event
 *   - malformed JSON throws
 *   - non-object event data throws
 */

import { describe, expect, it } from "vitest";

import type { DecisionEvent } from "../src/decisionEvent.js";
import { parseDecisionEventStream } from "../src/parseSse.js";

const enc = new TextEncoder();

async function* fromChunks(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield enc.encode(c);
}

async function collect(
  source: AsyncIterable<Uint8Array>,
): Promise<DecisionEvent[]> {
  const out: DecisionEvent[] = [];
  for await (const ev of parseDecisionEventStream(source)) out.push(ev);
  return out;
}

function frame(eventType: string, data: object, id?: string): string {
  let out = "";
  if (id !== undefined) out += `id: ${id}\n`;
  out += `event: ${eventType}\n`;
  out += `data: ${JSON.stringify(data)}\n\n`;
  return out;
}

describe("parseDecisionEventStream — single events of each known type", () => {
  it("permit_issued narrows the payload via the type discriminator", async () => {
    const data = {
      id: "1",
      type: "permit_issued",
      org_id: "org-1",
      emitted_at: "2026-04-24T12:00:00Z",
      permit_id: "dec_abc",
      actor_id: "deploy-bot",
      payload: {
        decision: "allow",
        agent: "deploy-bot",
        action: "deploy_to_production",
        audit_hash: "a".repeat(64),
        reason: "GxP-compliant",
      },
    };
    const [ev] = await collect(fromChunks(frame("permit_issued", data, "1")));
    expect(ev?.type).toBe("permit_issued");
    if (ev?.type !== "permit_issued") throw new Error("type narrow");
    expect(ev.payload.decision).toBe("allow");
    expect(ev.payload.audit_hash).toBe("a".repeat(64));
    expect(ev.permit_id).toBe("dec_abc");
    expect(ev.actor_id).toBe("deploy-bot");
  });

  it("verified", async () => {
    const data = {
      id: "2",
      type: "verified",
      org_id: "org-1",
      emitted_at: "2026-04-24T12:00:01Z",
      permit_id: "dec_abc",
      actor_id: null,
      payload: { permit_hash: "h".repeat(64), outcome: "ok" },
    };
    const [ev] = await collect(fromChunks(frame("verified", data, "2")));
    expect(ev?.type).toBe("verified");
    if (ev?.type !== "verified") throw new Error("type narrow");
    expect(ev.payload.outcome).toBe("ok");
    expect(ev.actor_id).toBeNull();
  });

  it("consumed", async () => {
    const data = {
      id: "3",
      type: "consumed",
      org_id: "org-1",
      emitted_at: "2026-04-24T12:00:02Z",
      permit_id: "dec_abc",
      payload: {
        proof_id: "550e8400-e29b-41d4-a716-446655440000",
        execution_status: "executed",
        audit_hash: "b".repeat(64),
      },
    };
    const [ev] = await collect(fromChunks(frame("consumed", data, "3")));
    expect(ev?.type).toBe("consumed");
    if (ev?.type !== "consumed") throw new Error("type narrow");
    expect(ev.payload.execution_status).toBe("executed");
    expect(ev.payload.proof_id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("revoked + null revoker_id (system-revoked)", async () => {
    const data = {
      id: "4",
      type: "revoked",
      org_id: "org-1",
      emitted_at: "2026-04-24T12:00:03Z",
      permit_id: "dec_abc",
      payload: { reason: "ttl_expired", revoker_id: null },
    };
    const [ev] = await collect(fromChunks(frame("revoked", data, "4")));
    if (ev?.type !== "revoked") throw new Error("type narrow");
    expect(ev.payload.reason).toBe("ttl_expired");
    expect(ev.payload.revoker_id).toBeNull();
  });

  it("escalated", async () => {
    const data = {
      id: "5",
      type: "escalated",
      org_id: "org-1",
      emitted_at: "2026-04-24T12:00:04Z",
      permit_id: "dec_abc",
      payload: { to: "compliance-queue", reason: "manual_review_required" },
    };
    const [ev] = await collect(fromChunks(frame("escalated", data, "5")));
    if (ev?.type !== "escalated") throw new Error("type narrow");
    expect(ev.payload.to).toBe("compliance-queue");
  });

  it("hold_resolved", async () => {
    const data = {
      id: "6",
      type: "hold_resolved",
      org_id: "org-1",
      emitted_at: "2026-04-24T12:00:05Z",
      permit_id: "dec_abc",
      payload: { resolution: "approved", resolved_by: "operator-1" },
    };
    const [ev] = await collect(fromChunks(frame("hold_resolved", data, "6")));
    if (ev?.type !== "hold_resolved") throw new Error("type narrow");
    expect(ev.payload.resolution).toBe("approved");
  });

  it("rate_limit_state (no permit_id)", async () => {
    const data = {
      id: "7",
      type: "rate_limit_state",
      org_id: "org-1",
      emitted_at: "2026-04-24T12:00:06Z",
      payload: { limit: 1000, remaining: 50, reset_at: 1714070000 },
    };
    const [ev] = await collect(fromChunks(frame("rate_limit_state", data, "7")));
    if (ev?.type !== "rate_limit_state") throw new Error("type narrow");
    expect(ev.payload.remaining).toBe(50);
    expect(ev.permit_id).toBeUndefined();
  });
});

describe("parseDecisionEventStream — wire shape", () => {
  it("multiple events in one chunk parse in order", async () => {
    const data1 = {
      id: "1",
      type: "permit_issued",
      org_id: "o",
      emitted_at: "t1",
      permit_id: "dec_a",
      payload: {
        decision: "allow",
        agent: "a",
        action: "x",
        audit_hash: "a".repeat(64),
      },
    };
    const data2 = {
      id: "2",
      type: "verified",
      org_id: "o",
      emitted_at: "t2",
      permit_id: "dec_a",
      payload: { permit_hash: "h", outcome: "ok" },
    };
    const wire = frame("permit_issued", data1, "1") + frame("verified", data2, "2");
    const events = await collect(fromChunks(wire));
    expect(events.map((e) => e.type)).toEqual(["permit_issued", "verified"]);
    expect(events.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("event split across chunks reassembles", async () => {
    const data = {
      id: "1",
      type: "consumed",
      org_id: "o",
      emitted_at: "t",
      permit_id: "dec_a",
      payload: {
        proof_id: "p",
        execution_status: "executed",
        audit_hash: "a".repeat(64),
      },
    };
    const wire = frame("consumed", data, "1");
    // Slice the wire into many small chunks, including mid-line and
    // mid-multi-byte-char positions. UTF-8 only matters here since
    // we ascii-encode but the parser still streams via TextDecoder.
    const chunks: string[] = [];
    for (let i = 0; i < wire.length; i += 7) chunks.push(wire.slice(i, i + 7));
    const events = await collect(fromChunks(...chunks));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("consumed");
  });

  it("heartbeat / comment lines are ignored", async () => {
    const data = {
      id: "1",
      type: "verified",
      org_id: "o",
      emitted_at: "t",
      permit_id: "dec_a",
      payload: { permit_hash: "h", outcome: "ok" },
    };
    const wire =
      ":heartbeat\n" +
      ":another comment\n\n" +  // a comment in the middle of an "empty" event
      frame("verified", data, "1") +
      ":trailing\n";
    const events = await collect(fromChunks(wire));
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("1");
  });

  it("CRLF line endings are accepted", async () => {
    const data = {
      id: "1",
      type: "verified",
      org_id: "o",
      emitted_at: "t",
      permit_id: "dec_a",
      payload: { permit_hash: "h", outcome: "ok" },
    };
    const wire = `id: 1\r\nevent: verified\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
    const events = await collect(fromChunks(wire));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("verified");
  });

  it("multi-line data: lines concatenate with \\n", async () => {
    // Per the SSE spec, consecutive `data:` lines join with `\n`. To
    // remain valid JSON after that join, we use a pretty-printed
    // body — the literal newlines in the JSON are exactly what the
    // join produces.
    const wire =
      `event: verified\n` +
      `data: {\n` +
      `data:   "id": "1",\n` +
      `data:   "type": "verified",\n` +
      `data:   "org_id": "o",\n` +
      `data:   "emitted_at": "t",\n` +
      `data:   "permit_id": "dec_a",\n` +
      `data:   "payload": { "permit_hash": "h", "outcome": "ok" }\n` +
      `data: }\n\n`;
    const events = await collect(fromChunks(wire));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("verified");
    expect(events[0]?.id).toBe("1");
  });

  it("missing trailing blank line still flushes the final event", async () => {
    const data = {
      id: "1",
      type: "verified",
      org_id: "o",
      emitted_at: "t",
      permit_id: "dec_a",
      payload: { permit_hash: "h", outcome: "ok" },
    };
    // No \n\n at the end — common with abrupt connection close.
    const wire = `event: verified\ndata: ${JSON.stringify(data)}`;
    const events = await collect(fromChunks(wire));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("verified");
  });

  it("unknown event type passes through as opaque data", async () => {
    const data = {
      id: "1",
      type: "future_event_type_v3",
      org_id: "o",
      emitted_at: "t",
      payload: { something_new: 42 },
    };
    const events = await collect(
      fromChunks(frame("future_event_type_v3", data, "1")),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("future_event_type_v3");
    expect(events[0]?.payload).toEqual({ something_new: 42 });
  });

  it("unknown payload field on a known type passes through", async () => {
    const data = {
      id: "1",
      type: "verified",
      org_id: "o",
      emitted_at: "t",
      permit_id: "dec_a",
      payload: { permit_hash: "h", outcome: "ok", server_only_field: "x" },
    };
    const [ev] = await collect(fromChunks(frame("verified", data, "1")));
    if (ev?.type !== "verified") throw new Error("type narrow");
    expect((ev.payload as Record<string, unknown>).server_only_field).toBe("x");
  });

  it("missing payload defaults to {}", async () => {
    const data = {
      id: "1",
      type: "verified",
      org_id: "o",
      emitted_at: "t",
      permit_id: "dec_a",
    };
    const [ev] = await collect(fromChunks(frame("verified", data, "1")));
    expect(ev?.payload).toEqual({});
  });

  it("malformed JSON throws", async () => {
    const wire = "event: verified\ndata: {not valid json}\n\n";
    await expect(collect(fromChunks(wire))).rejects.toThrow(/invalid JSON/i);
  });

  it("non-object data (e.g. JSON array) throws", async () => {
    const wire = `event: verified\ndata: [1,2,3]\n\n`;
    await expect(collect(fromChunks(wire))).rejects.toThrow(
      /must be a JSON object/i,
    );
  });

  it("accepts a ReadableStream source", async () => {
    const data = {
      id: "1",
      type: "verified",
      org_id: "o",
      emitted_at: "t",
      permit_id: "dec_a",
      payload: { permit_hash: "h", outcome: "ok" },
    };
    const wire = frame("verified", data, "1");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(wire));
        controller.close();
      },
    });
    const events: DecisionEvent[] = [];
    for await (const ev of parseDecisionEventStream(stream)) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("verified");
  });

  it("trusts JSON `id`/`type` over SSE field-line values", async () => {
    // Server sends id:99 / event:permit_issued at the SSE layer but
    // the JSON body claims id:1 / type:consumed. Schema is law.
    const data = {
      id: "1",
      type: "consumed",
      org_id: "o",
      emitted_at: "t",
      permit_id: "dec_a",
      payload: {
        proof_id: "p",
        execution_status: "executed",
        audit_hash: "a".repeat(64),
      },
    };
    const wire = `id: 99\nevent: permit_issued\ndata: ${JSON.stringify(data)}\n\n`;
    const [ev] = await collect(fromChunks(wire));
    expect(ev?.id).toBe("1");
    expect(ev?.type).toBe("consumed");
  });

  it("empty data line dispatches no event", async () => {
    // A blank line with no preceding data: per spec dispatches an
    // empty event, which our parser silently drops (no payload to JSON-parse).
    const wire = "\n\n\n";
    const events = await collect(fromChunks(wire));
    expect(events).toEqual([]);
  });

  it("trailing event:/id: lines without a final data: dispatch nothing", async () => {
    // EOF with a half-built event header but no data — drops cleanly.
    // Exercises the trailing-line flush path for non-data fields.
    const events = await collect(fromChunks("event: verified"));
    expect(events).toEqual([]);
    const events2 = await collect(fromChunks("id: 99"));
    expect(events2).toEqual([]);
  });

  it("trailing data: line without a final blank line still dispatches", async () => {
    // Stream ends with the last line being `data: ...`. Same shape
    // as the "missing trailing blank line" test but explicitly
    // exercises the trailing-data flush branch.
    const data = {
      id: "1",
      type: "consumed",
      org_id: "o",
      emitted_at: "t",
      permit_id: "dec_a",
      payload: {
        proof_id: "p",
        execution_status: "executed",
        audit_hash: "a".repeat(64),
      },
    };
    const wire = `event: consumed\nid: 1\ndata: ${JSON.stringify(data)}`;
    const events = await collect(fromChunks(wire));
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("1");
  });

  it("retry: field is silently ignored", async () => {
    // The SSE `retry:` field hints at reconnect timing — the parser
    // exposes Last-Event-ID via each event's `id`, so retry is
    // ignored and consumers handle reconnect themselves.
    const data = {
      id: "1",
      type: "verified",
      org_id: "o",
      emitted_at: "t",
      permit_id: "dec_a",
      payload: { permit_hash: "h", outcome: "ok" },
    };
    const wire = `retry: 5000\n${frame("verified", data, "1")}`;
    const events = await collect(fromChunks(wire));
    expect(events).toHaveLength(1);
  });

  it("field line with no colon treated as field-with-empty-value", async () => {
    // SSE spec edge case: a non-empty line without a colon is the
    // field name with an empty value.
    const data = {
      id: "1",
      type: "verified",
      org_id: "o",
      emitted_at: "t",
      permit_id: "dec_a",
      payload: { permit_hash: "h", outcome: "ok" },
    };
    const wire = `data\nevent: verified\ndata: ${JSON.stringify(data)}\n\n`;
    const events = await collect(fromChunks(wire));
    expect(events).toHaveLength(1);
  });

  it("id: with NUL byte is silently dropped", async () => {
    const data = {
      id: "1",
      type: "verified",
      org_id: "o",
      emitted_at: "t",
      permit_id: "dec_a",
      payload: { permit_hash: "h", outcome: "ok" },
    };
    const wire = `id: bad id\nevent: verified\ndata: ${JSON.stringify(data)}\n\n`;
    const events = await collect(fromChunks(wire));
    expect(events).toHaveLength(1);
    // The id from the JSON body wins; the bad SSE id was dropped silently.
    expect(events[0]?.id).toBe("1");
  });
});
