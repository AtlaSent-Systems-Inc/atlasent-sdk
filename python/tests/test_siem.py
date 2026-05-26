"""Tests for atlasent.siem — SIEM export configuration helpers."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from atlasent import AtlaSentClient
from atlasent.exceptions import AtlaSentError
from atlasent.siem import get_siem_config, siem_test_delivery, upsert_siem_config

API_KEY = "ask_test_siem"
BASE_URL = "https://api.atlasent.io"
ORG_ID = "org_test_abc"

SIEM_CONFIG = {
    "orgId": ORG_ID,
    "enabled": True,
    "destinationUrl": "https://splunk.example.com:8088/services/collector",
    "format": "splunk_hec",
    "authType": "bearer",
    "includedEventTypes": ["permit", "deny", "override", "governance"],
    "batchSize": 100,
    "retryCount": 3,
    "updatedAt": "2026-05-23T00:00:00Z",
    "updatedBy": "alice@example.com",
}


def _client() -> AtlaSentClient:
    return AtlaSentClient(api_key=API_KEY, base_url=BASE_URL)


def _mock_response(body: object, status: int = 200) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.headers = {}
    resp.json = MagicMock(return_value=body)
    resp.text = json.dumps(body) if body is not None else ""
    return resp


class TestGetSiemConfig:
    def test_get_returns_config(self):
        client = _client()
        with patch.object(
            client._client, "request", return_value=_mock_response(SIEM_CONFIG)
        ) as mock_req:
            result = get_siem_config(client, ORG_ID)
        assert (
            result["destinationUrl"]
            == "https://splunk.example.com:8088/services/collector"
        )
        assert result["format"] == "splunk_hec"
        assert mock_req.call_args[0][0] == "GET"
        assert f"/v1/orgs/{ORG_ID}/siem-config" in mock_req.call_args[0][1]

    def test_get_404_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"error": "SIEM not configured"}, 404),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                get_siem_config(client, ORG_ID)
        assert exc_info.value.status_code == 404

    def test_get_402_enterprise_required(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"error": "enterprise_required"}, 402),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                get_siem_config(client, ORG_ID)
        assert exc_info.value.status_code == 402


class TestUpsertSiemConfig:
    def test_upsert_patch(self):
        client = _client()
        with patch.object(
            client._client, "request", return_value=_mock_response(SIEM_CONFIG)
        ) as mock_req:
            result = upsert_siem_config(
                client,
                ORG_ID,
                destination_url="https://splunk.example.com:8088/services/collector",
                format="splunk_hec",
                auth_type="bearer",
                credential="tok_abc",
            )
        assert result["orgId"] == ORG_ID
        assert mock_req.call_args[0][0] == "PATCH"
        sent = json.loads(mock_req.call_args[1]["content"])
        assert (
            sent["destinationUrl"]
            == "https://splunk.example.com:8088/services/collector"
        )
        assert sent["format"] == "splunk_hec"
        assert sent["credential"] == "tok_abc"

    def test_upsert_omits_credential_when_none(self):
        client = _client()
        with patch.object(
            client._client, "request", return_value=_mock_response(SIEM_CONFIG)
        ) as mock_req:
            upsert_siem_config(
                client,
                ORG_ID,
                destination_url="https://splunk.example.com:8088/services/collector",
            )
        sent = json.loads(mock_req.call_args[1]["content"])
        assert "credential" not in sent

    def test_default_event_types(self):
        client = _client()
        with patch.object(
            client._client, "request", return_value=_mock_response(SIEM_CONFIG)
        ) as mock_req:
            upsert_siem_config(
                client, ORG_ID, destination_url="https://logs.example.com/events"
            )
        sent = json.loads(mock_req.call_args[1]["content"])
        assert sent["includedEventTypes"] == [
            "permit",
            "deny",
            "override",
            "governance",
        ]

    def test_custom_event_types(self):
        client = _client()
        with patch.object(
            client._client, "request", return_value=_mock_response(SIEM_CONFIG)
        ) as mock_req:
            upsert_siem_config(
                client,
                ORG_ID,
                destination_url="https://logs.example.com/events",
                included_event_types=["permit", "deny"],
            )
        sent = json.loads(mock_req.call_args[1]["content"])
        assert sent["includedEventTypes"] == ["permit", "deny"]

    def test_raises_on_http_url(self):
        client = _client()
        with pytest.raises(ValueError, match="HTTPS"):
            upsert_siem_config(
                client, ORG_ID, destination_url="http://insecure.example.com"
            )

    def test_raises_on_invalid_format(self):
        client = _client()
        with pytest.raises(ValueError, match="format"):
            upsert_siem_config(
                client,
                ORG_ID,
                destination_url="https://logs.example.com",
                format="invalid",  # type: ignore[arg-type]
            )

    def test_raises_on_invalid_auth_type(self):
        client = _client()
        with pytest.raises(ValueError, match="auth_type"):
            upsert_siem_config(
                client,
                ORG_ID,
                destination_url="https://logs.example.com",
                auth_type="oauth2",  # type: ignore[arg-type]
            )

    def test_raises_on_batch_size_out_of_range(self):
        client = _client()
        with pytest.raises(ValueError, match="batch_size"):
            upsert_siem_config(
                client, ORG_ID, destination_url="https://logs.example.com", batch_size=0
            )

    def test_raises_on_retry_count_out_of_range(self):
        client = _client()
        with pytest.raises(ValueError, match="retry_count"):
            upsert_siem_config(
                client,
                ORG_ID,
                destination_url="https://logs.example.com",
                retry_count=11,
            )

    def test_402_plan_gate(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"error": "enterprise_required"}, 402),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                upsert_siem_config(
                    client, ORG_ID, destination_url="https://logs.example.com"
                )
        assert exc_info.value.status_code == 402


class TestSiemTestDelivery:
    def test_success_response(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"success": True, "latencyMs": 42}),
        ) as mock_req:
            result = siem_test_delivery(client, ORG_ID)
        assert result["success"] is True
        assert result["latencyMs"] == 42
        assert mock_req.call_args[0][0] == "POST"
        assert "/siem-exports/test" in mock_req.call_args[0][1]

    def test_failure_response(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(
                {"success": False, "error": "connection refused"}
            ),
        ):
            result = siem_test_delivery(client, ORG_ID)
        assert result["success"] is False
        assert "connection refused" in result["error"]

    def test_409_not_configured(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"error": "SIEM not configured"}, 409),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                siem_test_delivery(client, ORG_ID)
        assert exc_info.value.status_code == 409

    def test_402_plan_gate(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"error": "enterprise_required"}, 402),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                siem_test_delivery(client, ORG_ID)
        assert exc_info.value.status_code == 402
