"""Unit tests for atlasent_guard / async_atlasent_guard decorators."""

from __future__ import annotations

import httpx
import pytest
import respx

from atlasent import (
    AsyncAtlaSentClient,
    AtlaSentClient,
    EvaluateRequest,
)
from atlasent.exceptions import AuthorizationDeniedError, PermitVerificationError
from atlasent.guard import async_atlasent_guard, atlasent_guard

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


def _verify_body(**overrides):
    body = {"valid": True, "outcome": "allow", "decision": "allow", "reason": "ok"}
    body.update(overrides)
    return body


@respx.mock
def test_sync_guard_allow_passes_atlasent_kwarg() -> None:
    respx.post(f"{BASE_URL}/v1-evaluate").mock(
        return_value=httpx.Response(200, json=_evaluate_body())
    )
    respx.post(f"{BASE_URL}/v1-verify-permit").mock(
        return_value=httpx.Response(200, json=_verify_body())
    )
    client = AtlaSentClient(api_key="ak", base_url=BASE_URL, max_retries=0)

    def build(agent_id, **_):
        return EvaluateRequest(action_type="modify", actor_id=agent_id)

    @atlasent_guard(client, build)
    def handler(agent_id, atlasent=None):
        assert atlasent is not None
        evaluation, verification = atlasent
        assert evaluation.decision == "allow"
        assert verification.valid is True
        return f"ok:{agent_id}"

    assert handler("user:7") == "ok:user:7"


@respx.mock
def test_sync_guard_deny_propagates_and_skips_handler() -> None:
    respx.post(f"{BASE_URL}/v1-evaluate").mock(
        return_value=httpx.Response(
            200,
            json=_evaluate_body(
                decision="deny",
                permit_token=None,
                deny_code="POLICY",
                deny_reason="no",
            ),
        )
    )
    client = AtlaSentClient(api_key="ak", base_url=BASE_URL, max_retries=0)

    def build(**_):
        return EvaluateRequest(action_type="a", actor_id="u")

    ran = {"ok": False}

    @atlasent_guard(client, build)
    def handler(atlasent=None):
        ran["ok"] = True

    with pytest.raises(AuthorizationDeniedError):
        handler()
    assert ran["ok"] is False


@respx.mock
def test_sync_guard_verify_denial_propagates() -> None:
    respx.post(f"{BASE_URL}/v1-evaluate").mock(
        return_value=httpx.Response(200, json=_evaluate_body())
    )
    respx.post(f"{BASE_URL}/v1-verify-permit").mock(
        return_value=httpx.Response(
            200,
            json={
                "valid": False,
                "outcome": "deny",
                "verify_error_code": "PERMIT_EXPIRED",
                "reason": "expired",
            },
        )
    )
    client = AtlaSentClient(api_key="ak", base_url=BASE_URL, max_retries=0)

    def build(**_):
        return EvaluateRequest(action_type="a", actor_id="u")

    @atlasent_guard(client, build)
    def handler(atlasent=None):
        return "unreachable"

    with pytest.raises(PermitVerificationError) as info:
        handler()
    assert info.value.verify_error_code == "PERMIT_EXPIRED"


@pytest.mark.asyncio
@respx.mock
async def test_async_guard_allow_passes_atlasent_kwarg() -> None:
    respx.post(f"{BASE_URL}/v1-evaluate").mock(
        return_value=httpx.Response(200, json=_evaluate_body())
    )
    respx.post(f"{BASE_URL}/v1-verify-permit").mock(
        return_value=httpx.Response(200, json=_verify_body())
    )
    async with AsyncAtlaSentClient(
        api_key="ak", base_url=BASE_URL, max_retries=0
    ) as client:

        def build(agent_id, **_):
            return EvaluateRequest(action_type="modify", actor_id=agent_id)

        @async_atlasent_guard(client, build)
        async def handler(agent_id, atlasent=None):
            evaluation, verification = atlasent
            assert evaluation.decision == "allow"
            return f"ok:{agent_id}"

        assert await handler("user:9") == "ok:user:9"
