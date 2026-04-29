"""Contract vector runner for the Python v2 SDK.

Loads the shared v2 test vectors from ``contract/vectors/v2/`` and
asserts that the Python SDK round-trips each one: correct wire_request
sent to the server, correct model populated from wire_response.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from atlasent_v2_alpha import AtlaSentV2Client
from atlasent_v2_alpha.types import (
    BatchEvaluateItem,
    BulkRevokeResponse,
    ConsumeResponse,
    EvaluateBatchResponse,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
V2_VECTORS = REPO_ROOT / "contract" / "vectors" / "v2"
API_KEY = "ask_live_test_key"

pytestmark = pytest.mark.skipif(
    not V2_VECTORS.exists(),
    reason="contract/vectors/v2/ not available in this checkout",
)


def _load(name: str) -> list[dict[str, Any]]:
    return json.loads((V2_VECTORS / name).read_text())["vectors"]


def _client(handler: Any) -> AtlaSentV2Client:
    transport = httpx.MockTransport(handler)
    inner = httpx.Client(transport=transport, base_url="https://api.atlasent.io")
    return AtlaSentV2Client(
        api_key=API_KEY, base_url="https://api.atlasent.io", client=inner
    )


# ── evaluate-batch.json ──────────────────────────────────────────────────


_BATCH_VECTORS = _load("evaluate-batch.json")


@pytest.mark.parametrize("v", _BATCH_VECTORS, ids=lambda v: v["name"])
def test_evaluate_batch_wire_request(v: dict[str, Any]) -> None:
    captured: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(req.content.decode())
        return httpx.Response(200, json=v["wire_response"])

    requests = [
        BatchEvaluateItem(
            action=r["action"],
            agent=r["agent"],
            context=r.get("context", {}),
            **({"payload_hash": r["payload_hash"]} if r.get("payload_hash") else {}),
        )
        for r in v["sdk_input"]["requests"]
    ]
    _client(handler).evaluate_batch(requests)
    assert captured["body"] == v["wire_request"]


@pytest.mark.parametrize("v", _BATCH_VECTORS, ids=lambda v: v["name"])
def test_evaluate_batch_response_parsed(v: dict[str, Any]) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=v["wire_response"])

    requests = [
        BatchEvaluateItem(
            action=r["action"],
            agent=r["agent"],
            context=r.get("context", {}),
        )
        for r in v["sdk_input"]["requests"]
    ]
    result = _client(handler).evaluate_batch(requests)
    expected = v["sdk_output"]
    assert isinstance(result, EvaluateBatchResponse)
    assert result.batch_id == expected["batch_id"]
    assert len(result.items) == len(expected["items"])
    for actual_item, exp_item in zip(result.items, expected["items"]):
        assert actual_item.permitted == exp_item["permitted"]
        assert actual_item.decision_id == exp_item["decision_id"]
        assert actual_item.audit_hash == exp_item["audit_hash"]


# ── consume.json ─────────────────────────────────────────────────────────


_CONSUME_VECTORS = _load("consume.json")


@pytest.mark.parametrize("v", _CONSUME_VECTORS, ids=lambda v: v["name"])
def test_consume_wire_request(v: dict[str, Any]) -> None:
    captured: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(req.content.decode())
        return httpx.Response(200, json=v["wire_response"])

    si = v["sdk_input"]
    _client(handler).consume(
        permit_id=si["permitId"],
        payload_hash=si["payloadHash"],
        execution_status=si["executionStatus"],
        **(
            {}
            if si.get("executionHash") is None
            else {"execution_hash": si["executionHash"]}
        ),
    )
    assert captured["body"] == v["wire_request"]


@pytest.mark.parametrize("v", _CONSUME_VECTORS, ids=lambda v: v["name"])
def test_consume_response_parsed(v: dict[str, Any]) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=v["wire_response"])

    si = v["sdk_input"]
    result = _client(handler).consume(
        permit_id=si["permitId"],
        payload_hash=si["payloadHash"],
        execution_status=si["executionStatus"],
    )
    expected = v["sdk_output"]
    assert isinstance(result, ConsumeResponse)
    assert result.proof_id == expected["proof_id"]
    assert result.execution_status == expected["execution_status"]
    assert result.audit_hash == expected["audit_hash"]


# ── bulk-revoke.json ─────────────────────────────────────────────────────


_REVOKE_VECTORS = _load("bulk-revoke.json")


@pytest.mark.parametrize("v", _REVOKE_VECTORS, ids=lambda v: v["name"])
def test_bulk_revoke_wire_request(v: dict[str, Any]) -> None:
    captured: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(req.content.decode())
        return httpx.Response(200, json=v["wire_response"])

    si = v["sdk_input"]
    _client(handler).bulk_revoke(
        workflow_id=si["workflowId"],
        run_id=si["runId"],
        reason=si["reason"],
        revoker_id=si.get("revokerId"),
    )
    assert captured["body"] == v["wire_request"]


@pytest.mark.parametrize("v", _REVOKE_VECTORS, ids=lambda v: v["name"])
def test_bulk_revoke_response_parsed(v: dict[str, Any]) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=v["wire_response"])

    si = v["sdk_input"]
    result = _client(handler).bulk_revoke(
        workflow_id=si["workflowId"],
        run_id=si["runId"],
        reason=si["reason"],
    )
    expected = v["sdk_output"]
    assert isinstance(result, BulkRevokeResponse)
    assert result.revoked_count == expected["revoked_count"]
    assert result.workflow_id == expected["workflow_id"]
    assert result.run_id == expected["run_id"]
