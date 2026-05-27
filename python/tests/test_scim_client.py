"""Tests for atlasent.scim_client.ScimClient."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from atlasent.scim_client import (
    SCIM_GROUP_SCHEMA,
    SCIM_USER_SCHEMA,
    ScimClient,
)
from atlasent.exceptions import AtlaSentError


def _make_response(
    status_code: int,
    body: object,
    headers: dict | None = None,
) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.headers = headers or {}
    resp.json.return_value = body
    resp.content = b""
    return resp


def _make_client(response: MagicMock) -> ScimClient:
    atlasent_client = MagicMock()
    atlasent_client._base_url = "https://api.atlasent.io"
    http = MagicMock()
    http.request.return_value = response
    atlasent_client._client = http
    return ScimClient(atlasent_client)


STUB_USER = {
    "id": "usr_1",
    "userName": "alice@example.com",
    "active": True,
    "schemas": [SCIM_USER_SCHEMA],
}

STUB_LIST = {
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    "totalResults": 1,
    "startIndex": 1,
    "itemsPerPage": 100,
    "Resources": [STUB_USER],
}


# ── users.list ────────────────────────────────────────────────────────────────


def test_users_list_gets_correct_path() -> None:
    scim = _make_client(_make_response(200, STUB_LIST))
    result = scim.users.list(org_id="org_abc")
    url = scim.users._client._client.request.call_args[0][1]
    assert "/scim/v2/org_abc/Users" in url
    assert result["totalResults"] == 1


def test_users_list_url_encodes_org_id() -> None:
    scim = _make_client(_make_response(200, STUB_LIST))
    scim.users.list(org_id="org/abc")
    url = scim.users._client._client.request.call_args[0][1]
    assert "org%2Fabc" in url


def test_users_list_passes_filter_in_query() -> None:
    scim = _make_client(_make_response(200, STUB_LIST))
    scim.users.list(org_id="org_abc", filter='userName eq "alice"')
    url = scim.users._client._client.request.call_args[0][1]
    assert "filter=" in url


def test_users_list_passes_pagination_params() -> None:
    scim = _make_client(_make_response(200, STUB_LIST))
    scim.users.list(org_id="org_abc", start_index=2, count=50)
    url = scim.users._client._client.request.call_args[0][1]
    assert "startIndex=2" in url
    assert "count=50" in url


# ── users.create ─────────────────────────────────────────────────────────────


def test_users_create_injects_schema() -> None:
    import json as _json

    scim = _make_client(_make_response(200, STUB_USER))
    scim.users.create("org_abc", {"userName": "bob@example.com"})
    body = _json.loads(scim.users._client._client.request.call_args[1]["content"])
    assert SCIM_USER_SCHEMA in body["schemas"]


def test_users_create_preserves_caller_schema() -> None:
    import json as _json

    scim = _make_client(_make_response(200, STUB_USER))
    custom = ["urn:custom"]
    scim.users.create("org_abc", {"userName": "bob@example.com", "schemas": custom})
    body = _json.loads(scim.users._client._client.request.call_args[1]["content"])
    assert body["schemas"] == custom


def test_users_create_raises_on_409() -> None:
    scim = _make_client(_make_response(409, {"error": "conflict"}))
    with pytest.raises(AtlaSentError):
        scim.users.create("org_abc", {"userName": "alice@example.com"})


# ── users.update ─────────────────────────────────────────────────────────────


def test_users_update_puts_to_correct_path() -> None:
    scim = _make_client(_make_response(200, STUB_USER))
    scim.users.update("org_abc", "usr_1", STUB_USER)
    url = scim.users._client._client.request.call_args[0][1]
    assert "/scim/v2/org_abc/Users/usr_1" in url
    assert scim.users._client._client.request.call_args[0][0] == "PUT"


def test_users_update_injects_schema_if_absent() -> None:
    import json as _json

    scim = _make_client(_make_response(200, STUB_USER))
    scim.users.update("org_abc", "usr_1", {"userName": "alice@example.com"})
    body = _json.loads(scim.users._client._client.request.call_args[1]["content"])
    assert SCIM_USER_SCHEMA in body["schemas"]


# ── users.delete ─────────────────────────────────────────────────────────────


def test_users_delete_sends_delete_request() -> None:
    resp = _make_response(204, None)
    scim = _make_client(resp)
    scim.users.delete("org_abc", "usr_1")
    call = scim.users._client._client.request.call_args[0]
    assert call[0] == "DELETE"
    assert "/scim/v2/org_abc/Users/usr_1" in call[1]


def test_users_delete_raises_on_404() -> None:
    scim = _make_client(_make_response(404, {"error": "not_found"}))
    with pytest.raises(AtlaSentError):
        scim.users.delete("org_abc", "usr_missing")


# ── groups ────────────────────────────────────────────────────────────────────


def test_groups_list_calls_groups_path() -> None:
    resp = _make_response(200, {"totalResults": 0, "Resources": []})
    scim = _make_client(resp)
    scim.groups.list(org_id="org_abc")
    url = scim.groups._client._client.request.call_args[0][1]
    assert "/scim/v2/org_abc/Groups" in url


def test_groups_create_injects_schema() -> None:
    import json as _json

    resp = _make_response(200, {"id": "grp_1", "displayName": "Admins"})
    scim = _make_client(resp)
    scim.groups.create("org_abc", {"displayName": "Admins"})
    body = _json.loads(scim.groups._client._client.request.call_args[1]["content"])
    assert SCIM_GROUP_SCHEMA in body["schemas"]


def test_groups_delete_calls_correct_path() -> None:
    resp = _make_response(204, None)
    scim = _make_client(resp)
    scim.groups.delete("org_abc", "grp_1")
    call = scim.groups._client._client.request.call_args[0]
    assert call[0] == "DELETE"
    assert "/scim/v2/org_abc/Groups/grp_1" in call[1]


# ── error path: non-JSON body ─────────────────────────────────────────────────


def test_users_list_raises_on_server_error_with_non_json_body() -> None:
    resp = _make_response(500, None)
    resp.json.side_effect = ValueError("not json")
    scim = _make_client(resp)
    with pytest.raises(AtlaSentError) as exc_info:
        scim.users.list(org_id="org_abc")
    assert exc_info.value.code == "server_error"
