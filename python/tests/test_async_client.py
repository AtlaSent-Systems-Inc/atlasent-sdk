"""Unit tests for AsyncAtlaSentClient."""

import pytest
from pytest_httpx import HTTPXMock

from atlasent.async_client import AsyncAtlaSentClient
from atlasent.exceptions import AtlaSentDeniedError
from atlasent.models import Decision

BASE = "https://api.atlasent.io"


@pytest.fixture
def client() -> AsyncAtlaSentClient:
    return AsyncAtlaSentClient(api_key="test-key", base_url=BASE)


async def test_async_evaluate_allow(client: AsyncAtlaSentClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/v1/evaluate",
        json={"decision": "allow", "permitToken": "tok-async"},
    )
    resp = await client.evaluate("agent-async", "production.deploy")
    assert resp.decision == Decision.allow
    assert resp.permit_token == "tok-async"


async def test_async_authorize_deny(client: AsyncAtlaSentClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/v1/evaluate",
        json={"decision": "deny", "denyCode": "OUTSIDE_CHANGE_WINDOW"},
    )
    with pytest.raises(AtlaSentDeniedError) as exc_info:
        await client.authorize("agent-async", "production.deploy")
    assert exc_info.value.code == "OUTSIDE_CHANGE_WINDOW"


async def test_async_context_manager(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/v1/evaluate",
        json={"decision": "allow"},
    )
    async with AsyncAtlaSentClient(api_key="test-key", base_url=BASE) as c:
        resp = await c.evaluate("agent-1", "staging.deploy")
    assert resp.decision == Decision.allow
