"""Auditor Portal — external access grants wire types.

Parity with ``typescript/src/auditorAccess.ts``.

Wire surface: ``v1-auditor-access`` edge function.
Operations: ``list_grants``, ``create_grant``, ``revoke_grant``,
``list_access_events``.

Every grant is scoped to an org + auditor principal.  The server
enforces that only org admins may create/revoke grants; auditors may
only list the events accessible to them.

Wire-stable as ``auditor_access.v1``.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Literals
# ---------------------------------------------------------------------------

AuditorGrantStatus = Literal["active", "revoked", "expired"]
"""Lifecycle status of an auditor access grant."""

AuditorAccessScope = Literal[
    "audit_events",
    "policy_versions",
    "financial_executions",
    "liability_records",
    "compliance_runs",
]
"""What data the grant permits the auditor to read."""


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class AuditorAccessGrant(BaseModel):
    """A single auditor access grant stored in ``auditor_access_grants``.

    Grants are immutable after creation except for ``status`` and the
    ``revoked_*`` fields.
    """

    grant_id: str
    org_id: str
    auditor_principal: str
    """Stable identifier for the external auditor (email or SSO subject)."""
    auditor_label: str
    """Human-readable label for audit logs."""
    scopes: list[AuditorAccessScope]
    status: AuditorGrantStatus
    expires_at: Optional[str] = None
    """ISO 8601 — grant expires at this time; ``None`` means no expiry."""
    created_by: str
    created_at: str
    revoked_at: Optional[str] = None
    revoked_by: Optional[str] = None
    revoke_reason: Optional[str] = None

    model_config = {"extra": "allow"}


class ListAuditorGrantsResponse(BaseModel):
    """Response for ``list_grants``."""

    grants: list[AuditorAccessGrant] = Field(default_factory=list)
    total: int = 0
    next_cursor: Optional[str] = None

    model_config = {"extra": "allow"}


class CreateAuditorGrantRequest(BaseModel):
    """Request body for ``create_grant``."""

    auditor_principal: str
    """Stable identifier (email or SSO subject) for the external auditor."""
    auditor_label: str
    """Human-readable label shown in audit logs."""
    scopes: list[AuditorAccessScope]
    """At least one scope must be supplied."""
    expires_at: Optional[str] = None
    """ISO 8601 — omit for a non-expiring grant."""

    model_config = {"extra": "allow"}


class CreateAuditorGrantResponse(BaseModel):
    """Response for ``create_grant``."""

    grant: AuditorAccessGrant

    model_config = {"extra": "allow"}


class RevokeAuditorGrantResponse(BaseModel):
    """Response for ``revoke_grant``."""

    grant: AuditorAccessGrant

    model_config = {"extra": "allow"}


class AuditorAccessEvent(BaseModel):
    """One event in the auditor access event stream."""

    event_id: str
    grant_id: str
    org_id: str
    auditor_principal: str
    action: str
    """Action the auditor performed, e.g. ``\"read_audit_events\"``."""
    resource_type: Optional[str] = None
    resource_id: Optional[str] = None
    occurred_at: str

    model_config = {"extra": "allow"}


class ListAuditorAccessEventsResponse(BaseModel):
    """Response for ``list_access_events``."""

    events: list[AuditorAccessEvent] = Field(default_factory=list)
    total: int = 0
    next_cursor: Optional[str] = None

    model_config = {"extra": "allow"}


__all__ = [
    "AuditorAccessEvent",
    "AuditorAccessGrant",
    "AuditorAccessScope",
    "AuditorGrantStatus",
    "CreateAuditorGrantRequest",
    "CreateAuditorGrantResponse",
    "ListAuditorAccessEventsResponse",
    "ListAuditorGrantsResponse",
    "RevokeAuditorGrantResponse",
]
