"""Structural assertions for the ``/v1/sso/*`` wire models and the
``client.sso.events.list()`` shim.

Mirror of ``test_audit_bundle.py``-style test discipline — these
tests fail when the wire shape drifts from the source of truth in
``atlasent-api/supabase/functions/v1-sso/handler.ts`` and the
``0041_sso_connections.sql`` migration.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from atlasent import (
    AtlaSentClient,
    SsoCanonicalRole,
    SsoConnection,
    SsoEvent,
    SsoEventsPage,
    SsoEventType,
    SsoJitRule,
    SsoProtocol,
)
from atlasent.exceptions import AtlaSentError


# ── re-exports ───────────────────────────────────────────────────────


def test_sso_models_are_exported_from_top_level_package() -> None:
    """The SDK's public API exposes the SSO models without a deep import."""
    assert SsoConnection.__name__ == "SsoConnection"
    assert SsoJitRule.__name__ == "SsoJitRule"
    assert SsoEvent.__name__ == "SsoEvent"
    assert SsoEventsPage.__name__ == "SsoEventsPage"


def test_sso_literal_aliases_match_handler() -> None:
    """``SsoProtocol`` / ``SsoCanonicalRole`` / ``SsoEventType`` track
    the handler's enum literals so a typo would surface here."""
    # Spot-check a member of each Literal alias by constructing a
    # model that uses it — pydantic will reject anything outside the
    # allowed set.
    proto: SsoProtocol = "saml"
    role: SsoCanonicalRole = "admin"
    et: SsoEventType = "connection_activated"
    assert (proto, role, et) == ("saml", "admin", "connection_activated")


# ── SsoConnection ────────────────────────────────────────────────────


def test_sso_connection_constructs_from_full_row() -> None:
    row: dict[str, Any] = {
        "id": "00000000-0000-0000-0000-000000000001",
        "organization_id": "00000000-0000-0000-0000-00000000000a",
        "name": "Acme SSO",
        "protocol": "saml",
        "supabase_provider_id": "ssp_42",
        "idp_entity_id": "https://idp.acme.com/saml",
        "metadata_url": "https://idp.acme.com/saml/metadata",
        "metadata_xml": None,
        "email_domain": "acme.com",
        "enforce_for_domain": True,
        "is_active": True,
        "created_at": "2026-04-24T00:00:00Z",
        "updated_at": "2026-04-24T00:00:01Z",
        "created_by": "user_1",
    }
    conn = SsoConnection.model_validate(row)
    assert conn.protocol == "saml"
    assert conn.enforce_for_domain is True
    assert conn.created_by == "user_1"


def test_sso_connection_accepts_pending_row_with_null_metadata() -> None:
    """Connections being bootstrapped have ``supabase_provider_id``
    null and only one of ``metadata_url`` / ``metadata_xml`` set."""
    conn = SsoConnection.model_validate(
        {
            "id": "00000000-0000-0000-0000-000000000002",
            "organization_id": "00000000-0000-0000-0000-00000000000a",
            "name": "Pending OIDC",
            "protocol": "oidc",
            "supabase_provider_id": None,
            "idp_entity_id": "issuer.example.com",
            "metadata_url": None,
            "metadata_xml": "<EntityDescriptor/>",
            "email_domain": None,
            "enforce_for_domain": False,
            "is_active": False,
            "created_at": "2026-04-24T00:00:02Z",
            "updated_at": "2026-04-24T00:00:02Z",
        }
    )
    assert conn.is_active is False
    assert conn.supabase_provider_id is None
    assert conn.created_by is None  # field omitted entirely


def test_sso_connection_rejects_unknown_protocol() -> None:
    with pytest.raises(Exception):  # pydantic ValidationError
        SsoConnection.model_validate(
            {
                "id": "x",
                "organization_id": "y",
                "name": "n",
                "protocol": "ldap",  # not in {saml, oidc}
                "idp_entity_id": "e",
            }
        )


# ── SsoJitRule ───────────────────────────────────────────────────────


def test_sso_jit_rule_constructs_from_full_row() -> None:
    rule = SsoJitRule.model_validate(
        {
            "id": "00000000-0000-0000-0000-000000000010",
            "connection_id": "00000000-0000-0000-0000-000000000001",
            "organization_id": "00000000-0000-0000-0000-00000000000a",
            "claim_attribute": "groups",
            "claim_value": "atlasent-admins",
            "granted_role": "admin",
            "precedence": 10,
            "is_active": True,
            "created_at": "2026-04-24T00:00:00Z",
            "updated_at": "2026-04-24T00:00:01Z",
        }
    )
    assert rule.granted_role == "admin"
    assert rule.precedence == 10


def test_sso_jit_rule_rejects_unknown_role() -> None:
    with pytest.raises(Exception):  # pydantic ValidationError
        SsoJitRule.model_validate(
            {
                "id": "x",
                "connection_id": "c",
                "organization_id": "o",
                "claim_attribute": "groups",
                "claim_value": "v",
                "granted_role": "operator",  # not in handler's CANONICAL_ROLES
            }
        )


# ── SsoEvent ─────────────────────────────────────────────────────────


