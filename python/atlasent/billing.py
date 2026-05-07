"""
atlasent.billing
~~~~~~~~~~~~~~~~

Pydantic v2 models for the AtlaSent billing entitlement API, plus a
lightweight ``BillingClient`` for consuming the entitlement endpoints.

Usage::

    from atlasent import AtlaSentClient
    from atlasent.billing import BillingClient

    client = AtlaSentClient(api_key="...")
    billing = BillingClient(client)
    ent = billing.get_entitlement()
    if not ent.has_action("govern"):
        raise PermissionError(f"Governance blocked: {ent.deny_reason}")
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

import httpx
from pydantic import BaseModel, Field, model_validator


# ─── Enumerations ────────────────────────────────────────────────────────────────────────────────

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


# ─── Models ──────────────────────────────────────────────────────────────────────────────────

class BillingEntitlement(BaseModel):
    """Billing entitlement returned by GET /v1/billing/entitlement."""

    org_id:                  str
    access_status:           AccessStatus
    effective_status:        AccessStatus
    allowed_actions:         List[AllowedAction] = Field(default_factory=list)
    deny_reason:             Optional[DenyReason] = None
    warning:                 Optional[str] = None
    grace_until:             Optional[datetime] = None
    billing_mode:            str = "self_serve"
    plan:                    str = "free"
    invoice_status:          str = "none"
    manual_override:         bool = False
    manual_override_status:  Optional[str] = None
    manual_override_reason:  Optional[str] = None
    computed_at:             datetime

    def has_action(self, action: "str | AllowedAction") -> bool:
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
    def _coerce_allowed_actions(cls, values: Dict[str, Any]) -> Dict[str, Any]:
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
    status:     Optional[Literal["active", "grace", "restricted", "suspended"]] = None
    reason:     str = ""
    expires_at: Optional[datetime] = None


class AdminOverrideResponse(BaseModel):
    """Response from POST /v1/billing/admin-override."""

    org_id:              str
    new_status:          Optional[str] = None
    override_active:     bool = False
    override_status:     Optional[str] = None
    override_reason:     Optional[str] = None
    override_expires_at: Optional[datetime] = None


# ─── Client ──────────────────────────────────────────────────────────────────────────────────

class BillingClient:
    """
    Convenience wrapper for the AtlaSent billing entitlement API.

    Requires an ``atlasent.AtlaSentClient`` (or compatible) instance that
    exposes ``._http`` (``httpx.Client``) and ``._base_url`` (str).
    """

    def __init__(self, client: Any) -> None:
        self._client = client

    def get_entitlement(self, org_id: Optional[str] = None) -> BillingEntitlement:
        """Fetch billing entitlement for the authenticated org."""
        params: Dict[str, str] = {}
        if org_id:
            params["org_id"] = org_id
        resp: httpx.Response = self._client._http.get(
            f"{self._client._base_url}/v1/billing/entitlement",
            params=params,
        )
        resp.raise_for_status()
        return BillingEntitlement.model_validate(resp.json())

    def set_override(self, request: AdminOverrideRequest) -> AdminOverrideResponse:
        """Apply or clear a manual billing override (org_owner / super_admin)."""
        resp: httpx.Response = self._client._http.post(
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
