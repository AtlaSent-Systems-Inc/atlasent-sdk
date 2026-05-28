"""Tests for atlasent.access_governance_log — paginated identity lifecycle log."""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from atlasent.access_governance_log import AccessGovernanceLogClient
from atlasent.exceptions import AtlaSentError

BASE_URL = "https://api.atlasent.io"
API_KEY = "ask_test_agl"


def _fake_client() -> MagicMock:
    c = MagicMock()
    c.base_url = BASE_URL
    c.api_key = API_KEY
    return c


def _fake_response(body: Any) -> MagicMock:
    raw = json.dumps(body).encode() if body is not None else b""
    resp = MagicMock()
    resp.read.return_value = raw
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


@contextmanager
def _mock_urlopen(body: Any):
    resp = _fake_response(body)
    with patch(
        "atlasent.access_governance_log.urllib_request.urlopen", return_value=resp
    ) as m:
        yield m


SAMPLE_PAGE = {
    "events": [
        {
            "id": "evt-1",
            "event_type": "sso.login",
            "actor_email": "alice@example.com",
            "occurred_at": "2026-05-28T00:00:00Z",
        }
    ],
    "next_cursor": "cursor-abc",
    "total_count": 42,
}


# ── Construction ───────────────────────────────────────────────────────────────


class TestConstruction:
    def test_stores_client_reference(self):
        c = _fake_client()
        log = AccessGovernanceLogClient(c)
        assert log._client is c


# ── list — path and method ─────────────────────────────────────────────────────


class TestListPath:
    def test_hits_correct_endpoint(self):
        with _mock_urlopen(SAMPLE_PAGE) as m:
            AccessGovernanceLogClient(_fake_client()).list()
        req = m.call_args[0][0]
        assert req.full_url.startswith(f"{BASE_URL}/v1/access-governance-log")
        assert req.get_method() == "GET"

    def test_authorization_header(self):
        with _mock_urlopen(SAMPLE_PAGE) as m:
            AccessGovernanceLogClient(_fake_client()).list()
        req = m.call_args[0][0]
        assert req.get_header("Authorization") == f"Bearer {API_KEY}"


# ── list — response parsing ────────────────────────────────────────────────────


class TestListResponse:
    def test_returns_events_list(self):
        with _mock_urlopen(SAMPLE_PAGE):
            result = AccessGovernanceLogClient(_fake_client()).list()
        assert result["events"][0]["event_type"] == "sso.login"
        assert result["next_cursor"] == "cursor-abc"
        assert result["total_count"] == 42

    def test_empty_events(self):
        payload = {"events": [], "next_cursor": None, "total_count": 0}
        with _mock_urlopen(payload):
            result = AccessGovernanceLogClient(_fake_client()).list()
        assert result["events"] == []
        assert result["next_cursor"] is None

    def test_empty_body_returns_empty_dict(self):
        resp = MagicMock()
        resp.read.return_value = b""
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        with patch(
            "atlasent.access_governance_log.urllib_request.urlopen", return_value=resp
        ):
            result = AccessGovernanceLogClient(_fake_client()).list()
        assert result == {}


# ── list — query params ────────────────────────────────────────────────────────


class TestListQueryParams:
    def test_no_params_when_all_none(self):
        with _mock_urlopen(SAMPLE_PAGE) as m:
            AccessGovernanceLogClient(_fake_client()).list()
        req = m.call_args[0][0]
        assert "?" not in req.full_url

    def test_limit_param(self):
        with _mock_urlopen(SAMPLE_PAGE) as m:
            AccessGovernanceLogClient(_fake_client()).list(limit=100)
        assert "limit=100" in m.call_args[0][0].full_url

    def test_cursor_param(self):
        with _mock_urlopen(SAMPLE_PAGE) as m:
            AccessGovernanceLogClient(_fake_client()).list(cursor="cursor-abc")
        assert "cursor=cursor-abc" in m.call_args[0][0].full_url

    def test_event_type_param(self):
        with _mock_urlopen(SAMPLE_PAGE) as m:
            AccessGovernanceLogClient(_fake_client()).list(event_type="sso.login")
        assert "event_type=sso.login" in m.call_args[0][0].full_url

    def test_actor_id_param(self):
        with _mock_urlopen(SAMPLE_PAGE) as m:
            AccessGovernanceLogClient(_fake_client()).list(actor_id="user-xyz")
        assert "actor_id=user-xyz" in m.call_args[0][0].full_url

    def test_from_param(self):
        with _mock_urlopen(SAMPLE_PAGE) as m:
            AccessGovernanceLogClient(_fake_client()).list(from_="2026-01-01T00:00:00Z")
        assert "from=2026-01-01T00%3A00%3A00Z" in m.call_args[0][0].full_url

    def test_to_param(self):
        with _mock_urlopen(SAMPLE_PAGE) as m:
            AccessGovernanceLogClient(_fake_client()).list(to="2026-12-31T23:59:59Z")
        assert "to=2026-12-31T23%3A59%3A59Z" in m.call_args[0][0].full_url

    def test_multiple_params_combined(self):
        with _mock_urlopen(SAMPLE_PAGE) as m:
            AccessGovernanceLogClient(_fake_client()).list(
                limit=50, event_type="sso.login", actor_id="u-1"
            )
        url = m.call_args[0][0].full_url
        assert "limit=50" in url
        assert "event_type=sso.login" in url
        assert "actor_id=u-1" in url


# ── error handling ─────────────────────────────────────────────────────────────


class TestErrorHandling:
    def test_network_error_raises_atlasent_error(self):
        with patch(
            "atlasent.access_governance_log.urllib_request.urlopen",
            side_effect=OSError("timeout"),
        ):
            with pytest.raises(AtlaSentError, match="Access governance log request"):
                AccessGovernanceLogClient(_fake_client()).list()
