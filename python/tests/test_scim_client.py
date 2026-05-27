"""Tests for atlasent.scim_client — class-based SCIM 2.0 sub-client."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from atlasent import AtlaSentClient
from atlasent.exceptions import AtlaSentError
from atlasent.scim_client import (
    SCIM_GROUP_SCHEMA,
    SCIM_PATCH_OP_SCHEMA,
    SCIM_USER_SCHEMA,
    ScimClient,
    ScimGroupsClient,
    ScimUsersClient,
)

API_KEY = "ask_test_scim_client"
BASE_URL = "https://api.atlasent.io"
ORG_ID = "org_sc_test"


def _client() -> AtlaSentClient:
    return AtlaSentClient(api_key=API_KEY, base_url=BASE_URL)


def _mock_response(body: object, status: int = 200) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.headers = {"X-Request-ID": "req-sc-123"}
    if body is not None:
        resp.json = MagicMock(return_value=body)
    else:
        resp.json = MagicMock(side_effect=ValueError("no json"))
    return resp


SAMPLE_USER = {
    "schemas": [SCIM_USER_SCHEMA],
    "id": "scim-user-1",
    "userName": "bob@example.com",
    "active": True,
}

SAMPLE_GROUP = {
    "schemas": [SCIM_GROUP_SCHEMA],
    "id": "scim-group-1",
    "displayName": "Platform",
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


class TestScimClientInit:
    def test_scim_client_has_users_and_groups(self):
        client = _client()
        scim = ScimClient(client)
        assert isinstance(scim.users, ScimUsersClient)
        assert isinstance(scim.groups, ScimGroupsClient)

    def test_schema_constants(self):
        assert SCIM_USER_SCHEMA == "urn:ietf:params:scim:schemas:core:2.0:User"
        assert SCIM_GROUP_SCHEMA == "urn:ietf:params:scim:schemas:core:2.0:Group"
        assert SCIM_PATCH_OP_SCHEMA == "urn:ietf:params:scim:api:messages:2.0:PatchOp"


class TestScimUsersClient:
    def test_list_users(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(LIST_USERS_RESP),
        ) as mock_req:
            result = scim.users.list(ORG_ID)
        assert result["totalResults"] == 1
        assert result["Resources"][0]["userName"] == "bob@example.com"
        assert mock_req.call_args[0][0] == "GET"
        assert f"/scim/v2/{ORG_ID}/Users" in mock_req.call_args[0][1]

    def test_list_users_with_filter_and_pagination(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(LIST_USERS_RESP),
        ) as mock_req:
            scim.users.list(
                ORG_ID,
                filter='userName eq "bob@example.com"',
                start_index=11,
                count=10,
            )
        url = mock_req.call_args[0][1]
        assert "filter=" in url
        assert "startIndex=11" in url
        assert "count=10" in url

    def test_create_user_injects_schema(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(SAMPLE_USER, 201),
        ) as mock_req:
            result = scim.users.create(ORG_ID, {"userName": "bob@example.com"})
        assert result["id"] == "scim-user-1"
        sent = json.loads(mock_req.call_args[1]["content"])
        assert SCIM_USER_SCHEMA in sent["schemas"]
        assert mock_req.call_args[0][0] == "POST"

    def test_create_user_preserves_existing_schemas(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(SAMPLE_USER, 201),
        ) as mock_req:
            scim.users.create(ORG_ID, SAMPLE_USER)
        sent = json.loads(mock_req.call_args[1]["content"])
        # schemas already present — should not be modified
        assert SCIM_USER_SCHEMA in sent["schemas"]

    def test_update_user_put(self):
        client = _client()
        scim = ScimClient(client)
        updated = {**SAMPLE_USER, "active": False}
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(updated),
        ) as mock_req:
            result = scim.users.update(ORG_ID, "scim-user-1", {"userName": "bob@example.com"})
        assert result["active"] is False
        assert mock_req.call_args[0][0] == "PUT"
        assert f"/Users/{ORG_ID}" not in mock_req.call_args[0][1]  # url has org then user
        assert "scim-user-1" in mock_req.call_args[0][1]

    def test_delete_user_204(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(None, 204),
        ) as mock_req:
            result = scim.users.delete(ORG_ID, "scim-user-1")
        assert result is None
        assert mock_req.call_args[0][0] == "DELETE"

    def test_list_users_404_raises(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"error": "org not found"}, 404),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                scim.users.list("missing_org")
        assert exc_info.value.status_code == 404

    def test_create_user_500_raises(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"message": "internal error"}, 500),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                scim.users.create(ORG_ID, {"userName": "test@example.com"})
        assert exc_info.value.status_code == 500

    def test_malformed_json_response_raises(self):
        client = _client()
        scim = ScimClient(client)
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 200
        resp.headers = {"X-Request-ID": "req-123"}
        resp.json = MagicMock(side_effect=ValueError("bad json"))
        with patch.object(client._client, "request", return_value=resp):
            with pytest.raises(AtlaSentError) as exc_info:
                scim.users.list(ORG_ID)
        assert exc_info.value.code == "bad_response"

    def test_error_message_from_json_body(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"message": "userName already taken"}, 409),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                scim.users.create(ORG_ID, {"userName": "bob@example.com"})
        assert "userName already taken" in str(exc_info.value)

    def test_error_uses_error_key_from_json_body(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"error": "validation_error"}, 400),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                scim.users.create(ORG_ID, {})
        assert "validation_error" in str(exc_info.value)


class TestScimGroupsClient:
    def test_list_groups(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(LIST_GROUPS_RESP),
        ) as mock_req:
            result = scim.groups.list(ORG_ID)
        assert result["Resources"][0]["displayName"] == "Platform"
        assert f"/scim/v2/{ORG_ID}/Groups" in mock_req.call_args[0][1]

    def test_list_groups_with_pagination(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(LIST_GROUPS_RESP),
        ) as mock_req:
            scim.groups.list(ORG_ID, start_index=1, count=50)
        url = mock_req.call_args[0][1]
        assert "startIndex=1" in url
        assert "count=50" in url

    def test_create_group_injects_schema(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(SAMPLE_GROUP, 201),
        ) as mock_req:
            result = scim.groups.create(ORG_ID, {"displayName": "Platform"})
        assert result["id"] == "scim-group-1"
        sent = json.loads(mock_req.call_args[1]["content"])
        assert SCIM_GROUP_SCHEMA in sent["schemas"]

    def test_create_group_preserves_existing_schemas(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(SAMPLE_GROUP, 201),
        ) as mock_req:
            scim.groups.create(ORG_ID, SAMPLE_GROUP)
        sent = json.loads(mock_req.call_args[1]["content"])
        assert SCIM_GROUP_SCHEMA in sent["schemas"]

    def test_delete_group_204(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(None, 204),
        ) as mock_req:
            result = scim.groups.delete(ORG_ID, "scim-group-1")
        assert result is None
        assert mock_req.call_args[0][0] == "DELETE"

    def test_list_groups_404_raises(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"error": "not found"}, 404),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                scim.groups.list("missing_org")
        assert exc_info.value.status_code == 404

    def test_url_encodes_org_and_group_ids(self):
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(None, 204),
        ) as mock_req:
            scim.groups.delete("org/special", "group/special")
        url = mock_req.call_args[0][1]
        assert "org%2Fspecial" in url
        assert "group%2Fspecial" in url

    def test_malformed_json_raises(self):
        client = _client()
        scim = ScimClient(client)
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 200
        resp.headers = {"X-Request-ID": "req-123"}
        resp.json = MagicMock(side_effect=ValueError("bad json"))
        with patch.object(client._client, "request", return_value=resp):
            with pytest.raises(AtlaSentError) as exc_info:
                scim.groups.list(ORG_ID)
        assert exc_info.value.code == "bad_response"

    def test_error_message_fallback(self):
        """When error body has neither 'error' nor 'message', uses default msg."""
        client = _client()
        scim = ScimClient(client)
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"detail": "forbidden"}, 403),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                scim.groups.list(ORG_ID)
        # Default message format includes method, path, and status
        assert "403" in str(exc_info.value)
