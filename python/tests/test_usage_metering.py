"""Tests for atlasent.usage_metering — usage metering client."""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from atlasent.exceptions import AtlaSentError
from atlasent.usage_metering import UsageMeteringClient

BASE_URL = "https://api.atlasent.io"
API_KEY = "ask_test_usage"


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
        "atlasent.usage_metering.urllib_request.urlopen", return_value=resp
    ) as m:
        yield m


SAMPLE_RECORD = {
    "id": "rec-1",
    "org_id": "org-abc",
    "action_type": "production.deploy",
    "decision": "allow",
    "billable": True,
    "recorded_at": "2026-06-01T10:00:00Z",
}

SAMPLE_LIST_RESPONSE = {
    "data": [SAMPLE_RECORD],
    "next_cursor": "cursor-xyz",
}

SAMPLE_SUMMARY = {
    "org_id": "org-abc",
    "period_start": "2026-06-01T00:00:00Z",
    "period_end": "2026-06-30T23:59:59Z",
    "total_evaluations": 1234,
    "billable_allows": 1000,
    "billable_denies": 200,
}


# ── Construction ───────────────────────────────────────────────────────────────


class TestConstruction:
    def test_stores_client_reference(self):
        c = _fake_client()
        m = UsageMeteringClient(c)
        assert m._client is c


# ── list — path and method ─────────────────────────────────────────────────────


class TestListPath:
    def test_hits_correct_endpoint(self):
        with _mock_urlopen(SAMPLE_LIST_RESPONSE) as m:
            UsageMeteringClient(_fake_client()).list()
        req = m.call_args[0][0]
        assert req.full_url.startswith(f"{BASE_URL}/v1-usage-metering")
        assert req.get_method() == "GET"

    def test_no_query_params_when_none_given(self):
        with _mock_urlopen(SAMPLE_LIST_RESPONSE) as m:
            UsageMeteringClient(_fake_client()).list()
        req = m.call_args[0][0]
        assert "?" not in req.full_url

    def test_authorization_header(self):
        with _mock_urlopen(SAMPLE_LIST_RESPONSE) as m:
            UsageMeteringClient(_fake_client()).list()
        req = m.call_args[0][0]
        assert req.get_header("Authorization") == f"Bearer {API_KEY}"


# ── list — query params ────────────────────────────────────────────────────────


class TestListQueryParams:
    def test_limit_param(self):
        with _mock_urlopen(SAMPLE_LIST_RESPONSE) as m:
            UsageMeteringClient(_fake_client()).list(limit=50)
        assert "limit=50" in m.call_args[0][0].full_url

    def test_before_param(self):
        with _mock_urlopen(SAMPLE_LIST_RESPONSE) as m:
            UsageMeteringClient(_fake_client()).list(before="cursor-xyz")
        assert "before=cursor-xyz" in m.call_args[0][0].full_url

    def test_decision_param(self):
        with _mock_urlopen(SAMPLE_LIST_RESPONSE) as m:
            UsageMeteringClient(_fake_client()).list(decision="deny")
        assert "decision=deny" in m.call_args[0][0].full_url

    def test_multiple_params_combined(self):
        with _mock_urlopen(SAMPLE_LIST_RESPONSE) as m:
            UsageMeteringClient(_fake_client()).list(
                limit=25, decision="allow", before="abc"
            )
        url = m.call_args[0][0].full_url
        assert "limit=25" in url
        assert "decision=allow" in url
        assert "before=abc" in url


# ── list — response parsing ────────────────────────────────────────────────────


