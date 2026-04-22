"""Unit tests for exception types."""

from __future__ import annotations

from atlasent import EvaluateResponse, VerifyPermitResponse
from atlasent.exceptions import (
    AtlaSentError,
    AuthorizationDeniedError,
    AuthorizationUnavailableError,
    PermitVerificationError,
    RateLimitError,
)


def _deny_response() -> EvaluateResponse:
    return EvaluateResponse.model_validate(
        {
            "decision": "deny",
            "request_id": "r-1",
            "mode": "live",
            "cache_hit": False,
            "evaluation_ms": 4,
            "deny_code": "OVER_LIMIT",
            "deny_reason": "too much",
        }
    )


def _verify_denied() -> VerifyPermitResponse:
    return VerifyPermitResponse.model_validate(
        {
            "valid": False,
            "outcome": "deny",
            "verify_error_code": "PERMIT_EXPIRED",
            "reason": "expired",
        }
    )


def test_authorization_denied_accessors() -> None:
    err = AuthorizationDeniedError(_deny_response())
    assert isinstance(err, AtlaSentError)
    assert err.decision == "deny"
    assert err.deny_code == "OVER_LIMIT"
    assert err.deny_reason == "too much"
    assert err.request_id == "r-1"
    assert "OVER_LIMIT" in str(err)
    assert "too much" in str(err)


def test_permit_verification_error_accessors() -> None:
    err = PermitVerificationError("verify denied", response=_verify_denied())
    assert err.verify_error_code == "PERMIT_EXPIRED"
    assert err.response is not None
    assert err.response.reason == "expired"


def test_permit_verification_error_without_response() -> None:
    err = PermitVerificationError("no permit_token issued")
    assert err.response is None
    assert err.verify_error_code is None


def test_authorization_unavailable_sets_code() -> None:
    err = AuthorizationUnavailableError("timeout", status_code=504)
    assert err.code == "unavailable"
    assert err.status_code == 504


def test_rate_limit_error_has_retry_after() -> None:
    err = RateLimitError(retry_after=30)
    assert err.retry_after == 30
    assert err.status_code == 429
    assert err.code == "rate_limited"
