"""Unit tests for AsyncAtlaSentClient using respx."""

from __future__ import annotations

import httpx
import pytest
import pytest_asyncio
import respx

from atlasent import AsyncAtlaSentClient, EvaluateRequest, VerifyPermitRequest
from atlasent.exceptions import (
    AuthorizationDeniedError,
    PermitVerificationError,
)

pytestmark = pytest.mark.asyncio

BASE_URL = "https://api.atlasent.test"


def _evaluate_body(**overrides):
    body = {
        "decision": "allow",
        "request_id": "r-1",
        "mode": "live",
        "cache_hit": False,
        "evaluation_ms": 5,
        "permit_token": "pt_abc",
        "expires_at": "2026-01-01T00:00:00Z",
    }
    body.update(overrides)
    return body


@pytest_asyncio.fixture
async def client():
    async with AsyncAtlaSentClient(
        api_key="ak_test", base_url=BASE_URL, max_retries=0
    ) as c:
        yield c


class TestEvaluateAsync:
    @respx.mock
    async def test_allow_returns_response(self, client: AsyncAtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(200, json=_evaluate_body())
        )
        res = await client.evaluate(
            EvaluateRequest(action_type="a", actor_id="u")
        )
        assert res.decision == "allow"

    @respx.mock
    async def test_authorize_raises_on_deny(self, client: AsyncAtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(
                200,
                json=_evaluate_body(
                    decision="deny",
                    permit_token=None,
                    deny_code="OVER_LIMIT",
                    deny_reason="over",
                ),
            )
        )
        with pytest.raises(AuthorizationDeniedError) as info:
            await client.authorize(EvaluateRequest(action_type="a", actor_id="u"))
        assert info.value.deny_code == "OVER_LIMIT"


class TestWithPermitAsync:
    @respx.mock
    async def test_allow_runs_async_fn(self, client: AsyncAtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(200, json=_evaluate_body())
        )
        respx.post(f"{BASE_URL}/v1-verify-permit").mock(
            return_value=httpx.Response(
                200,
                json={"valid": True, "outcome": "allow", "decision": "allow", "reason": "ok"},
            )
        )

        async def afn(evaluation, verification):
            assert verification.valid is True
            return "async-ran"

        out = await client.with_permit(
            EvaluateRequest(action_type="a", actor_id="u"), afn
        )
        assert out == "async-ran"

    @respx.mock
    async def test_allow_runs_sync_fn(self, client: AsyncAtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(200, json=_evaluate_body())
        )
        respx.post(f"{BASE_URL}/v1-verify-permit").mock(
            return_value=httpx.Response(
                200,
                json={"valid": True, "outcome": "allow", "decision": "allow", "reason": "ok"},
            )
        )

        def fn(evaluation, verification):
            return "sync-ran"

        out = await client.with_permit(
            EvaluateRequest(action_type="a", actor_id="u"), fn
        )
        assert out == "sync-ran"

    @respx.mock
    async def test_verify_denial_prevents_fn(
        self, client: AsyncAtlaSentClient
    ) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(200, json=_evaluate_body())
        )
        respx.post(f"{BASE_URL}/v1-verify-permit").mock(
            return_value=httpx.Response(
                200,
                json={
                    "valid": False,
                    "outcome": "deny",
                    "verify_error_code": "PERMIT_ALREADY_USED",
                    "reason": "used",
                },
            )
        )
        ran = {"ok": False}

        async def fn(e, v):
            ran["ok"] = True

        with pytest.raises(PermitVerificationError):
            await client.with_permit(
                EvaluateRequest(action_type="a", actor_id="u"), fn
            )
        assert ran["ok"] is False


class TestVerifyPermitAsync:
    @respx.mock
    async def test_verify_200_value_based(self, client: AsyncAtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-verify-permit").mock(
            return_value=httpx.Response(
                200,
                json={
                    "valid": False,
                    "outcome": "deny",
                    "verify_error_code": "ACTOR_MISMATCH",
                    "reason": "mismatch",
                },
            )
        )
        res = await client.verify_permit(VerifyPermitRequest(permit_token="pt"))
        assert res.valid is False
        assert res.verify_error_code == "ACTOR_MISMATCH"
