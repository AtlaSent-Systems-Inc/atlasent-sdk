"""Tests for atlasent.auth — refresh_token, refresh_with_idp, list_idp_connections."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from atlasent.auth import list_idp_connections, refresh_token, refresh_with_idp
from atlasent.exceptions import AtlaSentError

# ── helpers ──────────────────────────────────────────────────────────────────


def _make_response(
    status_code: int, body: object, headers: dict | None = None
) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.headers = headers or {}
    resp.json.return_value = body
    resp.content = b""
    return resp


def _make_client(response: MagicMock) -> MagicMock:
    client = MagicMock()
    client._base_url = "https://api.atlasent.io"
    http = MagicMock()
    http.request.return_value = response
    http.get.return_value = response
    client._client = http
    return client


STUB_TOKEN = {
    "access_token": "at_abc",
    "refresh_token": "rt_new",
    "token_type": "Bearer",
    "expires_in": 3600,
}

STUB_IDP_CONN = {
    "id": "idp_okta_prod",
    "name": "Okta Production",
    "provider": "okta",
    "enabled": True,
    "default": True,
    "created_at": "2025-01-01T00:00:00Z",
}


# ── refresh_token ────────────────────────────────────────────────────────────


def test_refresh_token_posts_correct_path() -> None:
    resp = _make_response(200, STUB_TOKEN)
    client = _make_client(resp)
    result = refresh_token(client, "rt_current")
    client._client.request.assert_called_once()
    call_kwargs = client._client.request.call_args
    assert call_kwargs[0][1].endswith("/v1/auth/token/refresh")
    assert result["access_token"] == "at_abc"


def test_refresh_token_sends_grant_type() -> None:
    import json as _json

    resp = _make_response(200, STUB_TOKEN)
    client = _make_client(resp)
    refresh_token(client, "rt_current")
    content = client._client.request.call_args[1]["content"]
    body = _json.loads(content)
    assert body["grant_type"] == "refresh_token"
    assert body["refresh_token"] == "rt_current"


def test_refresh_token_raises_on_401() -> None:
    resp = _make_response(401, {"error": "invalid_token"})
    client = _make_client(resp)
    with pytest.raises(AtlaSentError):
        refresh_token(client, "bad_token")


def test_refresh_token_raises_on_500() -> None:
    resp = _make_response(500, {})
    client = _make_client(resp)
    with pytest.raises(AtlaSentError) as exc_info:
        refresh_token(client, "rt_current")
    assert exc_info.value.code == "server_error"


def test_refresh_token_raises_on_malformed_json() -> None:
    resp = _make_response(200, None)
    resp.json.side_effect = ValueError("bad json")
    client = _make_client(resp)
    with pytest.raises(AtlaSentError) as exc_info:
        refresh_token(client, "rt_current")
    assert exc_info.value.code == "bad_response"


def test_refresh_token_uses_error_field_from_body() -> None:
    resp = _make_response(400, {"error": "token_expired"})
    client = _make_client(resp)
    with pytest.raises(AtlaSentError) as exc_info:
        refresh_token(client, "rt_current")
    assert "token_expired" in str(exc_info.value)


# ── refresh_with_idp ─────────────────────────────────────────────────────────


def test_refresh_with_idp_encodes_idp_id_in_path() -> None:
    resp = _make_response(200, STUB_TOKEN)
    client = _make_client(resp)
    refresh_with_idp(client, "idp_okta_prod", "rt_current")
    url = client._client.request.call_args[0][1]
    assert "idp_okta_prod" in url
    assert "/v1/auth/idp/" in url


def test_refresh_with_idp_url_encodes_special_chars() -> None:
    resp = _make_response(200, STUB_TOKEN)
    client = _make_client(resp)
    refresh_with_idp(client, "idp/entra", "rt_current")
    url = client._client.request.call_args[0][1]
    assert "idp%2Fentra" in url


def test_refresh_with_idp_raises_on_empty_idp_id() -> None:
    client = _make_client(_make_response(200, STUB_TOKEN))
    with pytest.raises(AtlaSentError):
        refresh_with_idp(client, "", "rt_current")


def test_refresh_with_idp_raises_on_401() -> None:
    resp = _make_response(401, {"message": "Unknown IdP"})
    client = _make_client(resp)
    with pytest.raises(AtlaSentError):
        refresh_with_idp(client, "idp_okta_prod", "bad_token")


def test_refresh_with_idp_includes_idp_id_in_body() -> None:
    import json as _json

    resp = _make_response(200, STUB_TOKEN)
    client = _make_client(resp)
    refresh_with_idp(client, "idp_okta", "rt_current")
    body = _json.loads(client._client.request.call_args[1]["content"])
    assert body["idp_id"] == "idp_okta"


# ── list_idp_connections ──────────────────────────────────────────────────────


def test_list_idp_connections_gets_correct_path() -> None:
    resp = _make_response(200, {"connections": [STUB_IDP_CONN]})
    resp.headers = {}
    client = _make_client(resp)
    result = list_idp_connections(client)
    url = client._client.get.call_args[0][0]
    assert url.endswith("/v1/auth/idp-connections")
    assert result[0]["id"] == "idp_okta_prod"


def test_list_idp_connections_returns_empty_list_on_missing_key() -> None:
    resp = _make_response(200, {})
    resp.headers = {}
    client = _make_client(resp)
    assert list_idp_connections(client) == []


def test_list_idp_connections_raises_on_error() -> None:
    resp = _make_response(403, {"error": "forbidden"})
    resp.headers = {}
    client = _make_client(resp)
    with pytest.raises(AtlaSentError):
        list_idp_connections(client)


def test_list_idp_connections_raises_on_malformed_json() -> None:
    resp = _make_response(200, None)
    resp.headers = {}
    resp.json.side_effect = ValueError("bad json")
    client = _make_client(resp)
    with pytest.raises(AtlaSentError):
        list_idp_connections(client)
