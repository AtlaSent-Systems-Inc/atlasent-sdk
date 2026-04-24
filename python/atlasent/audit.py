"""Models for the ``/v1-audit/*`` wire surface.

Source of truth: ``atlasent-api/supabase/functions/v1-audit/index.ts``
(the edge function that serves ``GET /v1-audit/events``,
``POST /v1-audit/exports``, and ``POST /v1-audit/verify``).

Fields are snake_case because that is what the server emits on the
wire — unlike the ``evaluate`` / ``verify-permit`` models in
``models.py``, which rename e.g. ``permitted`` → ``decision`` via
pydantic aliases, the audit surface is intentionally wire-identical so
that signed export bundles round-trip byte-for-byte through the
offline verifier in ``atlasent.audit_bundle``.

``AuditEvent`` and ``AuditEventsResult`` use ``extra="allow"`` so
forward-compatible additions on the server don't trip validation.
``AuditExportResult`` is deliberately a wrapper around the raw
server dict (``bundle``) so re-serialization can't silently reorder
event fields and break signature verification.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, Field

from .models import RateLimitState

AuditDecision = Literal["allow", "deny", "hold", "escalate"]
"""Policy decision enum used on ``audit_events.decision``."""

AuditExportSignatureStatus = Literal["signed", "unsigned", "signing_failed"]
"""Signing status reported on an export bundle.

``"signed"`` is the normal path; ``"unsigned"`` means the deployment
has no active signing key; ``"signing_failed"`` means a key is
configured but signing errored and the export was returned anyway
(the signature is an empty string).
"""


class AuditEvent(BaseModel):
    """One persisted row from ``audit_events``.

    Returned by ``GET /v1-audit/events`` and embedded inside
    :class:`AuditExportResult.bundle`. ``decision`` is nullable because
    not every event is an evaluation — CRUD-style audit writes (e.g.
    ``policy.updated``) omit it. All other nullable fields follow the
    same "field doesn't apply to this event type" convention rather
    than "unknown value".
    """

    id: str
    org_id: str
    sequence: int
    type: str
    decision: AuditDecision | None = None
    actor_id: str | None = None
    resource_type: str | None = None
    resource_id: str | None = None
    payload: dict[str, Any] | None = None
    hash: str
    previous_hash: str
    occurred_at: str = ""
    created_at: str = ""

    model_config = {"extra": "allow"}


class AuditEventsResult(BaseModel):
    """Response shape for ``GET /v1-audit/events``.

    ``total`` is the filter's full count (not just this page) so callers
    can show "page 1 of N" without an extra HEAD request.

    ``next_cursor`` is an opaque string. Pass it back verbatim as
    ``cursor=...`` to fetch the next page. ``None`` when this is the
    last page.

    ``rate_limit`` is attached by the SDK from the response headers
    and is not part of the server's JSON body.
    """

    events: list[AuditEvent] = Field(default_factory=list)
    total: int = 0
    next_cursor: str | None = None
    rate_limit: RateLimitState | None = None

    model_config = {"extra": "allow", "arbitrary_types_allowed": True}


@dataclass
class AuditExportResult:
    """Signed audit-export bundle returned by ``POST /v1-audit/exports``.

    The :attr:`bundle` attribute holds the raw server JSON verbatim —
    pass it straight to :func:`atlasent.verify_audit_bundle`::

        result = client.create_audit_export()
        outcome = atlasent.verify_audit_bundle(result.bundle, keys)

    Re-serializing through a pydantic model would be risky because
    ``signed_bytes_for`` depends on event-field insertion order, so
    the bundle is kept as the original ``dict``. Convenience
    properties below read from that dict; they don't shadow it.
    """

    bundle: dict[str, Any]
    rate_limit: RateLimitState | None = None

    @property
    def export_id(self) -> str:
        """Server-assigned UUID for this export."""
        value = self.bundle.get("export_id")
        return value if isinstance(value, str) else ""

    @property
    def org_id(self) -> str:
        """Organization the bundle belongs to."""
        value = self.bundle.get("org_id")
        return value if isinstance(value, str) else ""

    @property
    def events(self) -> list[dict[str, Any]]:
        """Events in canonical (ascending sequence) order."""
        value = self.bundle.get("events")
        return value if isinstance(value, list) else []

    @property
    def chain_head_hash(self) -> str:
        """Last event's ``hash``, or ``"0"*64`` if the bundle is empty."""
        value = self.bundle.get("chain_head_hash")
        return value if isinstance(value, str) else ""

    @property
    def chain_integrity_ok(self) -> bool:
        """``True`` iff adjacency + re-hash succeeded for every event."""
        value = self.bundle.get("chain_integrity_ok")
        return bool(value)

    @property
    def tampered_event_ids(self) -> list[str]:
        """Event ids whose recomputed hash didn't match the stored hash."""
        value = self.bundle.get("tampered_event_ids")
        return value if isinstance(value, list) else []

    @property
    def signature(self) -> str:
        """Detached Ed25519 signature (base64url). ``""`` on sign failure."""
        value = self.bundle.get("signature")
        return value if isinstance(value, str) else ""

    @property
    def signature_status(self) -> AuditExportSignatureStatus:
        """Outcome of the signing attempt."""
        value = self.bundle.get("signature_status")
        if value in ("signed", "unsigned", "signing_failed"):
            return value  # type: ignore[return-value]
        return "unsigned"

    @property
    def signing_key_id(self) -> str | None:
        """Registry id of the key that signed — ``None`` when unsigned."""
        value = self.bundle.get("signing_key_id")
        return value if isinstance(value, str) else None

    @property
    def signed_at(self) -> str:
        """ISO 8601 timestamp of signing."""
        value = self.bundle.get("signed_at")
        return value if isinstance(value, str) else ""

    @property
    def event_count(self) -> int:
        """Length of the signed ``events`` array."""
        value = self.bundle.get("event_count")
        return value if isinstance(value, int) else len(self.events)
