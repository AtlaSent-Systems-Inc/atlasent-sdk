"""
atlasent.billing
~~~~~~~~~~~~~~~~

Pydantic v2 models for the AtlaSent billing entitlement API, plus
:class:`BillingClient` (sync) and :class:`AsyncBillingClient` (async)
for consuming the entitlement endpoints.

Usage (sync)::

    from atlasent import AtlaSentClient
    from atlasent.billing import BillingClient

    client = AtlaSentClient(api_key="...")
    billing = BillingClient(client)
    ent = billing.get_entitlement()
    if not ent.has_action("govern"):
        raise PermissionError(f"Governance blocked: {ent.deny_reason}")

Usage (async)::

    from atlasent import AsyncAtlaSentClient
    from atlasent.billing import AsyncBillingClient

    async_client = AsyncAtlaSentClient(api_key="...")
    billing = AsyncBillingClient(async_client)
    ent = await billing.get_entitlement()
"""

from __future__ import annotations

import hashlib
import hmac
from datetime import datetime
from enum import Enum
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field, model_validator


# ─── Enumerations ──────────────────────────────────────────────────────────────────────────────────────

class AccessStatus(str, Enum):
    active     = "active"
    grace      = "grace"
    restricted = "restricted"
    suspended  = "suspended"


class BillingMode(str, Enum):
    self_serve      = "self_serve"
    invoice         = "invoice"
    manual_contract = "manual_contract"


class InvoiceStatus(str, Enum):
    none          = "none"
    draft         = "draft"
    open          = "open"
    paid          = "paid"
    overdue       = "overdue"
    void          = "void"
    uncollectible = "uncollectible"


class DenyReason(str, Enum):
    billing_suspended        = "billing_suspended"
    billing_restricted       = "billing_restricted"
    billing_grace_period     = "billing_grace_period"
    billing_contract_expired = "billing_contract_expired"
    billing_manual_override  = "billing_manual_override"
    billing_unknown_state    = "billing_unknown_state"


class AllowedAction(str, Enum):
    govern             = "govern"
    evaluate           = "evaluate"
    audit              = "audit"
    audit_export_legal = "audit_export_legal"
    billing_manage     = "billing_manage"
    seat_add           = "seat_add"
    plan_upgrade       = "plan_upgrade"
    noncritical_export = "noncritical_export"
    api_access         = "api_access"
    governance_read    = "governance_read"


# ─── Models ────────────────────────────────────────────────────────────────────────────────────────────

class BillingEntitlement(BaseModel):
    """Billing entitlement returned by GET /v1/billing/entitlement."""

    org_id:                  str
    access_status:           AccessStatus
    effective_status:        AccessStatus
    allowed_actions:         list[AllowedAction] = Field(default_factory=list)
    deny_reason:             DenyReason | None = None
    warning:                 str | None = None
    grace_until:             datetime | None = None
    billing_mode:            str = "self_serve"
    plan:                    str = "free"
    invoice_status:          str = "none"
    manual_override:         bool = False
    manual_override_status:  str | None = None
    manual_override_reason:  str | None = None
    computed_at:             datetime

    def has_action(self, action: str | AllowedAction) -> bool:
        """Return True if the given action is permitted under current entitlement."""
        try:
            key = action if isinstance(action, AllowedAction) else AllowedAction(action)
        except ValueError:
            return False
        return key in self.allowed_actions

    def is_active(self) -> bool:
        return self.access_status == AccessStatus.active

    def is_blocked(self) -> bool:
        return self.access_status == AccessStatus.suspended

    @model_validator(mode="before")
    @classmethod
    def _coerce_allowed_actions(cls, values: dict[str, Any]) -> dict[str, Any]:
        actions = values.get("allowed_actions", [])
        coerced = []
        for a in actions:
            try:
                coerced.append(a if isinstance(a, AllowedAction) else AllowedAction(a))
            except ValueError:
                pass
        values["allowed_actions"] = coerced
        return values


