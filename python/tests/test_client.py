"""Unit tests for AtlaSentClient using pytest-httpx."""

import pytest
from pytest_httpx import HTTPXMock

from atlasent.client import AtlaSentClient
from atlasent.exceptions import (
    AtlaSentAPIError,
    AtlaSentDeniedError,
    AtlaSentEscalateError,
    AtlaSentHoldError,
)
from atlasent.models import Decision

BASE = "https://api.atlasent.io"


@pytest.fixture
def client() -> AtlaSentClient:
    return AtlaSentClient(api_key="test-key", base_url=BASE)


def test_evaluate_allow(client: AtlaSentClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/v1/evaluate",
        json={"decision": "allow", "permitToken": "tok123"},
    )
    resp = client.evaluate("agent-1", "production.deploy")
    assert resp.decision == Decision.allow
    assert resp.permit_token == "tok123"


def test_evaluate_deny(client: AtlaSentClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/v1/evaluate",
        json={"decision": "deny", "denyCode": "OUTSIDE_CHANGE_WINDOW"},
    )
    resp = client.evaluate("agent-1", "production.deploy")
    assert resp.decision == Decision.deny
    assert resp.deny_code == "OUTSIDE_CHANGE_WINDOW"


def test_authorize_raises_denied(client: AtlaSentClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/v1/evaluate",
        json={"decision": "deny", "denyCode": "INSUFFICIENT_APPROVALS"},
    )
    with pytest.raises(AtlaSentDeniedError) as exc_info:
        client.authorize("agent-1", "production.deploy")
    assert exc_info.value.code == "INSUFFICIENT_APPROVALS"


def test_authorize_raises_hold(client: AtlaSentClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/v1/evaluate",
        json={"decision": "hold", "denyCode": "PENDING_REVIEW"},
    )
    with pytest.raises(AtlaSentHoldError) as exc_info:
        client.authorize("agent-1", "infra.terraform.apply")
    assert exc_info.value.code == "PENDING_REVIEW"


def test_authorize_raises_escalate(client: AtlaSentClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/v1/evaluate",
        json={"decision": "escalate", "escalateTo": "security-team"},
    )
    with pytest.raises(AtlaSentEscalateError) as exc_info:
        client.authorize("agent-1", "data.export")
    assert exc_info.value.escalate_to == "security-team"


def test_http_error_raises_api_error(client: AtlaSentClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/v1/evaluate",
        status_code=401,
        text="Unauthorized",
    )
    with pytest.raises(AtlaSentAPIError) as exc_info:
        client.evaluate("agent-1", "production.deploy")
    assert exc_info.value.status == 401


def test_authorize_allow_returns_result(client: AtlaSentClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/v1/evaluate",
        json={"decision": "allow", "permitToken": "tok-abc"},
    )
    result = client.authorize("agent-1", "production.deploy")
    assert result.permitted is True
    assert result.permit_token == "tok-abc"


def test_verify_permit(client: AtlaSentClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/v1/verify-permit",
        json={"valid": True},
    )
    resp = client.verify_permit("tok-abc", "production.deploy")
    assert resp.valid is True
