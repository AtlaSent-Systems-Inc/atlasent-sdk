"""Tests for ``AtlaSentV2Client.evaluate_batch``."""

from __future__ import annotations

import json

import httpx
import pytest

from atlasent_v2_alpha import AtlaSentV2Client, V2Error
from atlasent_v2_alpha.types import BatchEvaluateItem, EvaluateBatchResponse


def _make_client(handler, *, api_key: str = "k") -> AtlaSentV2Client:
    transport = httpx.MockTransport(handler)
    inner = httpx.Client(transport=transport, base_url="https://example.test")
    inner.headers["Authorization"] = f"Bearer {api_key}"
    return AtlaSentV2Client(
        api_key=api_key, base_url="https://example.test", client=inner
    )


SAMPLE_ITEM = BatchEvaluateItem(
    action="deploy",
    agent="deploy-bot",
    context={"commit": "abc"},
)


def _stub_item(i: int = 0) -> dict:
    return {
        "index": i,
        "permitted": True,
        "decision_id": f"dec_{i}",
        "reason": "",
        "audit_hash": "a" * 64,
        "timestamp": "2026-04-27T16:00:00Z",
        "batch_id": "b",
    }


def _ok_response_handler(payload: dict):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    return handler


class TestEvaluateBatch:
    def test_returns_evaluate_batch_response_on_success(self) -> None:
        payload = {
            "batch_id": "33333333-3333-3333-3333-333333333333",
            "items": [_stub_item(0)],
        }
        client = _make_client(_ok_response_handler(payload))
        out = client.evaluate_batch([SAMPLE_ITEM])
        assert isinstance(out, EvaluateBatchResponse)
        assert out.batch_id == "33333333-3333-3333-3333-333333333333"
        assert out.items[0].permitted is True
        assert out.items[0].decision_id == "dec_0"

    def test_posts_to_evaluate_batch_with_requests_and_api_key(self) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["body"] = json.loads(request.content.decode())
            return httpx.Response(200, json={"batch_id": "b", "items": [_stub_item()]})

        client = _make_client(handler, api_key="ask_xyz")
        items = [
            SAMPLE_ITEM,
            BatchEvaluateItem(action="rollback", agent="ops", context={}),
        ]
        client.evaluate_batch(items)
        assert captured["url"] == "https://example.test/v2/evaluate:batch"
        assert captured["body"]["api_key"] == "ask_xyz"
        assert len(captured["body"]["requests"]) == 2
        assert captured["body"]["requests"][1]["action"] == "rollback"

    def test_preserves_order_items_match_requests(self) -> None:
        items = [
            BatchEvaluateItem(action="a", agent="1", context={}),
            BatchEvaluateItem(action="b", agent="2", context={}),
            BatchEvaluateItem(action="c", agent="3", context={}),
        ]
        payload = {
            "batch_id": "b",
            "items": [_stub_item(i) for i in range(len(items))],
        }
        client = _make_client(_ok_response_handler(payload))
        out = client.evaluate_batch(items)
        assert [i.decision_id for i in out.items] == ["dec_0", "dec_1", "dec_2"]
        assert [i.index for i in out.items] == [0, 1, 2]

    def test_passes_payload_hash_and_target_for_pillar9_items(self) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.content.decode())
            return httpx.Response(200, json={"batch_id": "b", "items": [_stub_item()]})

        client = _make_client(handler)
        item = BatchEvaluateItem(
            action="deploy",
            agent="bot",
            context={},
            payload_hash="f" * 64,
            target="prod-cluster",
        )
        client.evaluate_batch([item])
        assert captured["body"]["requests"][0]["payload_hash"] == "f" * 64
        assert captured["body"]["requests"][0]["target"] == "prod-cluster"

    def test_omits_payload_hash_and_target_when_unset(self) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.content.decode())
            return httpx.Response(200, json={"batch_id": "b", "items": [_stub_item()]})

        client = _make_client(handler)
        client.evaluate_batch([SAMPLE_ITEM])
        assert "payload_hash" not in captured["body"]["requests"][0]
        assert "target" not in captured["body"]["requests"][0]

    def test_surfaces_denials(self) -> None:
        denied = _stub_item(0)
        denied["permitted"] = False
        denied["decision_id"] = "dec_denied"
        denied["reason"] = "Missing approver"
        client = _make_client(
            _ok_response_handler({"batch_id": "b", "items": [denied]})
        )
        out = client.evaluate_batch([SAMPLE_ITEM])
        assert out.items[0].permitted is False
        assert out.items[0].reason == "Missing approver"

    def test_rejects_empty_requests_before_sending(self) -> None:
        sent = False

        def handler(_: httpx.Request) -> httpx.Response:
            nonlocal sent
            sent = True
            return httpx.Response(200)

        client = _make_client(handler)
        with pytest.raises(V2Error) as exc:
            client.evaluate_batch([])
        assert exc.value.code == "invalid_argument"
        assert sent is False

    def test_rejects_non_list_input(self) -> None:
        client = _make_client(
            _ok_response_handler({"batch_id": "b", "items": [_stub_item()]})
        )
        with pytest.raises(V2Error) as exc:
            client.evaluate_batch("not a list")  # type: ignore[arg-type]
        assert exc.value.code == "invalid_argument"

    def test_rejects_over_1000_items_before_sending(self) -> None:
        sent = False

        def handler(_: httpx.Request) -> httpx.Response:
            nonlocal sent
            sent = True
            return httpx.Response(200)

        client = _make_client(handler)
        too_many = [SAMPLE_ITEM] * 1001
        with pytest.raises(V2Error) as exc:
            client.evaluate_batch(too_many)
        assert exc.value.code == "invalid_argument"
        assert sent is False

    def test_accepts_exactly_1000_items(self) -> None:
        client = _make_client(
            _ok_response_handler({"batch_id": "b", "items": [_stub_item()]})
        )
        cap = [SAMPLE_ITEM] * 1000
        out = client.evaluate_batch(cap)
        assert out.batch_id == "b"

    def test_401_raises_invalid_api_key(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(401)

        client = _make_client(handler)
        with pytest.raises(V2Error) as exc:
            client.evaluate_batch([SAMPLE_ITEM])
        assert exc.value.status_code == 401
        assert exc.value.code == "invalid_api_key"

    def test_500_raises_http_error(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "boom"})

        client = _make_client(handler)
        with pytest.raises(V2Error) as exc:
            client.evaluate_batch([SAMPLE_ITEM])
        assert exc.value.status_code == 500
        assert exc.value.code == "http_error"
