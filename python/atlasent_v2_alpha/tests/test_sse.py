"""Tests for the SSE parser used by ``subscribe_decisions``."""

from __future__ import annotations

from atlasent_v2_alpha import parse_sse_bytes, parse_sse_lines


def _frames(text: str) -> list:
    """Parse a single string blob via the byte parser (one chunk)."""
    return list(parse_sse_bytes([text.encode("utf-8")]))


class TestParseSseBytes:
    def test_single_data_only_event(self) -> None:
        frames = _frames("data: hello\n\n")
        assert len(frames) == 1
        assert frames[0].data == "hello"
        assert frames[0].id is None
        assert frames[0].event is None

    def test_strips_optional_space_after_colon(self) -> None:
        frames = _frames("data:nospace\n\n")
        assert frames[0].data == "nospace"

    def test_concatenates_multiple_data_lines(self) -> None:
        frames = _frames("data: line1\ndata: line2\n\n")
        assert frames[0].data == "line1\nline2"

    def test_captures_id_field(self) -> None:
        frames = _frames("id: 42\ndata: x\n\n")
        assert frames[0].id == "42"
        assert frames[0].data == "x"

    def test_captures_event_field(self) -> None:
        frames = _frames("event: ping\ndata: x\n\n")
        assert frames[0].event == "ping"

    def test_ignores_comment_lines(self) -> None:
        frames = _frames(": keepalive\ndata: x\n\n")
        assert len(frames) == 1
        assert frames[0].data == "x"

    def test_skips_frames_with_no_data_lines(self) -> None:
        frames = _frames("event: just-event\n\ndata: real\n\n")
        assert len(frames) == 1
        assert frames[0].data == "real"

    def test_yields_multiple_frames(self) -> None:
        wire = "id: 1\ndata: one\n\n" "id: 2\ndata: two\n\n" "id: 3\ndata: three\n\n"
        frames = _frames(wire)
        assert [f.data for f in frames] == ["one", "two", "three"]
        assert [f.id for f in frames] == ["1", "2", "3"]

    def test_handles_split_across_chunks(self) -> None:
        chunks = [b"data: hel", b"lo wor", b"ld\n\n"]
        frames = list(parse_sse_bytes(chunks))
        assert frames[0].data == "hello world"

    def test_handles_event_split_across_chunks(self) -> None:
        chunks = [b"id: 1\nda", b"ta: x\n", b"\nid: 2\ndata: y\n\n"]
        frames = list(parse_sse_bytes(chunks))
        assert [f.id for f in frames] == ["1", "2"]
        assert [f.data for f in frames] == ["x", "y"]

    def test_normalizes_crlf_line_endings(self) -> None:
        frames = _frames("data: a\r\ndata: b\r\n\r\n")
        assert frames[0].data == "a\nb"

    def test_flushes_final_frame_without_trailing_blank(self) -> None:
        frames = _frames("data: solo")
        assert frames[0].data == "solo"

    def test_ignores_unknown_fields(self) -> None:
        frames = _frames("retry: 1000\ndata: x\n\n")
        assert frames[0].data == "x"


class TestParseSseLines:
    def test_state_persists_across_iterator(self) -> None:
        # Each '' marks a frame boundary; the parser must hold state
        # across non-blank lines until it sees a blank.
        lines = ["id: 7", "data: a", "data: b", "", "id: 8", "data: c", ""]
        frames = list(parse_sse_lines(lines))
        assert [f.id for f in frames] == ["7", "8"]
        assert [f.data for f in frames] == ["a\nb", "c"]
