"""Tests for atlasent.sso_client — SSO administration sub-client."""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from atlasent.exceptions import AtlaSentError
from atlasent.sso_client import SsoClient

BASE_URL = "https://api.atlasent.io"
API_KEY = "ask_test_sso_client"


def _fake_client() -> MagicMock:
    c = MagicMock()
    c.base_url = BASE_URL
    c.api_key = API_KEY
    return c


def _fake_response(body: Any, status: int = 200) -> MagicMock:
    raw = json.dumps(body).encode() if body is not None else b""
    resp = MagicMock()
    resp.read.return_value = raw
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


@contextmanager
def _mock_urlopen(body: Any, status: int = 200):
    resp = _fake_response(body, status)
    with patch("atlasent.sso_client.urllib_request.urlopen", return_value=resp) as m:
        yield m


# ── Construction ───────────────────────────────────────────────────────────────


class TestSsoClientConstruction:
    def test_stores_client_reference(self):
        c = _fake_client()
        sso = SsoClient(c)
        assert sso._client is c


# ── list_connections ───────────────────────────────────────────────────────────


class TestListConnections:
    def test_returns_connections_list(self):
        payload = {"connections": [{"id": "conn-1", "name": "Okta"}]}
        with _mock_urlopen(payload) as m:
            sso = SsoClient(_fake_client())
            result = sso.list_connections()
        assert result == [{"id": "conn-1", "name": "Okta"}]
        req = m.call_args[0][0]
        assert req.full_url == f"{BASE_URL}/v1/sso/connections"
        assert req.get_method() == "GET"

    def test_missing_connections_key_returns_empty_list(self):
        with _mock_urlopen({}):
            result = SsoClient(_fake_client()).list_connections()
        assert result == []

    def test_authorization_header(self):
        with _mock_urlopen({"connections": []}) as m:
            SsoClient(_fake_client()).list_connections()
        req = m.call_args[0][0]
        assert req.get_header("Authorization") == f"Bearer {API_KEY}"


# ── get_connection ─────────────────────────────────────────────────────────────


class TestGetConnection:
    def test_fetches_by_id(self):
        payload = {"id": "conn-abc", "name": "Azure"}
        with _mock_urlopen(payload) as m:
            result = SsoClient(_fake_client()).get_connection("conn-abc")
        assert result["name"] == "Azure"
        req = m.call_args[0][0]
        assert req.full_url == f"{BASE_URL}/v1/sso/connections/conn-abc"

    def test_url_encodes_connection_id(self):
        with _mock_urlopen({"id": "x"}) as m:
            SsoClient(_fake_client()).get_connection("conn/special")
        req = m.call_args[0][0]
        assert "conn%2Fspecial" in req.full_url


# ── create_connection ──────────────────────────────────────────────────────────


class TestCreateConnection:
    def test_posts_required_fields(self):
        created = {"id": "conn-new", "name": "Okta", "protocol": "saml"}
        with _mock_urlopen(created, 201) as m:
            result = SsoClient(_fake_client()).create_connection(
                name="Okta",
                protocol="saml",
                idp_entity_id="https://idp.example.com",
            )
        assert result["id"] == "conn-new"
        req = m.call_args[0][0]
        body = json.loads(req.data)
        assert body["name"] == "Okta"
        assert body["protocol"] == "saml"
        assert body["idp_entity_id"] == "https://idp.example.com"
        assert req.get_method() == "POST"

    def test_includes_optional_fields_when_provided(self):
        with _mock_urlopen({"id": "c"}, 201) as m:
            SsoClient(_fake_client()).create_connection(
                name="X",
                protocol="saml",
                idp_entity_id="urn:x",
                metadata_url="https://meta.example.com",
                email_domain="example.com",
                enforce_for_domain=True,
            )
        body = json.loads(m.call_args[0][0].data)
        assert body["metadata_url"] == "https://meta.example.com"
        assert body["email_domain"] == "example.com"
        assert body["enforce_for_domain"] is True

    def test_omits_none_optional_fields(self):
        with _mock_urlopen({"id": "c"}, 201) as m:
            SsoClient(_fake_client()).create_connection(
                name="X", protocol="saml", idp_entity_id="urn:x"
            )
        body = json.loads(m.call_args[0][0].data)
        assert "metadata_url" not in body
        assert "email_domain" not in body


# ── update_connection ──────────────────────────────────────────────────────────


class TestUpdateConnection:
    def test_patch_method_and_path(self):
        with _mock_urlopen({"id": "conn-1"}) as m:
            SsoClient(_fake_client()).update_connection("conn-1", name="New Name")
        req = m.call_args[0][0]
        assert req.get_method() == "PATCH"
        assert req.full_url == f"{BASE_URL}/v1/sso/connections/conn-1"
        assert json.loads(req.data) == {"name": "New Name"}


# ── delete_connection ──────────────────────────────────────────────────────────


class TestDeleteConnection:
    def test_delete_returns_none(self):
        with _mock_urlopen(None) as m:
            result = SsoClient(_fake_client()).delete_connection("conn-1")
        assert result is None
        req = m.call_args[0][0]
        assert req.get_method() == "DELETE"
        assert "conn-1" in req.full_url


# ── activate_connection ────────────────────────────────────────────────────────


class TestActivateConnection:
    def test_posts_to_activate_path(self):
        payload = {"id": "conn-1", "supabase_provider_id": "sp-xyz"}
        with _mock_urlopen(payload) as m:
            result = SsoClient(_fake_client()).activate_connection("conn-1")
        assert result["supabase_provider_id"] == "sp-xyz"
        req = m.call_args[0][0]
        assert req.get_method() == "POST"
        assert req.full_url == f"{BASE_URL}/v1/sso/connections/conn-1/activate"


