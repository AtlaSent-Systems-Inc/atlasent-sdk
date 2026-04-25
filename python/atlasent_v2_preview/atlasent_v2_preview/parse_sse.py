"""Server-Sent Events parser for the Pillar 3 decision-event stream.

Python sibling of
``typescript/packages/v2-preview/src/parseSse.ts``. Same wire
behavior, same spec compliance, same error surface; framework-
neutral so it composes with httpx, aiohttp, or any
``AsyncIterator[bytes]`` source.

Reconnect / Last-Event-ID is the consumer's job — the parser
exposes each event's ``id`` so the consumer can bookmark and
resume cleanly.

Spec: https://html.spec.whatwg.org/multipage/server-sent-events.html

  * LF, CR, and CRLF all terminate lines.
  * Lines starting with ``:`` are comments (heartbeats); ignored.
  * A blank line dispatches the buffered event.
  * Multi-line ``data:`` fields concatenate with ``\\n``.
  * ``event:`` defaults to "message".
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

from .decision_event import DecisionEvent, build_decision_event


async def parse_decision_event_stream(
    source: AsyncIterator[bytes],
) -> AsyncIterator[DecisionEvent]:
    """Yield each :class:`DecisionEvent` parsed from an SSE byte stream.

    ``source`` is any async iterator of bytes — typically
    ``httpx_response.aiter_bytes()`` from a streaming GET against
    ``/v2/decisions:subscribe``. Chunk boundaries do not need to align
    with line or event boundaries; the parser buffers across chunks.

    Heartbeat / comment lines (anything starting with ``:``) are
    silently skipped. Malformed JSON in a ``data:`` payload raises
    :class:`ValueError` — callers wrap the ``async for`` in
    ``try/except`` and decide whether to retry the stream or log
    and continue.
    """
    buffer = ""
    data_lines: list[str] = []
    event_type = "message"
    event_id: str | None = None
    decoder = _IncrementalUtf8()

    def dispatch() -> DecisionEvent | None:
        nonlocal data_lines, event_type, event_id
        if not data_lines:
            event_type = "message"
            event_id = None
            return None
        data = "\n".join(data_lines)
        final_type = event_type
        final_id = event_id
        data_lines = []
        event_type = "message"
        event_id = None

        try:
            parsed = json.loads(data)
        except ValueError as err:
            raise ValueError(
                f"parse_decision_event_stream: invalid JSON in event payload: {err}"
            ) from err
        if not isinstance(parsed, dict):
            raise ValueError(
                "parse_decision_event_stream: event data must be a JSON object"
            )
        return build_decision_event(
            parsed, fallback_type=final_type, fallback_id=final_id
        )

    async for chunk in source:
        buffer += decoder.feed(chunk)

        while True:
            split = _split_first_line(buffer)
            if split is None:
                break
            line, buffer = split

            if line == "":
                ev = dispatch()
                if ev is not None:
                    yield ev
                continue
            if line.startswith(":"):
                continue

            field, value = _parse_field(line)
            if field == "event":
                event_type = value
            elif field == "data":
                data_lines.append(value)
            elif field == "id":
                if "\0" not in value:
                    event_id = value
            elif field == "retry":
                # SSE retry hint — consumers handle reconnect themselves.
                pass
            # Unknown fields are ignored per the spec.

    # Flush any decoder bytes (e.g. half a multi-byte char).
    buffer += decoder.flush()
    if buffer or data_lines:
        if buffer:
            final = buffer
            buffer = ""
            if final.startswith(":"):
                pass  # Trailing comment — skip.
            else:
                field, value = _parse_field(final)
                if field == "data":
                    data_lines.append(value)
                elif field == "event":
                    event_type = value
                elif field == "id" and "\0" not in value:
                    event_id = value
        ev = dispatch()
        if ev is not None:
            yield ev


# ── Internals ────────────────────────────────────────────────────────


def _parse_field(line: str) -> tuple[str, str]:
    """Split an SSE field line into ``(field, value)``.

    Per spec, a non-empty line with no colon is the field name with
    an empty value. A leading single space on the value is stripped.
    """
    colon_idx = line.find(":")
    if colon_idx == -1:
        return line, ""
    field = line[:colon_idx]
    value = line[colon_idx + 1 :]
    if value.startswith(" "):
        value = value[1:]
    return field, value


def _split_first_line(s: str) -> tuple[str, str] | None:
    """Split off the first complete line.

    Returns ``(line, remainder)`` when a line break is found, or
    ``None`` if the buffer doesn't yet contain a complete line.
    Recognizes LF, CR, and CRLF. A trailing CR with no following byte
    yet is held back in case the next chunk supplies an LF.
    """
    for i, c in enumerate(s):
        if c == "\n":
            return s[:i], s[i + 1 :]
        if c == "\r":
            # Look for a following LF to consume CRLF in one go.
            if i + 1 < len(s) and s[i + 1] == "\n":
                return s[:i], s[i + 2 :]
            # Bare CR — treat as a line break unless we're at the end
            # of the buffer (more bytes might arrive making it CRLF).
            if i + 1 == len(s):
                return None
            return s[:i], s[i + 1 :]
    return None


class _IncrementalUtf8:
    """UTF-8 decoder that retains partial multi-byte sequences across chunks.

    ``json.loads`` only sees fully-formed strings; the buffer pattern
    here is the same one ``TextDecoder({stream: true})`` provides on
    the JS side, ensuring multi-byte chars don't corrupt across
    chunk boundaries.
    """

    def __init__(self) -> None:
        self._buf = b""

    def feed(self, chunk: bytes) -> str:
        self._buf += chunk
        # Decode as much as we can; anything that fails because of a
        # truncated trailing sequence stays in the buffer for next time.
        try:
            text = self._buf.decode("utf-8")
            self._buf = b""
            return text
        except UnicodeDecodeError as err:
            # err.start is the index of the first byte that decoded;
            # err.end is one past the last fully-decoded byte. Anything
            # from err.start onwards is "potentially valid if we get
            # more bytes" — keep it for the next feed.
            text = self._buf[: err.start].decode("utf-8")
            self._buf = self._buf[err.start :]
            return text

    def flush(self) -> str:
        if not self._buf:
            return ""
        # End of stream — replace any malformed trailing bytes rather
        # than raising. SSE consumers want best-effort, not strict.
        out = self._buf.decode("utf-8", errors="replace")
        self._buf = b""
        return out
