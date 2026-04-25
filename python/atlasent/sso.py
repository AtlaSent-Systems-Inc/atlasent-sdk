"""SSO wire types — mirrors the v1-sso edge function in atlasent-api.

These are READ-ONLY contract types. SSO administration lives behind
the org-admin role in the console; the SDK exposes the types so
downstream tooling (e.g. SCIM importers, IdP-side validators) can
deserialize the API responses with confidence.

Source of truth: ``supabase/functions/v1-sso/handler.ts`` and
``supabase/migrations/0041_sso_connections.sql`` in atlasent-api.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SsoProtocol = Literal["saml", "oidc"]
SsoStatus = Literal["active", "inactive", "deleted"]
SsoOperator = Literal["equals", "contains", "regex", "in"]
SsoOutcome = Literal[
    "login_success",
    "login_denied",
    "error",
    "connection_changed",
]


class SsoConnection(BaseModel):
    """One SAML or OIDC connection.

    ``client_secret`` is intentionally absent — it is write-only and
    never returned by the API.
    """

    model_config = ConfigDict(extra="allow")

    id: str
    organization_id: str
    name: str
    protocol: SsoProtocol
    is_active: bool
    status: SsoStatus
    metadata_url: str | None = None
    entity_id: str | None = None
    sp_entity_id: str | None = None
    acs_url: str | None = None
    issuer: str | None = None
    client_id: str | None = None
    domains: list[str] = Field(default_factory=list)
    enforce_for_domain: bool = False
    default_role: str | None = None
    created_at: str
    updated_at: str


class SsoJitRule(BaseModel):
    """One JIT (just-in-time) provisioning rule.

    Rules are evaluated in ascending ``precedence`` order; the first
    match wins. No-match falls through to the connection's
    ``default_role`` (or fail-closed when no default is set).
    """

    model_config = ConfigDict(extra="allow")

    id: str
    connection_id: str
    organization_id: str
    claim_path: str
    operator: SsoOperator
    value: str | list[str]
    granted_role: str
    precedence: int
    created_at: str
    updated_at: str


class SsoEvent(BaseModel):
    """A single login attempt recorded by the post-assertion hook.

    ``sso_events`` has bounded retention — ``audit_events`` carries
    the immutable evidence copy that enters the Ed25519-signed export.
    """

    model_config = ConfigDict(extra="allow")

    id: str
    organization_id: str
    connection_id: str | None = None
    occurred_at: str
    outcome: SsoOutcome
    user_id: str | None = None
    email: str | None = None
    claims: dict[str, object] | None = None
    matched_rule_id: str | None = None
    granted_role: str | None = None
    error_code: str | None = None
    ip: str | None = None
    user_agent: str | None = None


__all__ = [
    "SsoConnection",
    "SsoJitRule",
    "SsoEvent",
    "SsoProtocol",
    "SsoStatus",
    "SsoOperator",
    "SsoOutcome",
]
