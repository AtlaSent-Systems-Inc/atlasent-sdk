"""Tests for Pydantic models.

Covers BOTH the canonical handler.ts wire shape and the legacy
{action, agent, api_key} / {permitted, decision_id} shape that older
SDK callers and older atlasent-api deployments may still use. The
canonical shape is the source of truth; legacy shapes are accepted
with a DeprecationWarning on input and transparently translated on
response.
"""

import warnings

from atlasent.models import (
    EvaluateRequest,
    EvaluateResult,
    GateResult,
    VerifyRequest,
    VerifyResult,
)


class TestEvaluateRequest:
    def test_canonical_serializes_to_canonical_wire(self):
        req = EvaluateRequest(
            action_type="read_data",
            actor_id="agent-1",
            context={"study": "S001"},
        )
        data = req.model_dump(by_alias=True)
        assert data["action_type"] == "read_data"
        assert data["actor_id"] == "agent-1"
        assert data["context"] == {"study": "S001"}
        # api_key MUST NOT appear on the wire — server reads it from the
        # Authorization header.
        assert "api_key" not in data

    def test_legacy_input_translates_with_deprecation(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            req = EvaluateRequest(action="read_data", agent="agent-1", api_key="k")
        assert req.action_type == "read_data"
        assert req.actor_id == "agent-1"
        # Wire is still canonical.
        data = req.model_dump(by_alias=True)
        assert data["action_type"] == "read_data"
        assert data["actor_id"] == "agent-1"
        assert "action" not in data
        assert "agent" not in data
        assert "api_key" not in data
        kinds = [str(w.message) for w in caught if issubclass(w.category, DeprecationWarning)]
        assert any("action= -> action_type=" in m for m in kinds)
        assert any("agent= -> actor_id=" in m for m in kinds)
        assert any("api_key=" in m for m in kinds)

    def test_default_context(self):
        req = EvaluateRequest(action_type="x", actor_id="y")
        assert req.context == {}


class TestEvaluateResult:
    def test_from_legacy_api_response(self):
        # Old-shaped server response (pre-handler.ts).
        result = EvaluateResult.model_validate(
            {
                "permitted": True,
                "decision_id": "dec_100",
                "reason": "OK",
                "audit_hash": "hash_abc",
                "timestamp": "2025-01-15T12:00:00Z",
            }
        )
        # Canonical attributes populated from legacy.
        assert result.decision == "allow"
        assert result.permit_token == "dec_100"
        # Legacy attributes also populated for backward-compat.
        assert result.permitted is True
        assert result.decision_id == "dec_100"
        assert result.reason == "OK"
        assert result.audit_hash == "hash_abc"
        assert result.timestamp == "2025-01-15T12:00:00Z"

    def test_from_canonical_api_response(self):
        result = EvaluateResult.model_validate(
            {
                "decision": "allow",
                "permit_token": "pt_xyz",
                "request_id": "req_1",
                "expires_at": "2026-01-01T01:00:00Z",
            }
        )
        assert result.decision == "allow"
        assert result.permit_token == "pt_xyz"
        assert result.request_id == "req_1"
        assert result.expires_at == "2026-01-01T01:00:00Z"
        # Legacy attrs mirrored.
        assert result.permitted is True
        assert result.decision_id == "pt_xyz"

    def test_canonical_deny_with_denial(self):
        result = EvaluateResult.model_validate(
            {
                "decision": "deny",
                "denial": {"reason": "no quorum", "code": "MISSING_APPROVAL"},
            }
        )
        assert result.decision == "deny"
        assert result.permitted is False
        assert result.denial == {"reason": "no quorum", "code": "MISSING_APPROVAL"}
        assert result.reason == "no quorum"  # legacy mirror


class TestVerifyRequest:
    def test_canonical_serializes_to_canonical_wire(self):
        req = VerifyRequest(
            permit_token="pt_100",
            action_type="read_data",
            actor_id="agent-1",
        )
        data = req.model_dump(by_alias=True)
        assert data["permit_token"] == "pt_100"
        assert data["action_type"] == "read_data"
        assert data["actor_id"] == "agent-1"
        assert "context" not in data
        assert "api_key" not in data

    def test_legacy_input_translates_with_deprecation(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            req = VerifyRequest(
                decision_id="pt_100",
                action="read_data",
                agent="agent-1",
                api_key="k",
            )
        assert req.permit_token == "pt_100"
        assert req.action_type == "read_data"
        assert req.actor_id == "agent-1"
        data = req.model_dump(by_alias=True)
        assert data["permit_token"] == "pt_100"
        assert "decision_id" not in data
        assert "api_key" not in data
        kinds = [str(w.message) for w in caught if issubclass(w.category, DeprecationWarning)]
        assert any("decision_id= -> permit_token=" in m for m in kinds)


class TestVerifyResult:
    def test_from_legacy_api_response(self):
        result = VerifyResult.model_validate(
            {
                "verified": True,
                "permit_hash": "permit_xyz",
                "timestamp": "2025-01-15T12:05:00Z",
            }
        )
        assert result.valid is True
        assert result.verified is True
        assert result.permit_hash == "permit_xyz"
        assert result.timestamp == "2025-01-15T12:05:00Z"

    def test_from_canonical_api_response(self):
        result = VerifyResult.model_validate({"valid": True, "outcome": "allow"})
        assert result.valid is True
        assert result.outcome == "allow"
        assert result.verified is True  # legacy mirror

    def test_canonical_deny_with_error_code(self):
        result = VerifyResult.model_validate(
            {
                "valid": False,
                "outcome": "deny",
                "verify_error_code": "PERMIT_EXPIRED",
                "reason": "Permit expired at 2026-01-01T00:15:00Z",
            }
        )
        assert result.valid is False
        assert result.outcome == "deny"
        assert result.verify_error_code == "PERMIT_EXPIRED"
        assert result.reason.startswith("Permit expired")
        assert result.verified is False  # legacy mirror

    def test_outcome_default(self):
        result = VerifyResult.model_validate({"verified": False})
        assert result.valid is False
        assert result.outcome == ""


class TestGateResult:
    def test_combines_eval_and_verify(self):
        ev = EvaluateResult(decision="allow", permit_token="dec_1")
        vr = VerifyResult(valid=True)
        gate = GateResult(evaluation=ev, verification=vr)
        assert gate.evaluation.permit_token == "dec_1"
        assert gate.evaluation.decision == "allow"
        assert gate.verification.valid is True


class TestNoExtraneousWarnings:
    def test_canonical_construction_emits_no_deprecation(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            EvaluateRequest(action_type="x", actor_id="y", context={"k": "v"})
            VerifyRequest(permit_token="t", action_type="x", actor_id="y")
        deprecations = [w for w in caught if issubclass(w.category, DeprecationWarning)]
        assert deprecations == []
