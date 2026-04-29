"""Tests for ``AtlaSentV2Client.subscribe_decisions``."""

from __future__ import annotations

import httpx
import pytest

from atlasent_v2_alpha import AtlaSentV2Client, DecisionEvent, V2Error


def _make_client(handler, *, api_key: str = "k") -> AtlaSentV2Client:
    transport = httpx.MockTransport(handler)
    inner = httpx.Client(transport=transport, base_url="https://example.test")
    inner.headers["Authorization"] = f"Bearer {api_key}"
    return AtlaSentV2Client(
        api_key=api_key, base_url="https://example.test", client=inner
    )


def _stream_response(body: str, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status,
        content=body.encode("utf-8"),
        headers={"content-type": "text/event-stream"},
    )


class TestSubscribeDecisions:
    def test_yields_one_decision_event_per_frame(self) -> None:
        wire = (
            'id: 1\ndata: {"id":"1","type":"permit_issued",'
            '"org_id":"o","emitted_at":"2026-04-27T16:00:00Z"}\n\n'
            'id: 2\ndata: {"id":"2","type":"verified",'
            '"org_id":"o","emitted_at":"2026-04-27T16:00:01Z"}\n\n'
        )

        def handler(_: httpx.Request) -> httpx.Response:
            return _stream_response(wire)

        client = _make_client(handler)
        events = list(client.subscribe_decisions())
        assert [e.id for e in events] == ["1", "2"]
        assert [e.type for e in events] == ["permit_issued", "verified"]
        assert all(isinstance(e, DecisionEvent) for e in events)

    def test_requests_subscribe_endpoint_with_correct_headers(self) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["accept"] = request.headers.get("accept")
            captured["auth"] = request.headers.get("authorization")
            captured["last_event_id"] = request.headers.get("last-event-id")
            return _stream_response("")

        client = _make_client(handler, api_key="ask")
        list(client.subscribe_decisions())

        assert captured["url"] == "https://example.test/v2/decisions:subscribe"
        assert captured["accept"] == "text/event-stream"
        assert captured["auth"] == "Bearer ask"
        assert captured["last_event_id"] is None

    def test_sends_last_event_id_when_provided(self) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["last_event_id"] = request.headers.get("last-event-id")
            return _stream_response("")

        client = _make_client(handler)
        list(client.subscribe_decisions(last_event_id="abc-123"))
        assert captured["last_event_id"] == "abc-123"

    def test_forwards_unknown_event_types(self) -> None:
        wire = (
            'data: {"id":"1","type":"future_event_kind",'
            '"org_id":"o","emitted_at":"x","payload":{"new_field":42}}\n\n'
        )

        def handler(_: httpx.Request) -> httpx.Response:
            return _stream_response(wire)

        client = _make_client(handler)
        events = list(client.subscribe_decisions())
        assert events[0].type == "future_event_kind"
        assert events[0].payload == {"new_field": 42}

    def test_skips_malformed_json_frames(self) -> None:
        wire = (
            "data: {malformed\n\n"
            'data: {"id":"2","type":"verified",'
            '"org_id":"o","emitted_at":"x"}\n\n'
        )

        def handler(_: httpx.Request) -> httpx.Response:
            return _stream_response(wire)

        client = _make_client(handler)
        events = list(client.subscribe_decisions())
        assert len(events) == 1
        assert events[0].id == "2"

    def test_skips_comment_keepalive_frames(self) -> None:
        wire = (
            ": keepalive\n\n"
            'data: {"id":"7","type":"consumed",'
            '"org_id":"o","emitted_at":"x"}\n\n'
        )

        def handler(_: httpx.Request) -> httpx.Response:
            return _stream_response(wire)

        client = _make_client(handler)
        events = list(client.subscribe_decisions())
        assert len(events) == 1
        assert events[0].id == "7"

    def test_401_raises_invalid_api_key(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(401, content=b"")

        client = _make_client(handler)
        gen = client.subscribe_decisions()
        with pytest.raises(V2Error) as exc:
            next(gen)
        assert exc.value.status_code == 401
        assert exc.value.code == "invalid_api_key"

    def test_5xx_raises_http_error(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(503, content=b"")

        client = _make_client(handler)
        gen = client.subscribe_decisions()
        with pytest.raises(V2Error) as exc:
            next(gen)
        assert exc.value.status_code == 503
        assert exc.value.code == "http_error"

    def test_connection_error_raises_network(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        client = _make_client(handler)
        gen = client.subscribe_decisions()
        with pytest.raises(V2Error) as exc:
            next(gen)
        assert exc.value.code == "network"