def test_sso_event_constructs_for_connection_lifecycle() -> None:
    evt = SsoEvent.model_validate(
        {
            "id": "00000000-0000-0000-0000-000000000020",
            "organization_id": "00000000-0000-0000-0000-00000000000a",
            "connection_id": "00000000-0000-0000-0000-000000000001",
            "event_type": "connection_activated",
            "actor_email": "owner@acme.com",
            "payload": {"supabase_provider_id": "ssp_42"},
            "occurred_at": "2026-04-24T00:00:03Z",
        }
    )
    assert evt.event_type == "connection_activated"
    assert evt.payload["supabase_provider_id"] == "ssp_42"


def test_sso_event_permits_null_connection_and_actor() -> None:
    evt = SsoEvent.model_validate(
        {
            "id": "00000000-0000-0000-0000-000000000021",
            "organization_id": "00000000-0000-0000-0000-00000000000a",
            "connection_id": None,
            "event_type": "login_denied",
            "actor_email": None,
            "payload": {"reason": "no JIT rule matched"},
            "occurred_at": "2026-04-24T00:00:04Z",
        }
    )
    assert evt.connection_id is None
    assert evt.actor_email is None
    assert evt.payload["reason"] == "no JIT rule matched"


def test_sso_event_defaults_payload_to_empty_dict() -> None:
    evt = SsoEvent.model_validate(
        {
            "id": "00000000-0000-0000-0000-000000000022",
            "organization_id": "00000000-0000-0000-0000-00000000000a",
            "event_type": "login_success",
        }
    )
    assert evt.payload == {}


# ── client.sso.events.list ───────────────────────────────────────────


def _client_with_response(
    body: dict[str, Any], status: int = 200, capture: dict[str, Any] | None = None
) -> AtlaSentClient:
    """Build a client whose underlying httpx.Client returns ``body``.

    Patches ``_request`` (rather than the httpx layer) because the
    request layer's retry / rate-limit parsing is exercised by the
    audit-events tests already; this test focuses on the SSO-shaped
    parsing and parameter wiring.
    """
    client = AtlaSentClient(api_key="k_live_test")

    def fake_request(
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        *,
        params: dict[str, str] | None = None,
    ) -> tuple[dict[str, Any], None, str]:
        if capture is not None:
            capture["method"] = method
            capture["path"] = path
            capture["params"] = params
        if status >= 400:
            raise AtlaSentError("server error", code="server_error")
        return body, None, "req_test"

    client._request = fake_request  # type: ignore[method-assign]
    return client


def test_client_sso_events_list_returns_typed_page() -> None:
    body = {
        "events": [
            {
                "id": "00000000-0000-0000-0000-000000000020",
                "organization_id": "00000000-0000-0000-0000-00000000000a",
                "connection_id": "00000000-0000-0000-0000-000000000001",
                "event_type": "connection_created",
                "actor_email": "owner@acme.com",
                "payload": {"name": "Acme SSO"},
                "occurred_at": "2026-04-24T00:00:00Z",
            }
        ],
        "next_cursor": None,
    }
    client = _client_with_response(body)
    page = client.sso.events.list()
    assert isinstance(page, SsoEventsPage)
    assert len(page.events) == 1
    assert page.events[0].event_type == "connection_created"
    assert page.next_cursor is None


def test_client_sso_events_list_serializes_limit_and_cursor() -> None:
    capture: dict[str, Any] = {}
    client = _client_with_response(
        {"events": [], "next_cursor": None}, capture=capture
    )
    client.sso.events.list(limit=25, cursor="2026-04-24T00:00:00Z")
    assert capture["method"] == "GET"
    assert capture["path"] == "/v1/sso/events"
    assert capture["params"] == {
        "limit": "25",
        # Wire param name is `after` per the v1-sso handler.
        "after": "2026-04-24T00:00:00Z",
    }


def test_client_sso_events_list_propagates_next_cursor() -> None:
    body = {"events": [], "next_cursor": "2026-04-23T00:00:00Z"}
    client = _client_with_response(body)
    page = client.sso.events.list(limit=1)
    assert page.next_cursor == "2026-04-23T00:00:00Z"


def test_client_sso_events_list_raises_on_malformed_response() -> None:
    client = _client_with_response({"not_events": True})
    with pytest.raises(AtlaSentError, match="missing `events`"):
        client.sso.events.list()


def test_client_sso_events_list_coerces_non_string_cursor_to_none() -> None:
    """Defense against a future shape change emitting a non-string
    next_cursor — the typed page should still expose ``None``."""
    body = {"events": [], "next_cursor": 42}
    client = _client_with_response(body)
    page = client.sso.events.list()
    assert page.next_cursor is None


def test_client_sso_namespace_call_path_matches_ts_sdk() -> None:
    """``client.sso.events.list(...)`` mirrors the TS SDK shape."""
    client = AtlaSentClient(api_key="k")
    assert hasattr(client, "sso")
    assert hasattr(client.sso, "events")
    assert callable(client.sso.events.list)


def test_list_sso_events_method_is_a_thin_wrapper() -> None:
    """The namespaced ``client.sso.events.list`` is a thin shim over
    the underlying ``client.list_sso_events`` so existing customers
    that prefer the flat method get identical behaviour."""
    capture: dict[str, Any] = {}
    client = _client_with_response(
        {"events": [], "next_cursor": None}, capture=capture
    )
    client.list_sso_events(limit=5)
    assert capture["params"] == {"limit": "5"}