class AdminOverrideRequest(BaseModel):
    """Body for POST /v1/billing/admin-override."""

    org_id:     str
    status:     Literal["active", "grace", "restricted", "suspended"] | None = None
    reason:     str = ""
    expires_at: datetime | None = None


class AdminOverrideResponse(BaseModel):
    """Response from POST /v1/billing/admin-override."""

    org_id:              str
    new_status:          str | None = None
    override_active:     bool = False
    override_status:     str | None = None
    override_reason:     str | None = None
    override_expires_at: datetime | None = None


class BillingWebhookSubscription(BaseModel):
    """A billing webhook subscription as returned by GET/POST /v1/billing/webhooks."""

    id:         str
    org_id:     str
    url:        str
    events:     list[str]
    active:     bool = True
    created_at: datetime
    updated_at: datetime | None = None
    secret:     str | None = None  # only present on initial creation response


# ─── Signature verification ──────────────────────────────────────────────────────────────────────

def verify_billing_webhook_signature(
    payload: bytes,
    signature: str,
    secret: str,
) -> bool:
    """Verify the X-AtlaSent-Signature header on a billing.access_changed delivery.

    :param payload:   Raw request body bytes.
    :param signature: Value of the ``X-AtlaSent-Signature`` header (hex digest).
    :param secret:    The webhook secret returned when the subscription was created.
    :returns:         ``True`` if the signature is valid, ``False`` otherwise.
    """
    expected = hmac.new(
        secret.encode("utf-8"),
        payload,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


# ─── Sync client ────────────────────────────────────────────────────────────────────────────────────────

class BillingClient:
    """
    Convenience wrapper for the AtlaSent billing entitlement API (sync).

    Requires an ``atlasent.AtlaSentClient`` (or compatible) instance that
    exposes ``._client`` (``httpx.Client``) and ``._base_url`` (str).
    """

    def __init__(self, client: Any) -> None:
        self._client = client

    def get_entitlement(self, org_id: str | None = None) -> BillingEntitlement:
        """Fetch billing entitlement for the authenticated org."""
        params: dict[str, str] = {}
        if org_id:
            params["org_id"] = org_id
        resp: httpx.Response = self._client._client.get(
            f"{self._client._base_url}/v1/billing/entitlement",
            params=params,
        )
        resp.raise_for_status()
        return BillingEntitlement.model_validate(resp.json())

    def set_override(self, request: AdminOverrideRequest) -> AdminOverrideResponse:
        """Apply or clear a manual billing override (org_owner / super_admin)."""
        resp: httpx.Response = self._client._client.post(
            f"{self._client._base_url}/v1/billing/admin-override",
            json=request.model_dump(mode="json", exclude_none=True),
        )
        resp.raise_for_status()
        return AdminOverrideResponse.model_validate(resp.json())

    def clear_override(
        self, org_id: str, reason: str = "Cleared via SDK"
    ) -> AdminOverrideResponse:
        """Convenience: clear an existing manual override."""
        return self.set_override(
            AdminOverrideRequest(org_id=org_id, status=None, reason=reason)
        )

    def list_webhook_subscriptions(
        self, org_id: str | None = None
    ) -> list[BillingWebhookSubscription]:
        """List billing webhook subscriptions for the authenticated org."""
        params: dict[str, str] = {}
        if org_id:
            params["org_id"] = org_id
        resp: httpx.Response = self._client._client.get(
            f"{self._client._base_url}/v1/billing/webhooks",
            params=params,
        )
        resp.raise_for_status()
        return [
            BillingWebhookSubscription.model_validate(s)
            for s in resp.json().get("subscriptions", [])
        ]

    def create_webhook_subscription(
        self,
        url: str,
        events: list[str],
        org_id: str | None = None,
    ) -> BillingWebhookSubscription:
        """Subscribe an endpoint to one or more billing events.

        :param url:    HTTPS endpoint to receive deliveries.
        :param events: List of event names, e.g. ``["billing.access_changed"]``.
        :param org_id: Override the authenticated org (super-admin only).
        :returns:      The created subscription, including the one-time ``secret``.
        """
        body: dict[str, Any] = {"url": url, "events": events}
        if org_id:
            body["org_id"] = org_id
        resp: httpx.Response = self._client._client.post(
            f"{self._client._base_url}/v1/billing/webhooks",
            json=body,
        )
        resp.raise_for_status()
        return BillingWebhookSubscription.model_validate(resp.json())

    def delete_webhook_subscription(self, subscription_id: str) -> None:
        """Delete a billing webhook subscription by ID."""
        resp: httpx.Response = self._client._client.delete(
            f"{self._client._base_url}/v1/billing/webhooks/{subscription_id}",
        )
        resp.raise_for_status()


# ─── Async client ────────────────────────────────────────────────────────────────────────────────────

class AsyncBillingClient:
    """
    Async variant of :class:`BillingClient` for use with ``AsyncAtlaSentClient``.

    Requires an ``atlasent.AsyncAtlaSentClient`` (or compatible) instance that
    exposes ``._client`` (``httpx.AsyncClient``) and ``._base_url`` (str).

    Example::

        from atlasent import AsyncAtlaSentClient
        from atlasent.billing import AsyncBillingClient, AllowedAction

        async_client = AsyncAtlaSentClient(api_key="...")
        billing = AsyncBillingClient(async_client)

        ent = await billing.get_entitlement()
        if not ent.has_action(AllowedAction.govern):
            raise PermissionError(f"Governance blocked: {ent.deny_reason}")
    """

    def __init__(self, client: Any) -> None:
        self._client = client

    async def get_entitlement(self, org_id: str | None = None) -> BillingEntitlement:
        """Fetch billing entitlement for the authenticated org (async)."""
        params: dict[str, str] = {}
        if org_id:
            params["org_id"] = org_id
        resp: httpx.Response = await self._client._client.get(
            f"{self._client._base_url}/v1/billing/entitlement",
            params=params,
        )
        resp.raise_for_status()
        return BillingEntitlement.model_validate(resp.json())

    async def set_override(self, request: AdminOverrideRequest) -> AdminOverrideResponse:
        """Apply or clear a manual billing override (async)."""
        resp: httpx.Response = await self._client._client.post(
            f"{self._client._base_url}/v1/billing/admin-override",
            json=request.model_dump(mode="json", exclude_none=True),
        )
        resp.raise_for_status()
        return AdminOverrideResponse.model_validate(resp.json())

    async def clear_override(
        self, org_id: str, reason: str = "Cleared via SDK"
    ) -> AdminOverrideResponse:
        """Convenience: clear an existing manual override (async)."""
        return await self.set_override(
            AdminOverrideRequest(org_id=org_id, status=None, reason=reason)
        )

    async def list_webhook_subscriptions(
        self, org_id: str | None = None
    ) -> list[BillingWebhookSubscription]:
        """List billing webhook subscriptions (async)."""
        params: dict[str, str] = {}
        if org_id:
            params["org_id"] = org_id
        resp: httpx.Response = await self._client._client.get(
            f"{self._client._base_url}/v1/billing/webhooks",
            params=params,
        )
        resp.raise_for_status()
        return [
            BillingWebhookSubscription.model_validate(s)
            for s in resp.json().get("subscriptions", [])
        ]

    async def create_webhook_subscription(
        self,
        url: str,
        events: list[str],
        org_id: str | None = None,
    ) -> BillingWebhookSubscription:
        """Subscribe an endpoint to one or more billing events (async)."""
        body: dict[str, Any] = {"url": url, "events": events}
        if org_id:
            body["org_id"] = org_id
        resp: httpx.Response = await self._client._client.post(
            f"{self._client._base_url}/v1/billing/webhooks",
            json=body,
        )
        resp.raise_for_status()
        return BillingWebhookSubscription.model_validate(resp.json())

    async def delete_webhook_subscription(self, subscription_id: str) -> None:
        """Delete a billing webhook subscription by ID (async)."""
        resp: httpx.Response = await self._client._client.delete(
            f"{self._client._base_url}/v1/billing/webhooks/{subscription_id}",
        )
        resp.raise_for_status()
