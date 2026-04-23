"""Tests for AsyncAtlaSentClient.evaluate_stream."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from atlasent.async_client import AsyncAtlaSentClient
from atlasent.exceptions import AtlaSentError, RateLimitError
from atlasent.models import EvaluateStreamEvent


def _sse_lines(*events: dict) -> list[str]:
    """Format dicts as SSE data lines."""
    lines = []
    for event in events:
        lines.append(f"data: {json.dumps(event)}")
        lines.append("")
    return lines


def _make_stream_response(lines: list[str], status_code: int = 200):
    """Return a mock httpx.Response whose aiter_lines() yields *lines*."""

    async def _aiter_lines():
        for line in lines:
            yield line

    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.headers = {}
    resp.aiter_lines = _aiter_lines
    return resp


REASONING = {"type": "reasoning", "content": "Checking policies…"}
POLICY_CHECK = {"type": "policy_check", "policy_id": "pol_abc", "outcome": "pass"}
DECISION_PERMIT = {
    "type": "decision",
    "permitted": True,
    "decision_id": "dec_stream_1",
    "reason": "All policies passed",
    "audit_hash": "h_stream",
    "timestamp": "2025-01-15T12:00:00Z",
}
DECISION_DENY = {
    "type": "decision",
    "permitted": False,
    "decision_id": "dec_stream_2",
    "reason": "Policy blocked",
    "audit_hash": "",
    "timestamp": "2025-01-15T12:01:00Z",
}


@pytest.fixture
def client():
    return AsyncAtlaSentClient(api_key="test_key", max_retries=0)


class TestEvaluateStreamHappyPath:
    @pytest.mark.asyncio
    async def test_yields_all_events(self, client):
        lines = _sse_lines(REASONING, POLICY_CHECK, DECISION_PERMIT)
        mock_resp = _make_stream_response(lines)

        mock_cm = MagicMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_cm.__aexit__ = AsyncMock(return_value=False)

        with patch.object(client._client, "stream", return_value=mock_cm):
            events = []
            async for ev in client.evaluate_stream("read_phi", "agent-1"):
                events.append(ev)

        assert len(events) == 3
        assert events[0].type == "reasoning"
        assert events[0].content == "Checking policies…"
        assert events[1].type == "policy_check"
        assert events[1].policy_id == "pol_abc"
        assert events[2].type == "decision"
        assert events[2].permitted is True
        assert events[2].permit_token == "dec_stream_1"

    @pytest.mark.asyncio
    async def test_deny_decision_yields_not_raises(self, client):
        lines = _sse_lines(DECISION_DENY)
        mock_resp = _make_stream_response(lines)

        mock_cm = MagicMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_cm.__aexit__ = AsyncMock(return_value=False)

        with patch.object(client._client, "stream", return_value=mock_cm):
            events = [ev async for ev in client.evaluate_stream("write_phi", "agent-2")]

        assert len(events) == 1
        assert events[0].type == "decision"
        assert events[0].permitted is False

    @pytest.mark.asyncio
    async def test_done_sentinel_stops_iteration(self, client):
        lines = _sse_lines(REASONING) + ["data: [DONE]", ""]
        mock_resp = _make_stream_response(lines)

        mock_cm = MagicMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_cm.__aexit__ = AsyncMock(return_value=False)

        with patch.object(client._client, "stream", return_value=mock_cm):
            events = [ev async for ev in client.evaluate_stream("act", "agent")]

        assert len(events) == 1
        assert events[0].type == "reasoning"

    @pytest.mark.asyncio
    async def test_non_data_lines_ignored(self, client):
        lines = [
            ": keep-alive",
            "",
            f"data: {json.dumps(DECISION_PERMIT)}",
            "",
        ]
        mock_resp = _make_stream_response(lines)

        mock_cm = MagicMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_cm.__aexit__ = AsyncMock(return_value=False)

        with patch.object(client._client, "stream", return_value=mock_cm):
            events = [ev async for ev in client.evaluate_stream("act", "agent")]

        assert len(events) == 1

    @pytest.mark.asyncio
    async def test_malformed_json_line_skipped(self, client):
        lines = [
            "data: {not valid json}",
            "",
            f"data: {json.dumps(DECISION_PERMIT)}",
            "",
        ]
        mock_resp = _make_stream_response(lines)

        mock_cm = MagicMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_cm.__aexit__ = AsyncMock(return_value=False)

        with patch.object(client._client, "stream", return_value=mock_cm):
            events = [ev async for ev in client.evaluate_stream("act", "agent")]

        assert len(events) == 1
        assert events[0].type == "decision"


class TestEvaluateStreamErrors:
    @pytest.mark.asyncio
    async def test_401_raises(self, client):
        mock_resp = _make_stream_response([], status_code=401)
        mock_cm = MagicMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_cm.__aexit__ = AsyncMock(return_value=False)

        with patch.object(client._client, "stream", return_value=mock_cm):
            with pytest.raises(AtlaSentError) as exc_info:
                async for _ in client.evaluate_stream("act", "agent"):
                    pass

        assert exc_info.value.status_code == 401
        assert exc_info.value.code == "invalid_api_key"

    @pytest.mark.asyncio
    async def test_429_raises_rate_limit(self, client):
        mock_resp = _make_stream_response([], status_code=429)
        mock_resp.headers = {"retry-after": "5"}
        mock_cm = MagicMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_cm.__aexit__ = AsyncMock(return_value=False)

        with patch.object(client._client, "stream", return_value=mock_cm):
            with pytest.raises(RateLimitError):
                async for _ in client.evaluate_stream("act", "agent"):
                    pass

    @pytest.mark.asyncio
    async def test_500_raises_server_error(self, client):
        mock_resp = _make_stream_response([], status_code=500)
        mock_cm = MagicMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_cm.__aexit__ = AsyncMock(return_value=False)

        with patch.object(client._client, "stream", return_value=mock_cm):
            with pytest.raises(AtlaSentError) as exc_info:
                async for _ in client.evaluate_stream("act", "agent"):
                    pass

        assert exc_info.value.code == "server_error"


class TestEvaluateStreamEventModel:
    def test_reasoning_event(self):
        ev = EvaluateStreamEvent.model_validate({"type": "reasoning", "content": "hi"})
        assert ev.type == "reasoning"
        assert ev.content == "hi"

    def test_policy_check_event(self):
        ev = EvaluateStreamEvent.model_validate(
            {"type": "policy_check", "policy_id": "p1", "outcome": "pass"}
        )
        assert ev.policy_id == "p1"
        assert ev.outcome == "pass"

    def test_decision_event_alias(self):
        ev = EvaluateStreamEvent.model_validate(
            {
                "type": "decision",
                "permitted": True,
                "decision_id": "dec_xyz",
                "audit_hash": "h1",
            }
        )
        assert ev.permit_token == "dec_xyz"
        assert ev.permitted is True
        assert ev.audit_hash == "h1"