# ── list_jit_rules ─────────────────────────────────────────────────────────────


class TestListJitRules:
    def test_returns_rules_list(self):
        payload = {"rules": [{"id": "rule-1", "granted_role": "admin"}]}
        with _mock_urlopen(payload) as m:
            result = SsoClient(_fake_client()).list_jit_rules()
        assert result == [{"id": "rule-1", "granted_role": "admin"}]
        req = m.call_args[0][0]
        assert req.full_url == f"{BASE_URL}/v1/sso/jit-rules"

    def test_filters_by_connection_id(self):
        with _mock_urlopen({"rules": []}) as m:
            SsoClient(_fake_client()).list_jit_rules(connection_id="conn-abc")
        req = m.call_args[0][0]
        assert "connection_id=conn-abc" in req.full_url

    def test_missing_rules_key_returns_empty_list(self):
        with _mock_urlopen({}):
            assert SsoClient(_fake_client()).list_jit_rules() == []


# ── create_jit_rule ────────────────────────────────────────────────────────────


class TestCreateJitRule:
    def test_posts_required_fields_with_default_precedence(self):
        created = {"id": "rule-new", "granted_role": "viewer"}
        with _mock_urlopen(created, 201) as m:
            result = SsoClient(_fake_client()).create_jit_rule(
                connection_id="conn-1",
                claim_attribute="groups",
                claim_value="viewers",
                granted_role="viewer",
            )
        assert result["id"] == "rule-new"
        body = json.loads(m.call_args[0][0].data)
        assert body["connection_id"] == "conn-1"
        assert body["claim_attribute"] == "groups"
        assert body["claim_value"] == "viewers"
        assert body["granted_role"] == "viewer"
        assert body["precedence"] == 100

    def test_custom_precedence(self):
        with _mock_urlopen({"id": "r"}, 201) as m:
            SsoClient(_fake_client()).create_jit_rule(
                connection_id="c",
                claim_attribute="a",
                claim_value="v",
                granted_role="admin",
                precedence=50,
            )
        assert json.loads(m.call_args[0][0].data)["precedence"] == 50


# ── patch_jit_rule ─────────────────────────────────────────────────────────────


class TestPatchJitRule:
    def test_patch_method_and_path(self):
        with _mock_urlopen({"id": "rule-1"}) as m:
            SsoClient(_fake_client()).patch_jit_rule("rule-1", granted_role="admin")
        req = m.call_args[0][0]
        assert req.get_method() == "PATCH"
        assert req.full_url == f"{BASE_URL}/v1/sso/jit-rules/rule-1"
        assert json.loads(req.data) == {"granted_role": "admin"}

    def test_url_encodes_rule_id(self):
        with _mock_urlopen({"id": "x"}) as m:
            SsoClient(_fake_client()).patch_jit_rule("rule/special", granted_role="v")
        assert "rule%2Fspecial" in m.call_args[0][0].full_url


# ── delete_jit_rule ────────────────────────────────────────────────────────────


class TestDeleteJitRule:
    def test_delete_returns_none(self):
        with _mock_urlopen(None) as m:
            result = SsoClient(_fake_client()).delete_jit_rule("rule-1")
        assert result is None
        req = m.call_args[0][0]
        assert req.get_method() == "DELETE"
        assert "rule-1" in req.full_url


# ── enforce ────────────────────────────────────────────────────────────────────


class TestEnforce:
    def test_enable_action(self):
        payload = {"sso_enabled": True, "enforce_sso": False}
        with _mock_urlopen(payload) as m:
            result = SsoClient(_fake_client()).enforce("enable")
        assert result["sso_enabled"] is True
        body = json.loads(m.call_args[0][0].data)
        assert body == {"action": "enable"}
        assert m.call_args[0][0].full_url == f"{BASE_URL}/v1/sso/enforce"

    def test_enforce_action(self):
        with _mock_urlopen({"enforce_sso": True}) as m:
            SsoClient(_fake_client()).enforce("enforce")
        assert json.loads(m.call_args[0][0].data) == {"action": "enforce"}


# ── get_status ─────────────────────────────────────────────────────────────────


class TestGetStatus:
    def test_returns_readiness_dict(self):
        readiness = {
            "has_connection": True,
            "has_jit_rule": False,
            "sso_enabled": False,
            "enforce_sso": False,
        }
        with _mock_urlopen({"readiness": readiness}):
            result = SsoClient(_fake_client()).get_status()
        assert result == readiness

    def test_falls_back_to_raw_response_when_no_readiness_key(self):
        raw = {"has_connection": True}
        with _mock_urlopen(raw):
            result = SsoClient(_fake_client()).get_status()
        assert result == raw


# ── error handling ─────────────────────────────────────────────────────────────


class TestErrorHandling:
    def test_network_error_raises_atlasent_error(self):
        with patch(
            "atlasent.sso_client.urllib_request.urlopen",
            side_effect=OSError("connection refused"),
        ):
            with pytest.raises(AtlaSentError, match="SSO client request failed"):
                SsoClient(_fake_client()).list_connections()

    def test_empty_body_returns_none(self):
        resp = MagicMock()
        resp.read.return_value = b""
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        with patch("atlasent.sso_client.urllib_request.urlopen", return_value=resp):
            result = SsoClient(_fake_client()).delete_connection("conn-1")
        assert result is None
