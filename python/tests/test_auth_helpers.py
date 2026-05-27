"""Tests for atlasent.auth — token management and multi-IdP refresh helpers."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from atlasent import AtlaSentClient
from atlasent.auth import (
    list_idp_connections,
    refresh_token,
    refresh_with_idp,
)
from atlasent.exceptions import AtlaSentError

API_KEY = "ask_test_auth_helpers"
BASE_URL = "https://api.atlasent.io"


def _client() -> AtlaSentClient:
    return AtlaSentClient(api_key=API_KEY, base_url=BASE_URL)


def _mock_post_response(body: object, status: int = 200) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.headers = {"X-Request-ID": "req-auth-123"}
    resp.json = MagicMock(return_value=body)
    return resp


def _mock_get_response(body: object, status: int = 200) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.headers = {"X-Request-ID": "req-auth-123"}
    resp.json = MagicMock(return_value=body)
    return resp


SAMPLE_TOKEN_RESPONSE = {
    "access_token": "eyJhbGciOiJSUzI1NiJ9.new",
    "refresh_token": "rt_new_abc",
    "token_type": "Bearer",
    "expires_in": 3600,
}

SAMPLE_IDP_TOKEN_RESPONSE = {
    **SAMPLE_TOKEN_RESPONSE,
    "idp_id": "idp_okta_prod",
}

SAMPLE_CONNECTIONS = {
    "connections": [
        {
            "id": "idp_okta_prod",
            "name": "Okta Production",
            "provider": "okta",
            "enabled": True,
            "default": True,
            "created_at": "2026-01-01T00:00:00Z",
        },
        {
            "id": "idp_entra",
            "name": "Azure AD",
            "provider": "entra",
            "enabled": True,
            "default": False,
            "created_at": "2026-02-01T00:00:00Z",
        },
    ]
}


class TestRefreshToken:
    def test_refresh_token_success(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_post_response(SAMPLE_TOKEN_RESPONSE),
        ) as mock_req:
            result = refresh_token(client, "rt_old_abc")
        assert result["access_token"] == SAMPLE_TOKEN_RESPONSE["access_token"]
        assert result["token_type"] == "Bearer"
        sent = json.loads(mock_req.call_args[1]["content"])
        assert sent["refresh_token"] == "rt_old_abc"
        assert sent["grant_type"] == "refresh_token"
        assert "/v1/auth/token/refresh" in mock_req.call_args[0][1]

    def test_refresh_token_401_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_post_response({"error": "invalid_token"}, 401),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                refresh_token(client, "rt_expired")
        assert exc_info.value.status_code == 401

    def test_refresh_token_500_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_post_response({"message": "internal error"}, 500),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                refresh_token(client, "rt_abc")
        assert exc_info.value.status_code == 500
        assert exc_info.value.code == "server_error"

    def test_refresh_token_malformed_json_raises(self):
        client = _client()
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 200
        resp.headers = {"X-Request-ID": "req-123"}
        resp.json = MagicMock(side_effect=ValueError("bad json"))
        with patch.object(client._client, "request", return_value=resp):
            with pytest.raises(AtlaSentError) as exc_info:
                refresh_token(client, "rt_abc")
        assert exc_info.value.code == "bad_response"

    def test_refresh_token_no_message_in_error_body(self):
        client = _client()
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 400
        resp.headers = {"X-Request-ID": "req-123"}
        resp.json = MagicMock(side_effect=ValueError("bad json"))
        with patch.object(client._client, "request", return_value=resp):
            with pytest.raises(AtlaSentError) as exc_info:
                refresh_token(client, "rt_abc")
        assert exc_info.value.status_code == 400


class TestRefreshWithIdp:
    def test_refresh_with_idp_success(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_post_response(SAMPLE_IDP_TOKEN_RESPONSE),
        ) as mock_req:
            result = refresh_with_idp(client, "idp_okta_prod", "rt_old_abc")
        assert result["idp_id"] == "idp_okta_prod"
        sent = json.loads(mock_req.call_args[1]["content"])
        assert sent["idp_id"] == "idp_okta_prod"
        assert sent["refresh_token"] == "rt_old_abc"
        assert "/v1/auth/idp/idp_okta_prod/token/refresh" in mock_req.call_args[0][1]

    def test_refresh_with_idp_url_encodes_id(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_post_response(SAMPLE_IDP_TOKEN_RESPONSE),
        ) as mock_req:
            refresh_with_idp(client, "idp/with/slashes", "rt_abc")
        url = mock_req.call_args[0][1]
        assert "idp%2Fwith%2Fslashes" in url

    def test_refresh_with_empty_idp_raises(self):
        client = _client()
        with pytest.raises(AtlaSentError) as exc_info:
            refresh_with_idp(client, "", "rt_abc")
        assert exc_info.value.code == "bad_request"

    def test_refresh_with_idp_401_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_post_response({"error": "unknown_idp"}, 401),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                refresh_with_idp(client, "idp_unknown", "rt_abc")
        assert exc_info.value.status_code == 401

    def test_refresh_with_idp_500_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_post_response({"message": "server error"}, 500),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                refresh_with_idp(client, "idp_prod", "rt_abc")
        assert exc_info.value.status_code == 500

    def test_refresh_with_idp_malformed_json_raises(self):
        client = _client()
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 200
        resp.headers = {"X-Request-ID": "req-123"}
        resp.json = MagicMock(side_effect=ValueError("bad json"))
        with patch.object(client._client, "request", return_value=resp):
            with pytest.raises(AtlaSentError) as exc_info:
                refresh_with_idp(client, "idp_prod", "rt_abc")
        assert exc_info.value.code == "bad_response"


class TestListIdpConnections:
    def test_list_connections_success(self):
        client = _client()
        with patch.object(
            client._client,
            "get",
            return_value=_mock_get_response(SAMPLE_CONNECTIONS),
        ) as mock_get:
            result = list_idp_connections(client)
        assert len(result) == 2
        assert result[0]["id"] == "idp_okta_prod"
        assert result[1]["id"] == "idp_entra"
        assert "/v1/auth/idp-connections" in mock_get.call_args[0][0]

    def test_list_connections_empty(self):
        client = _client()
        with patch.object(
            client._client,
            "get",
            return_value=_mock_get_response({"connections": []}),
        ):
            result = list_idp_connections(client)
        assert result == []

    def test_list_connections_missing_key_returns_empty(self):
        client = _client()
        with patch.object(
            client._client,
            "get",
            return_value=_mock_get_response({}),
        ):
            result = list_idp_connections(client)
        assert result == []

    def test_list_connections_401_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "get",
            return_value=_mock_get_response({"error": "unauthorized"}, 401),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                list_idp_connections(client)
        assert exc_info.value.status_code == 401

    def test_list_connections_500_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "get",
            return_value=_mock_get_response({"message": "error"}, 500),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                list_idp_connections(client)
        assert exc_info.value.status_code == 500

    def test_list_connections_malformed_json_raises(self):
        client = _client()
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 200
        resp.headers = {"X-Request-ID": "req-123"}
        resp.json = MagicMock(side_effect=ValueError("bad json"))
        with patch.object(client._client, "get", return_value=resp):
            with pytest.raises(AtlaSentError) as exc_info:
                list_idp_connections(client)
        assert exc_info.value.code == "bad_response"

    def test_list_connections_error_message_from_body(self):
        client = _client()
        with patch.object(
            client._client,
            "get",
            return_value=_mock_get_response({"message": "forbidden"}, 403),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                list_idp_connections(client)
        assert "forbidden" in str(exc_info.value)
