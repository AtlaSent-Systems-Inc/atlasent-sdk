"""Contract vector runner for the Python SDK.

Loads the shared test vectors from ``contract/vectors/`` and asserts
that the Python SDK round-trips each one.

The runner uses httpx mocking rather than a live server — the contract
is about wire-format parity, not transport.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from atlasent._version import __version__
from atlasent.async_client import AsyncAtlaSentClient
from atlasent.client import AtlaSentClient
from atlasent.exceptions import (
    AtlaSentDenied,
    AtlaSentError,
    RateLimitError,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS = REPO_ROOT / "contract" / "vectors"
API_KEY = "ask_live_test_key"

pytestmark = pytest.mark.skipif(
    not VECTORS.exists(),
    reason="contract/vectors/ not available in this checkout",
)


def _load(name: str) -> dict[str, Any]:
    return json.loads((VECTORS / name).read_text())


def _vectors(name: str) -> list[dict[str, Any]]:
    return _load(name)["vectors"]


def _mock_json_response(mocker, body: Any, status_code: int = 200, headers=None):
    resp = mocker.Mock(spec=httpx.Response)
    resp.status_code = status_code
    # httpx.Headers is case-insensitive; match the real client's behavior.
    resp.headers = httpx.Headers(headers or {})
    resp.text = body if isinstance(body, str) else json.dumps(body)
    if isinstance(body, (dict, list)):
        resp.json.return_value = body
    else:
        resp.json.side_effect = ValueError("not json")
    return resp


# ── evaluate.json ─────────────────────────────────────────────────────


class TestEvaluateVectors:
    @pytest.mark.parametrize(
        "vector",
        _vectors("evaluate.json"),
        ids=lambda v: v["name"],
    )
    def test_evaluate_vector(self, vector, mocker):
        client = AtlaSentClient(api_key=API_KEY, max_retries=0)
        mock_post = mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_json_response(mocker, vector["wire_response"]),
        )

        sdk_input = vector["sdk_input"]
        agent = sdk_input["agent"]
        action = sdk_input["action"]
        context = sdk_input.get("context")

        sdk_error = vector.get("sdk_error")
        if sdk_error is not None:
            with pytest.raises(AtlaSentError) as exc_info:
                client.evaluate(action, agent, context)
            assert exc_info.value.code == sdk_error["kind"]
            if "message_contains" in sdk_error:
                assert sdk_error["message_contains"] in exc_info.value.message
        else:
            expected_output = vector["sdk_output"]
            if expected_output["decision"] == "ALLOW":
                result = client.evaluate(action, agent, context)
                # legacy attr (canonical: result.decision)
                assert result.permitted is True
                assert result.permit_token == expected_output["permit_id"]
                assert result.reason == expected_output["reason"]
                assert result.audit_hash == expected_output["audit_hash"]
                assert result.timestamp == expected_output["timestamp"]
            else:
                with pytest.raises(AtlaSentDenied) as exc_info:
                    client.evaluate(action, agent, context)
                assert exc_info.value.permit_token == expected_output["permit_id"]
                assert exc_info.value.reason == expected_output["reason"]

        # Wire-format assertion: body sent MUST match vector.wire_request.
        payload = mock_post.call_args[1]["json"]
        assert payload == vector["wire_request"], (
            f"{vector['name']} wire_request mismatch:\n"
            f"  expected: {vector['wire_request']}\n"
            f"  actual:   {payload}"
        )


# ── verify.json ───────────────────────────────────────────────────────


class TestVerifyVectors:
    @pytest.mark.parametrize(
        "vector",
        _vectors("verify.json"),
        ids=lambda v: v["name"],
    )
    def test_verify_vector(self, vector, mocker):
        client = AtlaSentClient(api_key=API_KEY, max_retries=0)
        mock_post = mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_json_response(mocker, vector["wire_response"]),
        )

        sdk_input = vector["sdk_input"]
        permit_id = sdk_input["permit_id"]
        action = sdk_input.get("action", "")
        agent = sdk_input.get("agent", "")
        context = sdk_input.get("context", {})

        sdk_error = vector.get("sdk_error")
        if sdk_error is not None:
            with pytest.raises(AtlaSentError) as exc_info:
                client.verify(permit_id, action, agent, context)
            assert exc_info.value.code == sdk_error["kind"]
            if "message_contains" in sdk_error:
                assert sdk_error["message_contains"] in exc_info.value.message
        else:
            expected_output = vector["sdk_output"]
            result = client.verify(permit_id, action, agent, context)
            assert result.valid is expected_output["verified"]
            assert result.outcome == expected_output["outcome"]
            assert result.permit_hash == expected_output["permit_hash"]
            assert result.timestamp == expected_output["timestamp"]

        payload = mock_post.call_args[1]["json"]
        assert payload == vector["wire_request"]


# ── errors.json ───────────────────────────────────────────────────────


class TestErrorVectors:
    @pytest.mark.parametrize(
        "vector",
        _vectors("errors.json"),
        ids=lambda v: v["name"],
    )
    def test_error_vector(self, vector, mocker):
        client = AtlaSentClient(api_key=API_KEY, max_retries=0)
        sdk_error = vector["sdk_error"]

        if vector.get("transport") == "timeout":
            mocker.patch.object(
                client._client, "post", side_effect=httpx.TimeoutException("timeout")
            )
            with pytest.raises(AtlaSentError) as exc_info:
                client.evaluate("a", "b")
            assert exc_info.value.code == sdk_error["kind"]
            return

        if vector.get("transport") == "connection_refused":
            mocker.patch.object(
                client._client, "post", side_effect=httpx.ConnectError("refused")
            )
            with pytest.raises(AtlaSentError) as exc_info:
                client.evaluate("a", "b")
            assert exc_info.value.code == sdk_error["kind"]
            return

        # HTTP error path
        mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_json_response(
                mocker,
                vector["response_body"],
                status_code=vector["http_status"],
                headers=vector.get("response_headers") or {},
            ),
        )

        if sdk_error["kind"] == "rate_limited":
            with pytest.raises(RateLimitError) as exc_info:
                client.evaluate("a", "b")
            expected = sdk_error.get("retry_after_seconds")
            if expected is not None:
                assert exc_info.value.retry_after == float(expected)
            return

        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("a", "b")
        assert exc_info.value.code == sdk_error["kind"]
        assert exc_info.value.status_code == sdk_error["status"]
        if "message_contains" in sdk_error:
            assert sdk_error["message_contains"] in exc_info.value.message


# ── async parity smoke test ───────────────────────────────────────────


class TestAsyncEvaluateHappyVector:
    """One async round-trip to confirm the async client sends the same
    wire body as the sync client for the same vector. Full async
    parametrization lives behind the same feature gates so we keep it
    light here."""

    @pytest.mark.asyncio
    async def test_evaluate_allow_minimal(self, mocker):
        vector = next(
            v
            for v in _vectors("evaluate.json")
            if v["name"] == "evaluate_allow_minimal"
        )
        client = AsyncAtlaSentClient(api_key=API_KEY, max_retries=0)
        mock_post = mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_json_response(mocker, vector["wire_response"]),
        )
        result = await client.evaluate(
            vector["sdk_input"]["action"], vector["sdk_input"]["agent"]
        )
        assert result.permitted is True  # legacy attr (canonical: result.decision)
        payload = mock_post.call_args[1]["json"]
        assert payload == vector["wire_request"]


def test_sdk_version_pointer():
    """Keep a breadcrumb so `grep __version__` in this file leads to
    the matrix in _FEATURE_GATED above."""
    assert __version__, "SDK version must be set"
