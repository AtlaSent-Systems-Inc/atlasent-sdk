"""Tests for AsyncAtlaSentClient SCIM, SIEM, and evidence-export methods."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from atlasent.async_client import AsyncAtlaSentClient
from atlasent.exceptions import AtlaSentError
from atlasent.scim import SCIM_GROUP_SCHEMA, SCIM_PATCH_OP_SCHEMA, SCIM_USER_SCHEMA

API_KEY = "ask_test_async_scim"
BASE_URL = "https://api.atlasent.io"
ORG_ID = "org_test_abc"


# ── Fixtures / helpers ────────────────────────────────────────────────────────


@pytest.fixture
def client() -> AsyncAtlaSentClient:
    return AsyncAtlaSentClient(api_key=API_KEY, base_url=BASE_URL, max_retries=0)


def _mock_response(body: object, status: int = 200) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.headers = {}
    resp.json = MagicMock(return_value=body)
    resp.text = json.dumps(body) if body is not None else ""
    return resp


SAMPLE_USER = {
    "schemas": [SCIM_USER_SCHEMA],
    "id": "user-1",
    "userName": "alice@example.com",
    "active": True,
}

SAMPLE_GROUP = {
    "schemas": [SCIM_GROUP_SCHEMA],
    "id": "group-1",
    "displayName": "Engineering",
    "members": [],
}

LIST_USERS_RESP = {
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    "totalResults": 1,
    "Resources": [SAMPLE_USER],
}

LIST_GROUPS_RESP = {
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    "totalResults": 1,
    "Resources": [SAMPLE_GROUP],
}

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

EVIDENCE_EXPORT_RECORD = {
    "id": "exp-123",
    "org_id": ORG_ID,
    "regime": "soc2_type_ii",
    "window_from": "2026-02-01T00:00:00Z",
    "window_to": "2026-05-01T00:00:00Z",
    "bundle_sha256": "abc123",
    "controls_total": 10,
    "controls_evidenced": 8,
    "controls_partial": 1,
    "controls_missing": 1,
    "generated_by": "system",
    "generated_at": "2026-05-23T00:00:00Z",
}

LIST_EXPORTS_RESP = {"exports": [EVIDENCE_EXPORT_RECORD]}

CREATE_EXPORT_RESP = {
    "export": EVIDENCE_EXPORT_RECORD,
    "bundle": {"version": "1.0"},
    "sha256": "abc123",
}


# ── SCIM Users ────────────────────────────────────────────────────────────────


class TestAsyncScimUsers:
    async def test_list_users(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(LIST_USERS_RESP)),
        ) as mock_req:
            result = await client.async_scim_list_users(ORG_ID)
        assert result["totalResults"] == 1
        assert result["Resources"][0]["userName"] == "alice@example.com"
        call_method, call_url = mock_req.call_args[0][:2]
        assert call_method == "GET"
        assert f"/v1/scim/v2/{ORG_ID}/Users" in call_url

    async def test_list_users_with_filter(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(LIST_USERS_RESP)),
        ) as mock_req:
            result = await client.async_scim_list_users(
                ORG_ID,
                filter='userName eq "alice@example.com"',
                start_index=1,
                count=10,
            )
        call_url = mock_req.call_args[0][1]
        assert "filter=" in call_url
        assert "startIndex=1" in call_url
        assert "count=10" in call_url
        assert result["totalResults"] == 1

    async def test_create_user(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(SAMPLE_USER, 201)),
        ) as mock_req:
            result = await client.async_scim_create_user(
                ORG_ID, {"userName": "alice@example.com"}
            )
        assert result["id"] == "user-1"
        call_method = mock_req.call_args[0][0]
        assert call_method == "POST"
        # schemas should be auto-injected
        sent_body = json.loads(mock_req.call_args[1]["content"])
        assert SCIM_USER_SCHEMA in sent_body["schemas"]

    async def test_create_user_preserves_existing_schemas(
        self, client: AsyncAtlaSentClient
    ):
        user_with_schemas = {
            "schemas": ["custom-schema"],
            "userName": "bob@example.com",
        }
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(SAMPLE_USER, 201)),
        ) as mock_req:
            await client.async_scim_create_user(ORG_ID, user_with_schemas)
        sent_body = json.loads(mock_req.call_args[1]["content"])
        assert sent_body["schemas"] == ["custom-schema"]

    async def test_get_user(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(SAMPLE_USER)),
        ) as mock_req:
            result = await client.async_scim_get_user(ORG_ID, "user-1")
        assert result["id"] == "user-1"
        call_method, call_url = mock_req.call_args[0][:2]
        assert call_method == "GET"
        assert "user-1" in call_url

    async def test_replace_user(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(SAMPLE_USER)),
        ) as mock_req:
            result = await client.async_scim_replace_user(
                ORG_ID, "user-1", {"userName": "alice@example.com"}
            )
        assert result["id"] == "user-1"
        assert mock_req.call_args[0][0] == "PUT"

    async def test_patch_user(self, client: AsyncAtlaSentClient):
        ops = [{"op": "replace", "path": "active", "value": False}]
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(SAMPLE_USER)),
        ) as mock_req:
            await client.async_scim_patch_user(ORG_ID, "user-1", ops)
        assert mock_req.call_args[0][0] == "PATCH"
        sent_body = json.loads(mock_req.call_args[1]["content"])
        assert SCIM_PATCH_OP_SCHEMA in sent_body["schemas"]
        assert sent_body["Operations"] == ops

    async def test_delete_user(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(None, 204)),
        ) as mock_req:
            result = await client.async_scim_delete_user(ORG_ID, "user-1")
        assert result is None
        assert mock_req.call_args[0][0] == "DELETE"

    async def test_error_response_raises(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response({"error": "Not Found"}, 404)),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                await client.async_scim_get_user(ORG_ID, "nonexistent")
        assert exc_info.value.status_code == 404


# ── SCIM Groups ───────────────────────────────────────────────────────────────


class TestAsyncScimGroups:
    async def test_list_groups(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(LIST_GROUPS_RESP)),
        ) as mock_req:
            result = await client.async_scim_list_groups(ORG_ID)
        assert result["totalResults"] == 1
        assert result["Resources"][0]["displayName"] == "Engineering"
        call_method, call_url = mock_req.call_args[0][:2]
        assert call_method == "GET"
        assert f"/v1/scim/v2/{ORG_ID}/Groups" in call_url

    async def test_create_group(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(SAMPLE_GROUP, 201)),
        ) as mock_req:
            result = await client.async_scim_create_group(
                ORG_ID, {"displayName": "Engineering"}
            )
        assert result["id"] == "group-1"
        sent_body = json.loads(mock_req.call_args[1]["content"])
        assert SCIM_GROUP_SCHEMA in sent_body["schemas"]

    async def test_get_group(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(SAMPLE_GROUP)),
        ) as mock_req:
            result = await client.async_scim_get_group(ORG_ID, "group-1")
        assert result["id"] == "group-1"
        assert mock_req.call_args[0][0] == "GET"

    async def test_replace_group(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(SAMPLE_GROUP)),
        ) as mock_req:
            await client.async_scim_replace_group(
                ORG_ID, "group-1", {"displayName": "Engineering"}
            )
        assert mock_req.call_args[0][0] == "PUT"

    async def test_patch_group(self, client: AsyncAtlaSentClient):
        ops = [{"op": "add", "path": "members", "value": [{"value": "user-1"}]}]
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(SAMPLE_GROUP)),
        ) as mock_req:
            await client.async_scim_patch_group(ORG_ID, "group-1", ops)
        assert mock_req.call_args[0][0] == "PATCH"
        sent_body = json.loads(mock_req.call_args[1]["content"])
        assert SCIM_PATCH_OP_SCHEMA in sent_body["schemas"]

    async def test_delete_group(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(None, 204)),
        ) as mock_req:
            result = await client.async_scim_delete_group(ORG_ID, "group-1")
        assert result is None
        assert mock_req.call_args[0][0] == "DELETE"


# ── SIEM ──────────────────────────────────────────────────────────────────────


class TestAsyncSiem:
    async def test_get_siem_config(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(SIEM_CONFIG)),
        ) as mock_req:
            result = await client.async_get_siem_config(ORG_ID)
        assert (
            result["destinationUrl"]
            == "https://splunk.example.com:8088/services/collector"
        )
        assert result["format"] == "splunk_hec"
        call_method, call_url = mock_req.call_args[0][:2]
        assert call_method == "GET"
        assert f"/v1/orgs/{ORG_ID}/siem-config" in call_url

    async def test_upsert_siem_config(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(SIEM_CONFIG)),
        ) as mock_req:
            result = await client.async_upsert_siem_config(
                ORG_ID,
                destination_url="https://splunk.example.com:8088/services/collector",
                format="splunk_hec",
                auth_type="bearer",
                credential="my-token",
            )
        assert result["format"] == "splunk_hec"
        call_method, call_url = mock_req.call_args[0][:2]
        assert call_method == "PATCH"
        assert f"/v1/orgs/{ORG_ID}/siem-config" in call_url
        sent_body = json.loads(mock_req.call_args[1]["content"])
        assert (
            sent_body["destinationUrl"]
            == "https://splunk.example.com:8088/services/collector"
        )
        assert sent_body["credential"] == "my-token"

    async def test_upsert_siem_config_validation_non_https(
        self, client: AsyncAtlaSentClient
    ):
        with pytest.raises(ValueError, match="HTTPS"):
            await client.async_upsert_siem_config(
                ORG_ID,
                destination_url="http://insecure.example.com/endpoint",
            )

    async def test_upsert_siem_config_invalid_format(self, client: AsyncAtlaSentClient):
        with pytest.raises(ValueError, match="format must be one of"):
            await client.async_upsert_siem_config(
                ORG_ID,
                destination_url="https://valid.example.com/endpoint",
                format="bad_format",
            )

    async def test_upsert_siem_config_invalid_auth_type(
        self, client: AsyncAtlaSentClient
    ):
        with pytest.raises(ValueError, match="auth_type must be one of"):
            await client.async_upsert_siem_config(
                ORG_ID,
                destination_url="https://valid.example.com/endpoint",
                auth_type="bad_auth",
            )

    async def test_upsert_siem_config_batch_size_out_of_range(
        self, client: AsyncAtlaSentClient
    ):
        with pytest.raises(ValueError, match="batch_size"):
            await client.async_upsert_siem_config(
                ORG_ID,
                destination_url="https://valid.example.com/endpoint",
                batch_size=0,
            )

    async def test_upsert_siem_config_retry_count_out_of_range(
        self, client: AsyncAtlaSentClient
    ):
        with pytest.raises(ValueError, match="retry_count"):
            await client.async_upsert_siem_config(
                ORG_ID,
                destination_url="https://valid.example.com/endpoint",
                retry_count=11,
            )

    async def test_siem_test_delivery(self, client: AsyncAtlaSentClient):
        delivery_result = {"success": True, "latencyMs": 42}
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(delivery_result)),
        ) as mock_req:
            result = await client.async_siem_test_delivery(ORG_ID)
        assert result["success"] is True
        assert result["latencyMs"] == 42
        call_method, call_url = mock_req.call_args[0][:2]
        assert call_method == "POST"
        assert f"/v1/orgs/{ORG_ID}/siem-exports/test" in call_url

    async def test_upsert_siem_no_credential_omitted_from_body(
        self, client: AsyncAtlaSentClient
    ):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(SIEM_CONFIG)),
        ) as mock_req:
            await client.async_upsert_siem_config(
                ORG_ID,
                destination_url="https://valid.example.com/endpoint",
            )
        sent_body = json.loads(mock_req.call_args[1]["content"])
        assert "credential" not in sent_body


# ── Evidence exports ──────────────────────────────────────────────────────────


class TestAsyncEvidenceExports:
    async def test_list_evidence_exports(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(LIST_EXPORTS_RESP)),
        ) as mock_req:
            result = await client.async_list_evidence_exports(ORG_ID)
        assert len(result["exports"]) == 1
        assert result["exports"][0]["regime"] == "soc2_type_ii"
        call_method, call_url = mock_req.call_args[0][:2]
        assert call_method == "GET"
        assert f"/v1/orgs/{ORG_ID}/evidence-exports" in call_url

    async def test_list_evidence_exports_with_regime(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(LIST_EXPORTS_RESP)),
        ) as mock_req:
            await client.async_list_evidence_exports(ORG_ID, regime="soc2_type_ii")
        call_url = mock_req.call_args[0][1]
        assert "regime=soc2_type_ii" in call_url

    async def test_list_evidence_exports_invalid_regime(
        self, client: AsyncAtlaSentClient
    ):
        with pytest.raises(ValueError, match="regime must be one of"):
            await client.async_list_evidence_exports(ORG_ID, regime="invalid_regime")

    async def test_get_evidence_export(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(EVIDENCE_EXPORT_RECORD)),
        ) as mock_req:
            result = await client.async_get_evidence_export(ORG_ID, "exp-123")
        assert result["id"] == "exp-123"
        call_method, call_url = mock_req.call_args[0][:2]
        assert call_method == "GET"
        assert "exp-123" in call_url

    async def test_create_evidence_export(self, client: AsyncAtlaSentClient):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(CREATE_EXPORT_RESP, 201)),
        ) as mock_req:
            result = await client.async_create_evidence_export(
                ORG_ID,
                regime="soc2_type_ii",
                window={"from": "2026-02-01T00:00:00Z", "to": "2026-05-01T00:00:00Z"},
            )
        assert result["sha256"] == "abc123"
        call_method, call_url = mock_req.call_args[0][:2]
        assert call_method == "POST"
        assert f"/v1/orgs/{ORG_ID}/evidence-exports" in call_url
        sent_body = json.loads(mock_req.call_args[1]["content"])
        assert sent_body["regime"] == "soc2_type_ii"
        assert sent_body["window"]["from"] == "2026-02-01T00:00:00Z"

    async def test_create_evidence_export_invalid_regime(
        self, client: AsyncAtlaSentClient
    ):
        with pytest.raises(ValueError, match="regime must be one of"):
            await client.async_create_evidence_export(ORG_ID, regime="bad_regime")

    async def test_create_evidence_export_with_bundle_id_and_evidence(
        self, client: AsyncAtlaSentClient
    ):
        with patch.object(
            client._client,
            "request",
            new=AsyncMock(return_value=_mock_response(CREATE_EXPORT_RESP, 201)),
        ) as mock_req:
            await client.async_create_evidence_export(
                ORG_ID,
                regime="hipaa",
                bundle_id="bundle-uuid-123",
                evidence={"manual": "approved by auditor"},
            )
        sent_body = json.loads(mock_req.call_args[1]["content"])
        assert sent_body["bundle_id"] == "bundle-uuid-123"
        assert sent_body["manual"] == "approved by auditor"
