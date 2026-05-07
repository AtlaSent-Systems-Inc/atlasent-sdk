"""Governance and enforcement webhook types and signature verification.

Parity with ``typescript/src/governanceWebhooks.ts``.

Covers two webhook surfaces:

- ``/v1/governance-webhooks`` — governance-layer events (policy
  violations, runtime anomalies, HITL decisions, audit chain entries,
  billing state changes).
- ``/v1/enforcement-webhooks`` — real-time enforcement decision events
  (blocked actions, pending approvals, approvals/rejections).

Both surfaces use the same HMAC-SHA256 signing scheme.  Use
:func:`verify_webhook_signature` to authenticate incoming deliveries
before processing their payloads.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Event type literals
# ---------------------------------------------------------------------------

GovernanceWebhookEvent = Literal[
    "policy.violation",
    "policy.updated",
    "runtime.anomaly",
    "runtime.chain_broken",
    "hitl.decision",
    "hitl.timeout",
    "audit.chain_entry",
    "billing.grace_period_started",
    "billing.access_restricted",
]
"""Event types deliverable via ``/v1/governance-webhooks``."""

EnforcementWebhookEvent = Literal[
    "enforcement.blocked",
    "enforcement.pending_approval",
    "enforcement.approved",
    "enforcement.rejected",
    "enforcement.error",
]
"""Event types deliverable via ``/v1/enforcement-webhooks``."""

WebhookDeliveryStatus = Literal["pending", "delivered", "failed", "retrying"]

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class WebhookSubscription(BaseModel):
    """A registered webhook subscription returned by the API."""

    id: str
    org_id: str
    url: str
    events: list[str]
    enabled: bool = True
    description: str | None = None
    created_at: str = ""

    model_config = {"extra": "allow"}


class WebhookDelivery(BaseModel):
    """One delivery attempt record for a webhook subscription."""

    id: str
    subscription_id: str
    event_type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    status: WebhookDeliveryStatus
    response_status: int | None = None
    response_body: str | None = None
    attempt_count: int = 1
    created_at: str = ""
    delivered_at: str | None = None

    model_config = {"extra": "allow"}


T = TypeVar("T")


class WebhookPayload(BaseModel, Generic[T]):
    """Envelope for every webhook delivery body.

    The ``data`` field contains the event-specific payload.  Its shape
    varies by ``event_type``; callers should validate it against the
    appropriate model for the event they are handling.
    """

    id: str
    org_id: str
    event_type: str
    source_id: str | None = None
    data: Any = None
    created_at: str = ""

    model_config = {"extra": "allow"}


# ---------------------------------------------------------------------------
# Signature verification
# ---------------------------------------------------------------------------


def verify_webhook_signature(
    payload: bytes | str,
    signature: str,
    secret: str,
) -> bool:
    """Verify the HMAC-SHA256 signature on an incoming webhook delivery.

    The ``X-AtlaSent-Signature`` header value has the form
    ``sha256=<hex-digest>``.  This function computes the expected
    HMAC-SHA256 over the **raw request body bytes** using *secret* and
    compares with *signature* using a constant-time comparison to
    prevent timing attacks.

    Parameters
    ----------
    payload:
        Raw request body.  Pass the bytes *before* any JSON parsing —
        parsing may change whitespace and break the signature.
    signature:
        Value of the ``X-AtlaSent-Signature`` header, e.g.
        ``"sha256=abc123..."``.
    secret:
        The ``signing_secret`` returned when the subscription was
        created.  Store it as an environment variable and never log it.

    Returns
    -------
    bool
        ``True`` when the signature is valid, ``False`` otherwise.
        **Always reject the payload when this returns** ``False``.

    Examples
    --------
    FastAPI::

        from fastapi import FastAPI, Request, HTTPException
        from atlasent import verify_webhook_signature

        @app.post("/webhooks/atlasent")
        async def handle(request: Request):
            raw = await request.body()
            sig = request.headers.get("x-atlasent-signature", "")
            if not verify_webhook_signature(raw, sig, WEBHOOK_SECRET):
                raise HTTPException(401, "Invalid signature")
            ...
    """
    body_bytes: bytes = (
        payload if isinstance(payload, bytes) else payload.encode("utf-8")
    )
    secret_bytes: bytes = (
        secret if isinstance(secret, bytes) else secret.encode("utf-8")
    )

    expected_hex = hmac.new(secret_bytes, body_bytes, hashlib.sha256).hexdigest()
    expected = f"sha256={expected_hex}"

    # Strip the "sha256=" prefix from the received value for comparison.
    # hmac.compare_digest requires both operands to be the same type.
    return hmac.compare_digest(
        expected.encode("utf-8"),
        signature.encode("utf-8"),
    )
