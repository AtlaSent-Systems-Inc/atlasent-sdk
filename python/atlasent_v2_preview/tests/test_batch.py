"""Tests for the Pillar 2 batch builders.

Mirrors ``typescript/packages/v2-preview/test/batch.test.ts``
scenario-for-scenario so cross-language parity locks at CI time.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from atlasent_v2_preview import (
    BatchEvaluateAllowItem,
    BatchEvaluateDenyItem,
    BatchEvaluateItem,
    EvaluateBatchResponse,
    build_evaluate_batch_request,
    parse_evaluate_batch_response,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMAS_DIR = REPO_ROOT / "contract" / "schemas" / "v2"


def _load_schema(file: str) -> dict:
    return json.loads((SCHEMAS_DIR / file).read_text())


SAMPLE_ITEM = {
    "action": "modify_record",
    "agent": "agent-1",
    "context": {"id": "PT-001"},
}


# ── build_evaluate_batch_request ─────────────────────────────────────


class TestBuild:
    def test_returns_wire_shape_with_api_key_echoed(self):
        req = build_evaluate_batch_request([SAMPLE_ITEM], "ask_live_test")
        # Pydantic preserves the shape verbatim under model_dump().
        dumped = req.model_dump()
        assert dumped["api_key"] == "ask_live_test"
        assert dumped["requests"][0]["action"] == "modify_record"
        assert dumped["requests"][0]["agent"] == "agent-1"
        assert dumped["requests"][0]["context"] == {"id": "PT-001"}

    def test_preserves_payload_hash_and_target(self):
        item = {**SAMPLE_ITEM, "payload_hash": "a" * 64, "target": "prod-cluster"}
        req = build_evaluate_batch_request([item], "ask_live_test")
        first = req.requests[0]
        assert first.payload_hash == "a" * 64
        assert first.target == "prod-cluster"

    def test_forwards_forward_compat_extra_fields(self):
        item = {**SAMPLE_ITEM, "future_field_v3": "preserved"}
        req = build_evaluate_batch_request([item], "ask_live_test")
        # extra="allow" preserves unknown fields under model_extra.
        assert req.requests[0].model_extra == {"future_field_v3": "preserved"}

    def test_accepts_already_validated_item(self):
        # Round-trip: pydantic instance survives unchanged.
        item = BatchEvaluateItem(**SAMPLE_ITEM)
        req = build_evaluate_batch_request([item], "ask_live_test")
        assert req.requests[0] is item

    def test_rejects_empty_items(self):
        with pytest.raises(ValueError, match="at least 1 item"):
            build_evaluate_batch_request([], "ask_live_test")

    def test_rejects_more_than_1000_items(self):
        items = [SAMPLE_ITEM] * 1001
        with pytest.raises(ValueError, match="exceeds max 1000"):
            build_evaluate_batch_request(items, "ask_live_test")

    def test_accepts_exactly_1000_items_boundary(self):
        items = [SAMPLE_ITEM] * 1000
        req = build_evaluate_batch_request(items, "ask_live_test")
        assert len(req.requests) == 1000

    def test_rejects_empty_api_key(self):
        with pytest.raises(ValueError, match="api_key"):
            build_evaluate_batch_request([SAMPLE_ITEM], "")

    def test_rejects_non_string_api_key(self):
        with pytest.raises(ValueError, match="api_key"):
            build_evaluate_batch_request([SAMPLE_ITEM], None)  # type: ignore[arg-type]

    def test_rejects_items_with_empty_action(self):
        with pytest.raises(ValueError, match="items\\[0\\]"):
            build_evaluate_batch_request(
                [{**SAMPLE_ITEM, "action": ""}], "ask_live_test"
            )

    def test_rejects_items_with_empty_agent(self):
        with pytest.raises(ValueError, match="items\\[0\\]"):
            build_evaluate_batch_request(
                [{**SAMPLE_ITEM, "agent": ""}], "ask_live_test"
            )

    def test_rejects_items_with_malformed_payload_hash(self):
        with pytest.raises(ValueError, match="items\\[0\\]"):
            build_evaluate_batch_request(
                [{**SAMPLE_ITEM, "payload_hash": "not-hex"}], "ask_live_test"
            )

    def test_rejects_payload_hash_uppercase_hex(self):
        with pytest.raises(ValueError, match="items\\[0\\]"):
            build_evaluate_batch_request(
                [{**SAMPLE_ITEM, "payload_hash": "A" * 64}], "ask_live_test"
            )

    def test_defaults_context_to_empty_dict(self):
        item = {"action": "x", "agent": "y"}
        req = build_evaluate_batch_request([item], "ask_live_test")
        assert req.requests[0].context == {}


# ── parse_evaluate_batch_response ────────────────────────────────────


SAMPLE_BODY = {
    "batch_id": "550e8400-e29b-41d4-a716-446655440000",
    "items": [
        {
            "index": 0,
            "permitted": True,
            "decision_id": "dec_alpha",
            "reason": "ok",
            "audit_hash": "a" * 64,
            "timestamp": "2026-04-25T00:00:00Z",
            "batch_id": "550e8400-e29b-41d4-a716-446655440000",
        },
        {
            "index": 1,
            "permitted": False,
            "decision_id": "dec_beta",
            "reason": "missing change_reason",
            "audit_hash": "b" * 64,
            "timestamp": "2026-04-25T00:00:01Z",
            "batch_id": "550e8400-e29b-41d4-a716-446655440000",
        },
    ],
}


class TestParse:
    def test_parses_well_formed_response(self):
        parsed = parse_evaluate_batch_response(SAMPLE_BODY)
        assert parsed.batch_id == SAMPLE_BODY["batch_id"]
        assert len(parsed.items) == 2

    def test_narrows_allow_vs_deny_via_permitted(self):
        parsed = parse_evaluate_batch_response(SAMPLE_BODY)

        allow = parsed.items[0]
        assert isinstance(allow, BatchEvaluateAllowItem)
        assert allow.permitted is True
        assert allow.decision_id == "dec_alpha"

        deny = parsed.items[1]
        assert isinstance(deny, BatchEvaluateDenyItem)
        assert deny.permitted is False
        assert deny.reason == "missing change_reason"

    def test_preserves_pillar9_proof_fields(self):
        body = {
            "batch_id": "b1",
            "items": [
                {
                    "index": 0,
                    "permitted": True,
                    "decision_id": "d1",
                    "reason": "",
                    "audit_hash": "a" * 64,
                    "timestamp": "t",
                    "batch_id": "b1",
                    "proof_id": "550e8400-e29b-41d4-a716-446655440000",
                    "proof_status": "pending",
                },
            ],
        }
        parsed = parse_evaluate_batch_response(body)
        item = parsed.items[0]
        assert item.proof_id == "550e8400-e29b-41d4-a716-446655440000"
        assert item.proof_status == "pending"

    def test_preserves_forward_compat_extra_fields_on_items(self):
        body = {
            "batch_id": "b1",
            "items": [
                {
                    **SAMPLE_BODY["items"][0],
                    "future_item_field_v3": 42,
                },
            ],
        }
        parsed = parse_evaluate_batch_response(body)
        assert parsed.items[0].model_extra == {"future_item_field_v3": 42}

    def test_rejects_non_object_body(self):
        with pytest.raises(ValueError, match="JSON object"):
            parse_evaluate_batch_response([])
        with pytest.raises(ValueError, match="JSON object"):
            parse_evaluate_batch_response(None)
        with pytest.raises(ValueError, match="JSON object"):
            parse_evaluate_batch_response("string")

    def test_rejects_missing_batch_id(self):
        with pytest.raises(ValueError, match="invalid response body"):
            parse_evaluate_batch_response({"items": []})

    def test_rejects_empty_string_batch_id(self):
        with pytest.raises(ValueError, match="invalid response body"):
            parse_evaluate_batch_response({"batch_id": "", "items": []})

    def test_rejects_items_not_array(self):
        with pytest.raises(ValueError, match="invalid response body"):
            parse_evaluate_batch_response({"batch_id": "b1", "items": "nope"})

    def test_rejects_item_with_non_boolean_permitted(self):
        with pytest.raises(ValueError, match="invalid response body"):
            parse_evaluate_batch_response(
                {
                    "batch_id": "b1",
                    "items": [{**SAMPLE_BODY["items"][0], "permitted": "true"}],
                }
            )

    def test_rejects_item_with_non_string_decision_id(self):
        with pytest.raises(ValueError, match="invalid response body"):
            parse_evaluate_batch_response(
                {
                    "batch_id": "b1",
                    "items": [{**SAMPLE_BODY["items"][0], "decision_id": 42}],
                }
            )

    def test_accepts_empty_items_array(self):
        parsed = parse_evaluate_batch_response({"batch_id": "b1", "items": []})
        assert parsed.items == []


# ── Schema parity ────────────────────────────────────────────────────


class TestSchemaParity:
    def test_request_required_fields_match_schema(self):
        schema = _load_schema("evaluate-batch-request.schema.json")
        required = set(schema["required"])
        from atlasent_v2_preview import EvaluateBatchRequest

        fields = set(EvaluateBatchRequest.model_fields.keys())
        for field in required:
            assert field in fields, (
                f"EvaluateBatchRequest missing schema-required '{field}'"
            )

    def test_item_required_fields_match_schema_defs(self):
        schema = _load_schema("evaluate-batch-request.schema.json")
        item_schema = schema["$defs"]["BatchEvaluateItem"]
        required = set(item_schema["required"])
        fields = set(BatchEvaluateItem.model_fields.keys())
        for field in required:
            assert field in fields, (
                f"BatchEvaluateItem missing schema-required '{field}'"
            )

    def test_response_required_fields_match_schema(self):
        schema = _load_schema("evaluate-batch-response.schema.json")
        required = set(schema["required"])
        assert required == {"batch_id", "items"}
        fields = set(EvaluateBatchResponse.model_fields.keys())
        for field in required:
            assert field in fields
