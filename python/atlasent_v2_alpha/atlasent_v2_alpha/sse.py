"""Minimal Server-Sent Events parser.

Spec: https://html.spec.whatwg.org/multipage/server-sent-events.html

Yields one :class:`SSEFrame` per blank-line-terminated event. Only the
fields the v2 Pillar 3 stream uses are surfaced — ``id``, ``event``,
``data`` (concatenated across multiple lines) — plus comments
(``:``-prefixed lines, ignored).
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass


@dataclass(frozen=True)
class SSEFrame:
    """One parsed SSE frame."""

    data: str
    """Concatenated ``data:`` lines, joined with ``"\\n"``."""

    id: str | None = None
    """SSE ``id:`` field. Surfaces as ``Last-Event-ID`` on reconnect."""

    event: str | None = None
    """SSE ``event:`` field. Defaults to ``"message"`` on the wire."""


def parse_sse_lines(lines: Iterable[str]) -> Iterator[SSEFrame]:
    """Parse SSE lines into frames.

    Lines must NOT include trailing newlines. The blank line that
    terminates each event MUST appear as an empty string in the
    iterable; this matches what ``httpx.Response.iter_lines()``
    produces. State is held across the iteration so callers can pass
    a generator that streams indefinitely.
    """
    pending_id: str | None = None
    pending_event: str | None = None
    data_lines: list[str] = []

    for raw in lines:
        line = raw[:-1] if raw.endswith("\r") else raw

        if line == "":
            if data_lines:
                yield SSEFrame(
                    data="\n".join(data_lines),
                    id=pending_id,
                    event=pending_event,
                )
            pending_id = None
            pending_event = None
            data_lines = []
            continue

        if line.startswith(":"):
            continue  # comment

        if ":" in line:
            field, _, value = line.partition(":")
        else:
            field, value = line, ""
        if value.startswith(" "):
            value = value[1:]

        if field == "id":
            pending_id = value
        elif field == "event":
            pending_event = value
        elif field == "data":
            data_lines.append(value)
        # Unknown fields are ignored per spec.

    # Flush a final frame if the stream ends without a trailing blank line.
    if data_lines:
        yield SSEFrame(
            data="\n".join(data_lines),
            id=pending_id,
            event=pending_event,
        )


def _split_lines(chunks: Iterable[bytes]) -> Iterator[str]:
    """Split a byte stream into lines without trailing newlines.

    Holds a buffer across chunks so a line split mid-chunk reassembles
    correctly. Lenient UTF-8 decoding mirrors the TS parser.
    """
    buffer = ""
    for chunk in chunks:
        buffer += chunk.decode("utf-8", errors="replace")
        while True:
            nl = buffer.find("\n")
            if nl < 0:
                break
            yield buffer[:nl]
            buffer = buffer[nl + 1 :]
    if buffer:
        yield buffer


def parse_sse_bytes(chunks: Iterable[bytes]) -> Iterator[SSEFrame]:
    """Parse a stream of raw bytes into SSE frames.

    Use this when you have a raw byte iterator (e.g.
    ``httpx.Response.iter_bytes``). When the transport already splits
    by line (``iter_lines()``), prefer :func:`parse_sse_lines`.
    """
    yield from parse_sse_lines(_split_lines(chunks))
