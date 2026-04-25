"""Pydantic models for the ``/v1/sso/*`` wire surface.

Source of truth: ``atlasent-api/supabase/functions/v1-sso/handler.ts``
plus the table schemas in
``atlasent-api/supabase/migrations/0041_sso_connections.sql``.

Mirrors :mod:`atlasent.sso` in the TypeScript SDK. Field names are
snake_case because that is what the server emits — the SSO admin
surface returns persisted DB rows verbatim and the SDK does not
translate them into a different convention.

⚠ Upstream sync TODO: these models should ultimately be sourced from
``atlasent-api/packages/types/src/index.ts`` (the canonical
``@atlasent/types`` package). They are mirrored here as a stop-gap
until the upstream PR lands; once the upstream symbols are published
this module should re-export from a single canonical location.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

SsoProtocol = Literal["saml", "oidc"]
"""Identity-provider protocol enum.

Matches the table CHECK ``protocol IN ('saml', 'oidc')`` in
migration 0041. Today the handler ships SAML; OIDC is the planned
second protocol.
"""

SsoCanonicalRole = Literal["owner", "admin", "approver", "member", "viewer"]
"""Roles a JIT rule can grant.

Aligned with ``org_members.role`` via migration 0042. Tracks the
handler's ``CANONICAL_ROLES`` constant (the table CHECK is wider —
``operator`` / ``auditor`` are present but the handler rejects them).
"""

SsoEventType = Literal[
    "login_success",
    "login_denied",
    "jit_provisioned",
    "role_changed",
    "connection_created",
    "connection_updated",
    "connection_deleted",
    "connection_activated",
    "connection_deactivated",
]
"""SSO event-type tags persisted into ``sso_events.event_type``.

Drawn from the table CHECK constraint in
``0041_sso_connections.sql``. The handler emits the connection
lifecycle plus ``login_denied``; the assertion-side tags
(``login_success``, ``jit_provisioned``, ``role_changed``) fire from
the Supabase post-assertion hook.
"""


class SsoConnection(BaseModel):
    """One row from ``sso_connections`` as returned by
    ``GET /v1/sso/connections`` and ``GET /v1/sso/connections/:id``.

    ``metadata_url`` and ``metadata_xml`` are mutually-permissive (the
    table CHECK requires at least one). ``enforce_for_domain`` is
    gated on the org's plan; see the handler's free-tier check.
    """

    id: str
    organization_id: str
    name: str
    protocol: SsoProtocol
    supabase_provider_id: str | None = None
    idp_entity_id: str
    metadata_url: str | None = None
    metadata_xml: str | None = None
    email_domain: str | None = None
    enforce_for_domain: bool = False
    is_active: bool = False
    created_at: str = ""
    updated_at: str = ""
    created_by: str | None = None

    model_config = {"extra": "allow"}


class SsoJitRule(BaseModel):
    """One row from ``sso_jit_provisioning_rules`` as returned by
    ``GET /v1/sso/jit-rules`` (optionally filtered by
    ``connection_id``).

    Matching semantics: the rule fires when
    ``claims[claim_attribute]`` contains ``claim_value`` (membership
    for array-shaped claims, equality for scalars). When multiple rules
    match the lowest ``precedence`` wins; ties broken by row id.
    """

    id: str
    connection_id: str
    organization_id: str
    claim_attribute: str
    claim_value: str
    granted_role: SsoCanonicalRole
    precedence: int = 100
    is_active: bool = True
    created_at: str = ""
    updated_at: str = ""

    model_config = {"extra": "allow"}


class SsoEvent(BaseModel):
    """One row from ``sso_events`` as returned by
    ``GET /v1/sso/events``.

    ``connection_id`` is nullable because a denial can fire before the
    inbound assertion is mapped to a connection. ``actor_email`` is
    nullable for system-actor events.
    """

    id: str
    organization_id: str
    connection_id: str | None = None
    event_type: SsoEventType
    actor_email: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    occurred_at: str = ""

    model_config = {"extra": "allow"}


class SsoEventsPage(BaseModel):
    """Response shape for ``GET /v1/sso/events``.

    ``next_cursor`` is ``None`` when the current page is the last —
    the handler emits ``null`` so callers can write a uniform
    pagination loop.
    """

    events: list[SsoEvent] = Field(default_factory=list)
    next_cursor: str | None = None

    model_config = {"extra": "allow"}
