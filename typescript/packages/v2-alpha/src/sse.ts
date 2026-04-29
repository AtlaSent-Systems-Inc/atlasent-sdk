/**
 * Minimal Server-Sent Events parser.
 *
 * Parses the SSE wire format described at
 * https://html.spec.whatwg.org/multipage/server-sent-events.html
 * and yields one frame per blank-line-terminated event. Only the
 * fields the v2 Pillar 3 stream uses are surfaced — `id`, `event`,
 * `data` (concatenated across multiple lines per spec) — plus
 * comments (`:`-prefixed lines, ignored).
 *
 * The parser is consumer-agnostic: it works on any
 * `AsyncIterable<Uint8Array>` (e.g. `Response.body`).
 */

export interface SSEFrame {
  /** Optional SSE `id:` field. Surfaces as `Last-Event-ID` on reconnect. */
  id?: string;
  /** Optional SSE `event:` field. Defaults to `"message"` on the wire. */
  event?: string;
  /** Concatenated `data:` lines, joined with `"\n"`. */
  data: string;
}

/**
 * Parse a stream of bytes into SSE frames. Yields one frame per
 * blank-line terminator. Frames with no `data:` lines are skipped
 * (per the SSE spec's dispatch rule).
 */
export async function* parseSSE(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<SSEFrame> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  let pending: SSEFrame = { data: "" };
  let dataLines: string[] = [];

  function dispatch(): SSEFrame | null {
    if (dataLines.length === 0) {
      pending = { data: "" };
      dataLines = [];
      return null;
    }
    const frame: SSEFrame = {
      data: dataLines.join("\n"),
    };
    if (pending.id !== undefined) frame.id = pending.id;
    if (pending.event !== undefined) frame.event = pending.event;
    pending = { data: "" };
    dataLines = [];
    return frame;
  }

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        const frame = dispatch();
        if (frame) yield frame;
        continue;
      }
      if (line.startsWith(":")) continue; // comment

      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      switch (field) {
        case "id":
          pending.id = value;
          break;
        case "event":
          pending.event = value;
          break;
        case "data":
          dataLines.push(value);
          break;
        default:
          // Unknown field — spec says ignore.
          break;
      }
    }
  }

  // Flush any final frame even without a trailing blank line.
  const tail = decoder.decode();
  buffer += tail;
  if (buffer.length > 0) {
    // Treat the leftover as a final line (no trailing newline).
    let line = buffer;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line !== "" && !line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") dataLines.push(value);
      else if (field === "id") pending.id = value;
      else if (field === "event") pending.event = value;
    }
  }
  const tailFrame = dispatch();
  if (tailFrame) yield tailFrame;
}
