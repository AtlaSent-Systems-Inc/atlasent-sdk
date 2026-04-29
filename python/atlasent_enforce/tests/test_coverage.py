"""Coverage-gap tests for atlasent_enforce.

Covers implementation branches that the SIM-01..SIM-10 suite doesn't reach,
without duplicating scenario logic.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock

import pytest

from atlasent_enforce import Enforce, RunRequest
from atlasent_enforce.errors import classify_client_error
from atlasent_enforce.types import Bindings, EvaluateResponse, VerifiedPermit

_BINDINGS = Bindings(org_id="org_test", actor_id="actor_test", action_type="deploy")
_REQUEST: dict[str, Any] = {"env": "production"}


# ── classify_client_error ─────────────────────────────────────────────────────

class _HttpStatusError(Exception):
    def __init__(self, http_status: int) -> None:
        self.http_status = http_status


class _PlainError(Exception):
    pass


def test_classify_4xx_returns_client_error_variant() -> None:
    # Line 21: 4xx → replace "_unavailable" with "_client_error"
    err = _HttpStatusError(400)
    assert classify_client_error(err, "evaluate_unavailable") == "evaluate_client_error"


def test_classify_5xx_returns_fallback() -> None:
    # Line 22: 5xx (or non-4xx int) → plain fallback
    err = _HttpStatusError(503)
    assert classify_client_error(err, "verify_unavailable") == "verify_unavailable"


def test_classify_no_http_status_returns_fallback() -> None:
    # Line 24: no reason_code, no http_status → plain fallback
    assert classify_client_error(_PlainError("boom"), "evaluate_unavailable") == "evaluate_unavailable"


# ── evaluate() throws ────────────────────────────────────────────────────────

class _ThrowingClient:
    """Mock client whose evaluate() raises immediately."""

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    async def evaluate(self, _request: dict[str, Any]) -> EvaluateResponse:
        raise self._exc

    async def verify_permit(self, _token: str) -> VerifiedPermit:
        raise AssertionError("verify_permit called unexpectedly")


@pytest.mark.asyncio
async def test_evaluate_exception_returns_deny() -> None:
    # Lines 46-47: evaluate() raises → deny with fallback reason_code
    client = _ThrowingClient(_PlainError("network error"))
    enforce = Enforce(client=client, bindings=_BINDINGS, fail_closed=True)
    result = await enforce.run(RunRequest(request=_REQUEST, execute=AsyncMock()))
    assert result.decision == "deny"
    assert result.reason_code == "evaluate_unavailable"


@pytest.mark.asyncio
async def test_evaluate_exception_with_4xx_maps_client_error() -> None:
    # Lines 46-47 + line 21: evaluate() raises a 4xx-tagged error
    client = _ThrowingClient(_HttpStatusError(400))
    enforce = Enforce(client=client, bindings=_BINDINGS, fail_closed=True)
    result = await enforce.run(RunRequest(request=_REQUEST, execute=AsyncMock()))
    assert result.decision == "deny"
    assert result.reason_code == "evaluate_client_error"


# ── Binding mismatch after successful verify ──────────────────────────────────

class _MismatchVerifyClient:
    """evaluate() allows; verify_permit() returns a permit with wrong actor_id."""

    async def evaluate(self, _request: dict[str, Any]) -> EvaluateResponse:
        return EvaluateResponse(
            decision="allow",
            permit_token="pt_mismatch_aabbcc",
            permit_expires_at="2099-01-01T00:00:00Z",
            reason_code=None,
        )

    async def verify_permit(self, _token: str) -> VerifiedPermit:
        return VerifiedPermit(
            token=_token,
            org_id="org_test",
            actor_id="different_actor",   # ← mismatch
            action_type="deploy",
            expires_at="2099-01-01T00:00:00Z",
        )


@pytest.mark.asyncio
async def test_binding_mismatch_after_successful_verify_denies() -> None:
    # Line 78: verify succeeds but returned permit has wrong actor_id
    client = _MismatchVerifyClient()
    execute = AsyncMock(return_value="unreachable")
    enforce = Enforce(client=client, bindings=_BINDINGS, fail_closed=True)
    result = await enforce.run(RunRequest(request=_REQUEST, execute=execute))
    assert result.decision == "deny"
    assert result.reason_code == "binding_mismatch"
    execute.assert_not_called()


# ── Verify completes within latency budget ────────────────────────────────────

class _FastVerifyClient:
    """evaluate() allows; verify_permit() returns quickly."""

    async def evaluate(self, _request: dict[str, Any]) -> EvaluateResponse:
        return EvaluateResponse(
            decision="allow",
            permit_token="pt_fast_aabbcc",
            permit_expires_at="2099-01-01T00:00:00Z",
            reason_code=None,
        )

    async def verify_permit(self, _token: str) -> VerifiedPermit:
        # completes immediately, well within any budget
        return VerifiedPermit(
            token=_token,
            org_id="org_test",
            actor_id="actor_test",
            action_type="deploy",
            expires_at="2099-01-01T00:00:00Z",
        )


@pytest.mark.asyncio
async def test_verify_completes_within_budget_allows() -> None:
    # Line 98: verify_task in done → returns result (fast verify, tight budget)
    client = _FastVerifyClient()
    execute = AsyncMock(return_value="result")
    enforce = Enforce(
        client=client,
        bindings=_BINDINGS,
        fail_closed=True,
        latency_budget_ms=5_000,  # generous budget; fast verify always wins
    )
    result = await enforce.run(RunRequest(request=_REQUEST, execute=execute))
    assert result.decision == "allow"
    execute.assert_called_once()


# ── Warn mode without callback ────────────────────────────────────────────────

class _SlowVerifyClient:
    """evaluate() allows; verify_permit() takes longer than the latency budget."""

    async def evaluate(self, _request: dict[str, Any]) -> EvaluateResponse:
        return EvaluateResponse(
            decision="allow",
            permit_token="pt_slow_aabbcc",
            permit_expires_at="2099-01-01T00:00:00Z",
            reason_code=None,
        )

    async def verify_permit(self, _token: str) -> VerifiedPermit:
        await asyncio.sleep(0.3)
        return VerifiedPermit(
            token=_token,
            org_id="org_test",
            actor_id="actor_test",
            action_type="deploy",
            expires_at="2099-01-01T00:00:00Z",
        )


@pytest.mark.asyncio
async def test_warn_mode_without_callback_still_allows() -> None:
    # Line 102 False branch (on_latency_breach is None) → line 104 return
    client = _SlowVerifyClient()
    execute = AsyncMock(return_value="done")
    enforce = Enforce(
        client=client,
        bindings=_BINDINGS,
        fail_closed=True,
        latency_budget_ms=50,           # shorter than verify's 300ms sleep
        latency_breach_mode="warn",
        on_latency_breach=None,         # ← no callback
    )
    result = await enforce.run(RunRequest(request=_REQUEST, execute=execute))
    assert result.decision == "allow"
    execute.assert_called_once()


# ── __getattr__ ───────────────────────────────────────────────────────────────

def test_getattr_raises_attribute_error() -> None:
    # Line 113: accessing any unknown attribute raises AttributeError
    enforce = Enforce(
        client=_FastVerifyClient(),
        bindings=_BINDINGS,
        fail_closed=True,
    )
    with pytest.raises(AttributeError, match="Enforce has no public attribute"):
        _ = enforce.evaluate  # type: ignore[attr-defined]
