"""Unit tests for canonical wire-type models."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from atlasent import (
    EvaluateRequest,
    EvaluateResponse,
    VerifyPermitRequest,
    VerifyPermitResponse,
    is_allowed,
)


class TestEvaluateRequest:
    def test_required_fields(self) -> None:
        req = EvaluateRequest(action_type="payment.transfer", actor_id="user:1")
        assert req.action_type == "payment.transfer"
        assert req.actor_id == "user:1"
        assert req.context == {}
        assert req.request_id is None

    def test_exclude_none_omits_optional_fields(self) -> None:
        req = EvaluateRequest(action_type="a", actor_id="u")
        dumped = req.model_dump(exclude_none=True)
        assert "action_type" in dumped
        assert "actor_id" in dumped
        # Optional fields with value None should be omitted from the wire.
        assert "request_id" not in dumped
        assert "shadow" not in dumped
        assert "explain" not in dumped
        assert "traceparent" not in dumped

    def test_rejects_unknown_fields(self) -> None:
        # The 0.x fields `action` / `agent` / `api_key` are gone. Forbid them.
        with pytest.raises(ValidationError):
            EvaluateRequest(action_type="a", actor_id="u", api_key="k")  # type: ignore[call-arg]
        with pytest.raises(ValidationError):
            EvaluateRequest(action="a", actor_id="u")  # type: ignore[call-arg]


class TestEvaluateResponse:
    def test_minimal_allow(self) -> None:
        res = EvaluateResponse.model_validate(
            {
                "decision": "allow",
                "request_id": "r-1",
                "mode": "live",
                "cache_hit": False,
                "evaluation_ms": 7,
                "permit_token": "pt_abc",
                "expires_at": "2026-01-01T00:00:00Z",
            }
        )
        assert res.decision == "allow"
        assert res.permit_token == "pt_abc"
        assert is_allowed(res.decision)

    def test_deny_shape(self) -> None:
        res = EvaluateResponse.model_validate(
            {
                "decision": "deny",
                "request_id": "r-2",
                "mode": "live",
                "cache_hit": False,
                "evaluation_ms": 3,
                "deny_code": "OVER_LIMIT",
                "deny_reason": "amount over limit",
            }
        )
        assert res.decision == "deny"
        assert res.deny_code == "OVER_LIMIT"
        assert res.permit_token is None
        assert not is_allowed(res.decision)

    def test_rejects_invalid_decision(self) -> None:
        with pytest.raises(ValidationError):
            EvaluateResponse.model_validate(
                {
                    "decision": "permit",  # not in enum
                    "request_id": "r",
                    "mode": "live",
                    "cache_hit": False,
                    "evaluation_ms": 0,
                }
            )

    def test_ignores_unknown_fields(self) -> None:
        # Forwards-compat: new server fields must not break old SDKs.
        res = EvaluateResponse.model_validate(
            {
                "decision": "allow",
                "request_id": "r",
                "mode": "live",
                "cache_hit": True,
                "evaluation_ms": 1,
                "permit_token": "pt",
                "some_future_field": {"a": 1},
            }
        )
        assert res.decision == "allow"


class TestVerifyPermit:
    def test_request_minimal(self) -> None:
        req = VerifyPermitRequest(permit_token="pt_x")
        assert req.permit_token == "pt_x"
        assert req.actor_id is None
        assert req.action_type is None

    def test_response_valid(self) -> None:
        res = VerifyPermitResponse.model_validate(
            {"valid": True, "outcome": "allow", "decision": "allow", "reason": "ok"}
        )
        assert res.valid is True
        assert res.outcome == "allow"
        assert res.decision == "allow"

    def test_response_invalid_with_error_code(self) -> None:
        res = VerifyPermitResponse.model_validate(
            {
                "valid": False,
                "outcome": "deny",
                "verify_error_code": "PERMIT_EXPIRED",
                "reason": "permit expired",
            }
        )
        assert res.valid is False
        assert res.outcome == "deny"
        assert res.verify_error_code == "PERMIT_EXPIRED"
        assert res.decision is None

    def test_rejects_invalid_outcome(self) -> None:
        with pytest.raises(ValidationError):
            VerifyPermitResponse.model_validate(
                {"valid": False, "outcome": "maybe", "reason": "?"}
            )
