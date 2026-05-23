"""Tests for atlasent.scim — SCIM 2.0 provisioning helpers."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from atlasent import AtlaSentClient
from atlasent.exceptions import AtlaSentError
from atlasent.scim import (
    SCIM_GROUP_SCHEMA,
    SCIM_PATCH_OP_SCHEMA,
    SCIM_USER_SCHEMA,
    scim_create_group,
    scim_create_user,
    scim_delete_group,
    scim_delete_user,
    scim_get_group,
    scim_get_user,
    scim_list_groups,
    scim_list_users,
    scim_patch_group,
    scim_patch_user,
    scim_replace_group,
    scim_replace_user,
)

API_KEY = "ask_test_scim"
BASE_URL = "https://api.atlasent.io"
ORG_ID = "org_test_abc"


def _client() -> AtlaSentClient:
    return AtlaSentClient(api_key=API_KEY, base_url=BASE_URL)


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

LIST_USERS = {
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    "totalResults": 1,
    "Resources": [SAMPLE_USER],
}

LIST_GROUPS = {
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    "totalResults": 1,
    "Resources": [SAMPLE_GROUP],
}


class TestScimUsers:
    def test_list_users_get(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response(LIST_USERS)) as mock_req:
            result = scim_list_users(client, ORG_ID)
        assert result["totalResults"] == 1
        assert result["Resources"][0]["userName"] == "alice@example.com"
        mock_req.assert_called_once()
        assert f"/v1/scim/v2/{ORG_ID}/Users" in mock_req.call_args[0][1]
        assert mock_req.call_args[0][0] == "GET"

    def test_list_users_with_filter_and_pagination(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response(LIST_USERS)) as mock_req:
            scim_list_users(client, ORG_ID, filter='userName eq "alice@example.com"', start_index=1, count=25)
        url = mock_req.call_args[0][1]
        assert "filter=" in url
        assert "startIndex=1" in url
        assert "count=25" in url

    def test_create_user_post(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response(SAMPLE_USER, 201)) as mock_req:
            result = scim_create_user(client, ORG_ID, {"userName": "alice@example.com"})
        assert result["id"] == "user-1"
        assert mock_req.call_args[0][0] == "POST"

    def test_create_user_injects_schema(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response(SAMPLE_USER, 201)) as mock_req:
            scim_create_user(client, ORG_ID, {"userName": "alice@example.com"})
        sent = json.loads(mock_req.call_args[1]["content"])
        assert SCIM_USER_SCHEMA in sent["schemas"]

    def test_get_user(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response(SAMPLE_USER)) as mock_req:
            result = scim_get_user(client, ORG_ID, "user-1")
        assert result["userName"] == "alice@example.com"
        assert "/Users/user-1" in mock_req.call_args[0][1]

    def test_replace_user_put(self):
        client = _client()
        updated = {**SAMPLE_USER, "active": False}
        with patch.object(client._client, "request", return_value=_mock_response(updated)) as mock_req:
            result = scim_replace_user(client, ORG_ID, "user-1", {"userName": "alice@example.com", "active": False})
        assert result["active"] is False
        assert mock_req.call_args[0][0] == "PUT"

    def test_patch_user_deprovision(self):
        client = _client()
        deprovisioned = {**SAMPLE_USER, "active": False}
        with patch.object(client._client, "request", return_value=_mock_response(deprovisioned)) as mock_req:
            result = scim_patch_user(client, ORG_ID, "user-1", [{"op": "replace", "path": "active", "value": False}])
        assert result["active"] is False
        assert mock_req.call_args[0][0] == "PATCH"
        sent = json.loads(mock_req.call_args[1]["content"])
        assert sent["schemas"] == [SCIM_PATCH_OP_SCHEMA]
        assert sent["Operations"][0]["op"] == "replace"

    def test_delete_user_204(self):
        client = _client()
        resp = _mock_response(None, 204)
        with patch.object(client._client, "request", return_value=resp) as mock_req:
            result = scim_delete_user(client, ORG_ID, "user-1")
        assert result is None
        assert mock_req.call_args[0][0] == "DELETE"

    def test_get_user_404_raises(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response({"error": "not found"}, 404)):
            with pytest.raises(AtlaSentError) as exc_info:
                scim_get_user(client, ORG_ID, "missing")
        assert exc_info.value.status_code == 404

    def test_create_user_409_raises(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response({"error": "duplicate userName"}, 409)):
            with pytest.raises(AtlaSentError) as exc_info:
                scim_create_user(client, ORG_ID, {"userName": "alice@example.com"})
        assert exc_info.value.status_code == 409

    def test_url_encodes_org_id(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response(LIST_USERS)) as mock_req:
            scim_list_users(client, "org with spaces")
        url = mock_req.call_args[0][1]
        assert "org%20with%20spaces" in url


class TestScimGroups:
    def test_list_groups_get(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response(LIST_GROUPS)) as mock_req:
            result = scim_list_groups(client, ORG_ID)
        assert result["Resources"][0]["displayName"] == "Engineering"
        assert mock_req.call_args[0][0] == "GET"

    def test_create_group_post(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response(SAMPLE_GROUP, 201)) as mock_req:
            result = scim_create_group(client, ORG_ID, {"displayName": "Engineering"})
        assert result["id"] == "group-1"
        assert mock_req.call_args[0][0] == "POST"
        sent = json.loads(mock_req.call_args[1]["content"])
        assert SCIM_GROUP_SCHEMA in sent["schemas"]

    def test_get_group(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response(SAMPLE_GROUP)) as mock_req:
            result = scim_get_group(client, ORG_ID, "group-1")
        assert result["displayName"] == "Engineering"
        assert "/Groups/group-1" in mock_req.call_args[0][1]

    def test_replace_group_put(self):
        client = _client()
        updated = {**SAMPLE_GROUP, "displayName": "Platform"}
        with patch.object(client._client, "request", return_value=_mock_response(updated)) as mock_req:
            result = scim_replace_group(client, ORG_ID, "group-1", {"displayName": "Platform"})
        assert result["displayName"] == "Platform"
        assert mock_req.call_args[0][0] == "PUT"

    def test_patch_group_add_member(self):
        client = _client()
        with_member = {**SAMPLE_GROUP, "members": [{"value": "user-1", "display": "Alice"}]}
        with patch.object(client._client, "request", return_value=_mock_response(with_member)) as mock_req:
            result = scim_patch_group(client, ORG_ID, "group-1", [
                {"op": "add", "path": "members", "value": [{"value": "user-1", "display": "Alice"}]},
            ])
        assert len(result["members"]) == 1
        assert mock_req.call_args[0][0] == "PATCH"

    def test_delete_group_204(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response(None, 204)) as mock_req:
            result = scim_delete_group(client, ORG_ID, "group-1")
        assert result is None
        assert mock_req.call_args[0][0] == "DELETE"

    def test_get_group_404_raises(self):
        client = _client()
        with patch.object(client._client, "request", return_value=_mock_response({"error": "not found"}, 404)):
            with pytest.raises(AtlaSentError):
                scim_get_group(client, ORG_ID, "missing")
