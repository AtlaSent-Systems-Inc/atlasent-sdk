"""Tests for AsyncAtlaSentClient.protect_stream (SSE streaming evaluate)."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from atlasent import AsyncAtlaSentClient, StreamDecisionEvent, StreamProgressEvent

API_KEY = "ask_test_stream"
BASE_URL = "https://api.atlasent.io"


# ── SSE helpers ───────────────────────────────────────────────────────────────


def _decision(
    *,
    permitted: bool = True,
    decision_id: str = "dec_s1",
    reason: str = "ok",
    audit_hash: str = "h1",
    timestamp: str = "2026-04-30T00:00:00Z",
    is_final: bool = True,
) -> str:
    data = json.dumps(
        dict(
            permitted=permitted,
            decision_id=decision_id,
            reason=reason,
            audit_hash=audit_hash,
            timestamp=timestamp,
            is_final=is_final,
        )
    )
    return f"event: decision\ndata: {data}\n"


def _progress(stage: str = "policy_loading") -> str:
    return f"event: progress\ndata: {json.dumps({'stage': stage})}\n"


def _done() -> str:
    return "event: done\ndata: {}\n"


def _error(code: str = "server_error", message: str = "oops") -> str:
    return f"event: error\ndata: {json.dumps({'code': code, 'message': message})}\n"


async def _lines_from(*blocks: str):
    """Async generator that yields each line from the blocks, inserting a blank
    line (event separator) between blocks as the SSE spec requires."""
    for block in blocks:
        for line in block.splitlines():
            yield line
        yield ""  # event separator blank line


def _make_mock_response(lines_gen, status: int = 200) -> MagicMock:
    response = MagicMock()
    response.status_code = status
    response.aiter_lines = MagicMock(return_value=lines_gen)
    response.__aenter__ = AsyncMock(return_value=response)
    response.__aexit__ = AsyncMock(return_value=None)
    return response


def _patched_client() -> AsyncAtlaSentClient:
    return AsyncAtlaSentClient(api_key=API_KEY, base_url=BASE_URL)


# ── collect helper ────────────────────────────────────────────────────────────


async def collect(client: AsyncAtlaSentClient, **kwargs: Any) -> list[Any]:
    events = []
    async for event in client.protect_stream(**kwargs):
        events.append(event)
    return events


# ── tests ──────────────────────────────────────────────────────────────────────


class TestProtectStream:
    async def test_yields_final_decision_event(self) -> None:
        lines = _lines_from(_decision(decision_id="dec_final"), _done())
        response = _make_mock_response(lines)

        with patch.object(
            _patched_client()._client, "stream", return_value=response
        ) as mock_stream:
            client = _patched_client()
            mock_stream.return_value = response
            client._client.stream = MagicMock(return_value=response)
            events = await collect(client, agent="bot", action="read")

        assert len(events) == 1
        ev = events[0]
        assert isinstance(ev, StreamDecisionEvent)
        assert ev.decision == "ALLOW"
        assert ev.permit_id == "dec_final"
        assert ev.is_final is True

    async def test_yields_deny_decision(self) -> None:
        lines = _lines_from(
            _decision(permitted=False, decision_id="dec_deny", is_final=True), _done()
        )
        response = _make_mock_response(lines)
        client = _patched_client()
        client._client.stream = MagicMock(return_value=response)

        events = await collect(client, agent="bot", action="delete")

        assert len(events) == 1
        assert isinstance(events[0], StreamDecisionEvent)
        assert events[0].decision == "DENY"

    async def test_yields_progress_then_decision(self) -> None:
        lines = _lines_from(
            _progress("context_enrichment"),
            _decision(decision_id="dec_prog"),
            _done(),
        )
        response = _make_mock_response(lines)
        client = _patched_client()
        client._client.stream = MagicMock(return_value=response)

        events = await collect(client, agent="bot", action="write")

        assert len(events) == 2
        assert isinstance(events[0], StreamProgressEvent)
        assert events[0].stage == "context_enrichment"
        assert isinstance(events[1], StreamDecisionEvent)

    async def test_yields_interim_then_final_decision(self) -> None:
        lines = _lines_from(
            _decision(decision_id="dec_interim", is_final=False),
            _decision(decision_id="dec_final", is_final=True),
            _done(),
        )
        response = _make_mock_response(lines)
        client = _patched_client()
        client._client.stream = MagicMock(return_value=response)

        events = await collect(client, agent="bot", action="read")

        assert len(events) == 2
        assert events[0].is_final is False  # type: ignore[union-attr]
        assert events[1].is_final is True  # type: ignore[union-attr]

    async def test_raises_on_error_event(self) -> None:
        from atlasent.exceptions import AtlaSentError

        lines = _lines_from(_error(code="server_error", message="upstream timeout"))
        response = _make_mock_response(lines)
        client = _patched_client()
        client._client.stream = MagicMock(return_value=response)

        with pytest.raises(AtlaSentError, match="upstream timeout"):
            await collect(client, agent="bot", action="read")

    async def test_raises_on_non_200_status(self) -> None:
        from atlasent.exceptions import AtlaSentError

        response = MagicMock()
        response.status_code = 403
        response.aread = AsyncMock(return_value=b'{"error":"forbidden"}')
        response.__aenter__ = AsyncMock(return_value=response)
        response.__aexit__ = AsyncMock(return_value=None)

        client = _patched_client()
        client._client.stream = MagicMock(return_value=response)

        with pytest.raises(AtlaSentError):
            await collect(client, agent="bot", action="read")

    async def test_skips_unknown_event_types(self) -> None:
        unknown = 'event: future_hint\ndata: {"x": 1}\n'
        lines = _lines_from(unknown, _decision(), _done())
        response = _make_mock_response(lines)
        client = _patched_client()
        client._client.stream = MagicMock(return_value=response)

        events = await collect(client, agent="bot", action="read")

        assert len(events) == 1
        assert isinstance(events[0], StreamDecisionEvent)

    async def test_stops_at_done_before_further_events(self) -> None:
        lines = _lines_from(_done(), _decision())  # decision after done is ignored
        response = _make_mock_response(lines)
        client = _patched_client()
        client._client.stream = MagicMock(return_value=response)

        events = await collect(client, agent="bot", action="read")

        assert events == []