class TestListResponse:
    def test_returns_data_list(self):
        with _mock_urlopen(SAMPLE_LIST_RESPONSE):
            result = UsageMeteringClient(_fake_client()).list()
        assert len(result["data"]) == 1
        rec = result["data"][0]
        assert rec["id"] == "rec-1"
        assert rec["org_id"] == "org-abc"
        assert rec["action_type"] == "production.deploy"
        assert rec["decision"] == "allow"
        assert rec["billable"] is True
        assert rec["recorded_at"] == "2026-06-01T10:00:00Z"

    def test_surfaces_next_cursor(self):
        with _mock_urlopen(SAMPLE_LIST_RESPONSE):
            result = UsageMeteringClient(_fake_client()).list()
        assert result["next_cursor"] == "cursor-xyz"

    def test_empty_data(self):
        with _mock_urlopen({"data": [], "next_cursor": None}):
            result = UsageMeteringClient(_fake_client()).list()
        assert result["data"] == []

    def test_empty_body_returns_empty_dict(self):
        resp = MagicMock()
        resp.read.return_value = b""
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        with patch(
            "atlasent.usage_metering.urllib_request.urlopen", return_value=resp
        ):
            result = UsageMeteringClient(_fake_client()).list()
        assert result == {}

    def test_deny_decision_record(self):
        deny_record = {**SAMPLE_RECORD, "decision": "deny", "billable": False}
        with _mock_urlopen({"data": [deny_record]}):
            result = UsageMeteringClient(_fake_client()).list()
        assert result["data"][0]["decision"] == "deny"
        assert result["data"][0]["billable"] is False


# ── summary — path and method ──────────────────────────────────────────────────


class TestSummaryPath:
    def test_hits_correct_endpoint(self):
        with _mock_urlopen(SAMPLE_SUMMARY) as m:
            UsageMeteringClient(_fake_client()).summary()
        req = m.call_args[0][0]
        assert req.full_url.startswith(f"{BASE_URL}/v1-usage-metering/summary")
        assert req.get_method() == "GET"

    def test_no_query_params_when_none_given(self):
        with _mock_urlopen(SAMPLE_SUMMARY) as m:
            UsageMeteringClient(_fake_client()).summary()
        req = m.call_args[0][0]
        assert "?" not in req.full_url

    def test_authorization_header(self):
        with _mock_urlopen(SAMPLE_SUMMARY) as m:
            UsageMeteringClient(_fake_client()).summary()
        req = m.call_args[0][0]
        assert req.get_header("Authorization") == f"Bearer {API_KEY}"


# ── summary — query params ─────────────────────────────────────────────────────


class TestSummaryQueryParams:
    def test_period_day(self):
        with _mock_urlopen(SAMPLE_SUMMARY) as m:
            UsageMeteringClient(_fake_client()).summary(period="day")
        assert "period=day" in m.call_args[0][0].full_url

    def test_period_week(self):
        with _mock_urlopen(SAMPLE_SUMMARY) as m:
            UsageMeteringClient(_fake_client()).summary(period="week")
        assert "period=week" in m.call_args[0][0].full_url

    def test_period_month(self):
        with _mock_urlopen(SAMPLE_SUMMARY) as m:
            UsageMeteringClient(_fake_client()).summary(period="month")
        assert "period=month" in m.call_args[0][0].full_url


# ── summary — response parsing ─────────────────────────────────────────────────


class TestSummaryResponse:
    def test_returns_all_fields(self):
        with _mock_urlopen(SAMPLE_SUMMARY):
            result = UsageMeteringClient(_fake_client()).summary()
        assert result["org_id"] == "org-abc"
        assert result["period_start"] == "2026-06-01T00:00:00Z"
        assert result["period_end"] == "2026-06-30T23:59:59Z"
        assert result["total_evaluations"] == 1234
        assert result["billable_allows"] == 1000
        assert result["billable_denies"] == 200


# ── error handling ─────────────────────────────────────────────────────────────


class TestErrorHandling:
    def test_list_network_error_raises_atlasent_error(self):
        with patch(
            "atlasent.usage_metering.urllib_request.urlopen",
            side_effect=OSError("timeout"),
        ):
            with pytest.raises(AtlaSentError, match="Usage metering client request"):
                UsageMeteringClient(_fake_client()).list()

    def test_summary_network_error_raises_atlasent_error(self):
        with patch(
            "atlasent.usage_metering.urllib_request.urlopen",
            side_effect=OSError("connection refused"),
        ):
            with pytest.raises(AtlaSentError, match="Usage metering client request"):
                UsageMeteringClient(_fake_client()).summary()
