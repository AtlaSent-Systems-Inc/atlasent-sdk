/**
 * Server-Sent Events parser for the Pillar 3 decision-event stream.
 *
 * Consumes a stream of `Uint8Array` chunks (typically `response.body`
 * from a `fetch()` against `GET /v2/decisions:subscribe`) and yields
 * typed {@link DecisionEvent} objects. Pure parsing — no HTTP
 * client, no reconnect logic, no state beyond the line buffer.
 *
 * Reconnect / `Last-Event-ID` is left to the consumer because:
 *   - Different runtimes have different reconnect concerns (Node
 *     fetch vs. browser EventSource vs. a custom HTTP client).
 *   - The parser exposes each event's `id` so the consumer can
 *     bookmark state and resume cleanly.
 *
 * Spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
 *   - LF, CR, and CRLF all terminate lines.
 *   - Lines starting with `:` are comments (heartbeats).
 *   - A blank line dispatches the buffered event.
 *   - Multi-line `data:` fields concatenate with `\n`.
 *   - `event:` defaults to "message".
 */

import {
  KNOWN_DECISION_EVENT_TYPES,
  type DecisionEvent,
  type DecisionEventCommon,
} from "./decisionEvent.js";

/**
 * Yield each {@link DecisionEvent} parsed from an SSE byte stream.
 *
 * `source` accepts either an async iterable of chunks (Node 18+
 * `fetch().body` works directly because `ReadableStream` is async-
 * iterable) or a {@link ReadableStream}. Chunk boundaries do not
 * need to align with line or event boundaries — the parser buffers
 * across chunks.
 *
 * Heartbeat / comment lines (anything starting with `:`) are
 * silently skipped. Malformed `data:` JSON throws — callers should
 * wrap the for-await in try/catch and decide whether to retry the
 * stream or log and continue.
 */
export async function* parseDecisionEventStream(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncIterable<DecisionEvent> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let dataLines: string[] = [];
  let eventType = "message";
  let eventId: string | undefined;

  function dispatch(): DecisionEvent | undefined {
    if (dataLines.length === 0) {
      // Empty event — reset and skip per the SSE spec.
      eventType = "message";
      eventId = undefined;
      return undefined;
    }
    const data = dataLines.join("\n");
    // Reset buffers BEFORE parsing so a throw from JSON.parse
    // doesn't strand the next event.
    const finalEventType = eventType;
    const finalEventId = eventId;
    dataLines = [];
    eventType = "message";
    eventId = undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      throw new Error(
        `parseDecisionEventStream: invalid JSON in event payload: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        "parseDecisionEventStream: event data must be a JSON object",
      );
    }
    const obj = parsed as Record<string, unknown>;
    return buildEvent(obj, finalEventType, finalEventId);
  }

  for await (const chunk of toAsyncIterable(source)) {
    buffer += decoder.decode(chunk, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = nextLineBreak(buffer)) !== -1) {
      const rawLine = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + lineBreakWidth(buffer, newlineIdx));

      if (rawLine === "") {
        const ev = dispatch();
        if (ev !== undefined) yield ev;
        continue;
      }
      if (rawLine.startsWith(":")) {
        // Comment / heartbeat — ignore.
        continue;
      }

      const colonIdx = rawLine.indexOf(":");
      let field: string;
      let value: string;
      if (colonIdx === -1) {
        // Per spec: a line with no colon is a field name with empty value.
        field = rawLine;
        value = "";
      } else {
        field = rawLine.slice(0, colonIdx);
        value = rawLine.slice(colonIdx + 1);
        // Strip a single leading space if present.
        if (value.startsWith(" ")) value = value.slice(1);
      }

      switch (field) {
        case "event":
          eventType = value;
          break;
        case "data":
          dataLines.push(value);
          break;
        case "id":
          // SSE forbids NUL in id; treat presence-of-NUL as id-not-set.
          if (!value.includes("\0")) eventId = value;
          break;
        case "retry":
          // SSE retry hint — opaque to this parser; callers handle reconnect.
          break;
        default:
          // Unknown field — ignored per spec.
          break;
      }
    }
  }

  // Flush trailing decoder bytes (e.g. half a multi-byte char).
  buffer += decoder.decode();
  // If the stream ended without a trailing blank line, dispatch
  // whatever's buffered — matches what browsers do on EOF.
  if (buffer.length > 0 || dataLines.length > 0) {
    if (buffer.length > 0) {
      // Process whatever's left as a final line. We don't do this
      // recursively to avoid an unbounded loop — anything weirder
      // than a single trailing line breaks the spec anyway.
      const final = buffer;
      buffer = "";
      if (final.startsWith(":")) {
        // Comment — skip.
      } else {
        const colonIdx = final.indexOf(":");
        if (colonIdx !== -1) {
          const field = final.slice(0, colonIdx);
          let value = final.slice(colonIdx + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "data") dataLines.push(value);
          else if (field === "event") eventType = value;
          else if (field === "id" && !value.includes("\0")) eventId = value;
        }
      }
    }
    const ev = dispatch();
    if (ev !== undefined) yield ev;
  }
}

// ─── Internals ────────────────────────────────────────────────────────

function buildEvent(
  obj: Record<string, unknown>,
  fallbackEventType: string,
  fallbackEventId: string | undefined,
): DecisionEvent {
  // `data:` JSON is the source of truth for `id`, `type`, `org_id`,
  // `emitted_at`, etc. (per the schema). The SSE field-line `id:` and
  // `event:` are duplicated by the server for `Last-Event-ID` resume
  // and Sec-Type discrimination, but if the JSON contradicts the
  // SSE field-line we trust the JSON — the schema is the wire law.
  const id = typeof obj.id === "string" ? obj.id : fallbackEventId ?? "";
  const type = typeof obj.type === "string" ? obj.type : fallbackEventType;
  const org_id = typeof obj.org_id === "string" ? obj.org_id : "";
  const emitted_at = typeof obj.emitted_at === "string" ? obj.emitted_at : "";
  const payload =
    obj.payload !== null &&
    typeof obj.payload === "object" &&
    !Array.isArray(obj.payload)
      ? (obj.payload as Record<string, unknown>)
      : {};

  const common: DecisionEventCommon = { id, org_id, emitted_at };
  if (typeof obj.permit_id === "string") common.permit_id = obj.permit_id;
  if (obj.actor_id === null) common.actor_id = null;
  else if (typeof obj.actor_id === "string") common.actor_id = obj.actor_id;

  if (KNOWN_DECISION_EVENT_TYPES.has(type)) {
    return { ...common, type, payload } as DecisionEvent;
  }
  // Unknown event type — surface as opaque data so callers can log / forward.
  return { ...common, type, payload } as DecisionEvent;
}

function nextLineBreak(s: string): number {
  // Find the first LF, CR, or CRLF. Returns the index of the line
  // break's first character; lineBreakWidth() reports how many
  // characters to skip past it.
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 0x0a) return i; // LF
    if (c === 0x0d) return i; // CR (possibly followed by LF)
  }
  return -1;
}

function lineBreakWidth(s: string, idx: number): number {
  if (s.charCodeAt(idx) === 0x0d && s.charCodeAt(idx + 1) === 0x0a) return 2;
  return 1;
}

function toAsyncIterable(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  // Node 20+ and modern browsers expose `Symbol.asyncIterator` on
  // ReadableStream directly. Cast through the union; the type guard
  // is unnecessary at runtime.
  return source as AsyncIterable<Uint8Array>;
}
