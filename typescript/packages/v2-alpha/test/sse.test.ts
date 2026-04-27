import { describe, expect, it } from "vitest";

import { parseSSE, type SSEFrame } from "../src/index.js";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function* singleChunk(s: string): AsyncIterable<Uint8Array> {
  yield bytes(s);
}

async function* manyChunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield bytes(p);
}

async function collect(iter: AsyncIterable<SSEFrame>): Promise<SSEFrame[]> {
  const out: SSEFrame[] = [];
  for await (const f of iter) out.push(f);
  return out;
}

describe("parseSSE", () => {
  it("parses a single data-only event", async () => {
    const frames = await collect(parseSSE(singleChunk("data: hello\n\n")));
    expect(frames).toEqual([{ data: "hello" }]);
  });

  it("strips the optional space after the colon", async () => {
    const frames = await collect(parseSSE(singleChunk("data:nospace\n\n")));
    expect(frames[0]?.data).toBe("nospace");
  });

  it("concatenates multiple data lines with newline", async () => {
    const frames = await collect(
      parseSSE(singleChunk("data: line1\ndata: line2\n\n")),
    );
    expect(frames[0]?.data).toBe("line1\nline2");
  });

  it("captures the id field", async () => {
    const frames = await collect(parseSSE(singleChunk("id: 42\ndata: x\n\n")));
    expect(frames[0]).toEqual({ id: "42", data: "x" });
  });

  it("captures the event field", async () => {
    const frames = await collect(
      parseSSE(singleChunk("event: ping\ndata: x\n\n")),
    );
    expect(frames[0]?.event).toBe("ping");
  });

  it("ignores comments (lines starting with `:`)", async () => {
    const frames = await collect(
      parseSSE(singleChunk(": keepalive\ndata: x\n\n")),
    );
    expect(frames).toEqual([{ data: "x" }]);
  });

  it("skips frames with no data lines", async () => {
    const frames = await collect(
      parseSSE(singleChunk("event: just-event\n\ndata: real\n\n")),
    );
    expect(frames).toEqual([{ data: "real" }]);
  });

  it("yields multiple frames separated by blank lines", async () => {
    const frames = await collect(
      parseSSE(
        singleChunk(
          "id: 1\ndata: one\n\nid: 2\ndata: two\n\nid: 3\ndata: three\n\n",
        ),
      ),
    );
    expect(frames.map((f) => f.data)).toEqual(["one", "two", "three"]);
    expect(frames.map((f) => f.id)).toEqual(["1", "2", "3"]);
  });

  it("handles bytes split mid-line across chunks", async () => {
    const frames = await collect(
      parseSSE(manyChunks("data: hel", "lo wor", "ld\n\n")),
    );
    expect(frames[0]?.data).toBe("hello world");
  });

  it("handles bytes split mid-event across chunks", async () => {
    const frames = await collect(
      parseSSE(manyChunks("id: 1\nda", "ta: x\n", "\nid: 2\ndata: y\n\n")),
    );
    expect(frames.map((f) => f.id)).toEqual(["1", "2"]);
    expect(frames.map((f) => f.data)).toEqual(["x", "y"]);
  });

  it("normalizes \\r\\n line endings", async () => {
    const frames = await collect(
      parseSSE(singleChunk("data: a\r\ndata: b\r\n\r\n")),
    );
    expect(frames[0]?.data).toBe("a\nb");
  });

  it("flushes a final frame even without trailing blank line", async () => {
    const frames = await collect(parseSSE(singleChunk("data: solo")));
    expect(frames).toEqual([{ data: "solo" }]);
  });

  it("ignores unknown fields (forward-compat)", async () => {
    const frames = await collect(
      parseSSE(singleChunk("retry: 1000\ndata: x\n\n")),
    );
    expect(frames).toEqual([{ data: "x" }]);
  });
});
