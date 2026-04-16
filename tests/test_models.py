"""Tests for Pydantic models."""

from atlasent.models import (
    EvaluateRequest,
    EvaluateResult,
    GateResult,
    VerifyRequest,
    VerifyResult,
)


class TestEvaluateRequest:
    def test_serializes_with_aliases(self):
        req = EvaluateRequest(
            action_type="read_data",
            actor_id="agent-1",
            context={"study": "S001"},
            api_key="key",
        )
        data = req.model_dump(by_alias=True)
        assert data["action"] == "read_data"
        assert data["agent"] == "agent-1"
        assert data["context"] == {"study": "S001"}
        assert data["api_key"] == "key"

    def test_default_context(self):
        req = EvaluateRequest(action_type="x", actor_id="y", api_key="k")
        assert req.context == {}


class TestEvaluateResult:
    def test_from_api_response(self):
        result = EvaluateResult.model_validate(
            {
                "permitted": True,
                "decision_id": "dec_100",
                "reason": "OK",
                "audit_hash": "hash_abc",
                "timestamp": "2025-01-15T12:00:00Z",
            }
        )
        assert result.decision is True
        assert result.permit_token == "dec_100"
        assert result.reason == "OK"
        assert result.audit_hash == "hash_abc"
        assert result.timestamp == "2025-01-15T12:00:00Z"


class TestVerifyRequest:
    def test_serializes_with_aliases(self):
        req = VerifyRequest(
            permit_token="dec_100",
            action_type="read_data",
            actor_id="agent-1",
            api_key="key",
        )
        data = req.model_dump(by_alias=True)
        assert data["decision_id"] == "dec_100"
        assert data["action"] == "read_data"
        assert data["agent"] == "agent-1"


class TestVerifyResult:
    def test_from_api_response(self):
        result = VerifyResult.model_validate(
            {
                "verified": True,
                "permit_hash": "permit_xyz",
                "timestamp": "2025-01-15T12:05:00Z",
            }
        )
        assert result.valid is True
        assert result.permit_hash == "permit_xyz"
        assert result.timestamp == "2025-01-15T12:05:00Z"

    def test_outcome_default(self):
        result = VerifyResult.model_validate({"verified": False})
        assert result.valid is False
        assert result.outcome == ""


class TestGateResult:
    def test_combines_eval_and_verify(self):
        ev = EvaluateResult(
            decision=True,
            permit_token="dec_1",
            reason="OK",
            audit_hash="h1",
            timestamp="t1",
        )
        vr = VerifyResult(valid=True, permit_hash="ph1", timestamp="t2")
        gate = GateResult(evaluation=ev, verification=vr)
        assert gate.evaluation.permit_token == "dec_1"
        assert gate.verification.valid is True
