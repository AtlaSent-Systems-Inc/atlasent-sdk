"""v2 Pillar 3 — Decision-event types.

Python sibling of
``typescript/packages/v2-preview/src/decisionEvent.ts``. Pydantic
models + a discriminated union that mirrors
``contract/schemas/v2/decision-event.schema.json``.

Each event the server emits on ``GET /v2/decisions:subscribe`` is one
of seven types. ``parse_decision_event_stream()`` returns these as
typed ``DecisionEvent`` objects; consumers branch on
``event.type`` to narrow the payload::

    async for ev in parse_decision_event_stream(httpx_response):
        if isinstance(ev, ConsumedEvent):
            # ev.payload typed as ConsumedPayload here
            ...

Forward compatibility: schema-side ``payload`` is
``additionalProperties: true`` so unknown fields on a known event
type pass through. :class:`UnknownDecisionEvent` catches event
types the SDK doesn't recognize at all so future server emissions
don't crash older clients.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# ── Per-event-type payload models ────────────────────────────────────


class PermitIssuedPayload(BaseModel):
    decision: Literal["allow", "deny", "hold", "escalate"]
    agent: str
    action: str
    audit_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    reason: str = ""

    model_config = {"extra": "allow"}


class VerifiedPayload(BaseModel):
    permit_hash: str
    outcome: str

    model_config = {"extra": "allow"}


class ConsumedPayload(BaseModel):
    proof_id: str
    execution_status: Literal["executed", "failed"]
    audit_hash: str = Field(pattern=r"^[0-9a-f]{64}$")

    model_config = {"extra": "allow"}


class RevokedPayload(BaseModel):
    reason: str
    revoker_id: str | None
    """``None`` when the system auto-revoked on TTL."""

    model_config = {"extra": "allow"}


class EscalatedPayload(BaseModel):
    to: str
    """Escalation queue / approver group identifier."""

    reason: str

    model_config = {"extra": "allow"}


class HoldResolvedPayload(BaseModel):
    resolution: Literal["approved", "denied", "expired"]
    resolved_by: str | None

    model_config = {"extra": "allow"}


class RateLimitStatePayload(BaseModel):
    limit: int = Field(ge=0)
    remaining: int = Field(ge=0)
    reset_at: int | str
    """Either unix-seconds integer or ISO 8601 string."""

    model_config = {"extra": "allow"}


# ── Per-event types ───────────────────────────────────────────────────


class _DecisionEventBase(BaseModel):
    """Common fields every DecisionEvent carries."""

    id: str
    """Monotonic per-org event id. SSE Last-Event-ID resume token."""

    org_id: str
    emitted_at: str
    permit_id: str | None = None
    """Decision id this event relates to. ``None`` on rate_limit_state."""

    actor_id: str | None = None

    model_config = {"extra": "allow"}


class PermitIssuedEvent(_DecisionEventBase):
    type: Literal["permit_issued"]
    payload: PermitIssuedPayload


class VerifiedEvent(_DecisionEventBase):
    type: Literal["verified"]
    payload: VerifiedPayload


class ConsumedEvent(_DecisionEventBase):
    type: Literal["consumed"]
    payload: ConsumedPayload


class RevokedEvent(_DecisionEventBase):
    type: Literal["revoked"]
    payload: RevokedPayload


class EscalatedEvent(_DecisionEventBase):
    type: Literal["escalated"]
    payload: EscalatedPayload


class HoldResolvedEvent(_DecisionEventBase):
    type: Literal["hold_resolved"]
    payload: HoldResolvedPayload


class RateLimitStateEvent(_DecisionEventBase):
    type: Literal["rate_limit_state"]
    payload: RateLimitStatePayload


class UnknownDecisionEvent(_DecisionEventBase):
    """Server emitted an event type this SDK doesn't recognize.

    Surface the raw payload as opaque data rather than dropping the
    event — lets callers log / forward unknown lifecycle states
    without an SDK upgrade.
    """

    type: str
    payload: dict[str, Any] = Field(default_factory=dict)


# ── Discriminated union ──────────────────────────────────────────────

DecisionEvent = (
    PermitIssuedEvent
    | VerifiedEvent
    | ConsumedEvent
    | RevokedEvent
    | EscalatedEvent
    | HoldResolvedEvent
    | RateLimitStateEvent
    | UnknownDecisionEvent
)
"""Type alias for any DecisionEvent variant.

Use ``isinstance(ev, ConsumedEvent)`` to narrow.
"""


KNOWN_DECISION_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "permit_issued",
        "verified",
        "consumed",
        "revoked",
        "escalated",
        "hold_resolved",
        "rate_limit_state",
    }
)


_TYPE_TO_CLASS: dict[str, type[_DecisionEventBase]] = {
    "permit_issued": PermitIssuedEvent,
    "verified": VerifiedEvent,
    "consumed": ConsumedEvent,
    "revoked": RevokedEvent,
    "escalated": EscalatedEvent,
    "hold_resolved": HoldResolvedEvent,
    "rate_limit_state": RateLimitStateEvent,
}


def build_decision_event(
    obj: dict[str, Any],
    fallback_type: str = "message",
    fallback_id: str | None = None,
) -> DecisionEvent:  # type: ignore[valid-type]
    """Construct the right DecisionEvent variant from a parsed JSON dict.

    JSON body wins over SSE field-line on ``id`` / ``type`` conflict
    — the schema is the wire law. Falls through to
    :class:`UnknownDecisionEvent` for unrecognized types.
    """
    body = dict(obj)
    if not isinstance(body.get("id"), str):
        body["id"] = fallback_id or ""
    if not isinstance(body.get("type"), str):
        body["type"] = fallback_type

    event_type = body["type"]
    cls = _TYPE_TO_CLASS.get(event_type, UnknownDecisionEvent)
    if cls is UnknownDecisionEvent and not isinstance(body.get("payload"), dict):
        body["payload"] = {}
    return cls.model_validate(body)
