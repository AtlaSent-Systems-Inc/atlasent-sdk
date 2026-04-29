"""Tests for ``AtlaSentV2Client.bulk_revoke`` (Pillar 8 — Temporal bulk revoke).

Uses ``httpx.MockTransport`` so the client exercises the full request/response
cycle without touching the network.
"""

from __future__ import annotations

import json

import httpx
import pytest

from atlasent_v2_alpha import AtlaSentV2Client, V2Error
from atlasent_v2_alpha.types import BulkRevokeResponse


def _make_client(handler, *, api_key: str = "k") -> AtlaSentV2Client:
    transport = httpx.MockTransport(handler)
    inner = httpx.Client(transport=transport, base_url="https://example.test")
    inner.headers["Authorization"] = f"Bearer {api_key}"
    return AtlaSentV2Client(
        api_key=api_key, base_url="https://example.test", client=inner
    )


_REVOKE_RESPONSE = {
    "revoked_count": 3,
    "workflow_id": "wf-abc123",
    "run_id": "run-00000000-0000-0000-0000-000000000001",
}


class TestBulkRevoke:
    def test_returns_bulk_revoke_response_on_success(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_REVOKE_RESPONSE)

        client = _make_client(handler)
        out = client.bulk_revoke(
            workflow_id="wf-abc123",
            run_id="run-00000000-0000-0000-0000-000000000001",
            reason="emergency shutdown",
        )
        assert isinstance(out, BulkRevokeResponse)
        assert out.revoked_count == 3
        assert out.workflow_id == "wf-abc123"
        assert out.run_id == "run-00000000-0000-0000-0000-000000000001"

    def test_sends_correct_body_with_snake_case_keys_and_api_key(self) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["method"] = request.method
            captured["body"] = json.loads(request.content.decode())
            return httpx.Response(200, json=_REVOKE_RESPONSE)

        client = _make_client(handler, api_key="ask_live_xyz")
        client.bulk_revoke(
            workflow_id="wf-abc123",
            run_id="run-uuid",
            reason="emergency shutdown",
            revoker_id="revoker-42",
        )
        assert captured["url"] == "https://example.test/v2/permits:bulk-revoke"
        assert captured["method"] == "POST"
        assert captured["body"] == {
            "workflow_id": "wf-abc123",
            "run_id": "run-uuid",
            "reason": "emergency shutdown",
            "revoker_id": "revoker-42",
            "api_key": "ask_live_xyz",
        }

    def test_omits_revoker_id_when_not_supplied(self) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.content.decode())
            return httpx.Response(200, json=_REVOKE_RESPONSE)

        client = _make_client(handler)
        client.bulk_revoke(
            workflow_id="wf-abc123",
            run_id="run-uuid",
            reason="scheduled teardown",
        )
        assert "revoker_id" not in captured["body"]

    def test_revoked_count_zero_is_not_an_error(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "revoked_count": 0,
                    "workflow_id": "wf-abc123",
                    "run_id": "run-uuid",
                },
            )

        client = _make_client(handler)
        out = client.bulk_revoke(
            workflow_id="wf-abc123",
            run_id="run-uuid",
            reason="dry-run test",
        )
        assert out.revoked_count == 0

    def test_401_raises_invalid_api_key(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "no"})

        client = _make_client(handler)
        with pytest.raises(V2Error) as exc:
            client.bulk_revoke(
                workflow_id="wf-abc123",
                run_id="run-uuid",
                reason="test",
            )
        assert exc.value.status_code == 401
        assert exc.value.code == "invalid_api_key"

    def test_500_raises_http_error(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "boom"})

        client = _make_client(handler)
        with pytest.raises(V2Error) as exc:
            client.bulk_revoke(
                workflow_id="wf-abc123",
                run_id="run-uuid",
                reason="test",
            )
        assert exc.value.status_code == 500
        assert exc.value.code == "http_error"
        assert exc.value.response_body == {"error": "boom"}

    def test_network_error_raises_network(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        client = _make_client(handler)
        with pytest.raises(V2Error) as exc:
            client.bulk_revoke(
                workflow_id="wf-abc123",
                run_id="run-uuid",
                reason="test",
            )
        assert exc.value.code == "network"
