"""Federated Org Trust wire types.

Parity with ``typescript/src/federation.ts``.

Wire surface: ``v1-federation`` edge function.
Operations:
  - ``list_federated_orgs``, ``register_federated_org``
  - ``activate_trust``, ``suspend_trust``, ``revoke_trust``
  - ``list_observer_grants``, ``create_observer_grant``,
    ``revoke_observer_grant``
  - ``list_federated_approvals``, ``submit_federated_approval``

Federation model::

    1. A “home” org registers a “peer” org via ``register_federated_org``.
    2. Trust transitions: pending → active → suspended | revoked.
    3. Optionally the home org grants peer principals observer access.
    4. High-risk actions may require a peer org’s cross-org sign-off
       (``FederatedApproval`` workflow).

Wire-stable as ``federation.v1``.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Literals
# ---------------------------------------------------------------------------

FederationTrustStatus = Literal["pending", "active", "suspended", "revoked"]
"""Lifecycle state of a federated trust relationship."""

ObserverAccessScope = Literal[
    "audit_events",
    "governance_graph",
    "financial_executions",
    "compliance_runs",
]
"""Scope of observer access granted to a peer principal."""

FederatedApprovalStatus = Literal[
    "pending",
    "approved",
    "rejected",
    "expired",
    "cancelled",
]
"""Status of a cross-org approval request."""


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class FederatedOrg(BaseModel):
    """A registered federated org relationship."""

    federation_id: str
    home_org_id: str
    peer_org_id: str
    peer_org_label: str
    trust_status: FederationTrustStatus
    registered_by: str
    registered_at: str
    activated_at: str | None = None
    suspended_at: str | None = None
    revoked_at: str | None = None
    revoke_reason: str | None = None
    include_in_quorum: bool = False
    """When ``True``, peer decisions count toward home-org quorum."""

    model_config = {"extra": "allow"}


class ListFederatedOrgsResponse(BaseModel):
    """Response for ``list_federated_orgs``."""

    orgs: list[FederatedOrg] = Field(default_factory=list)
    total: int = 0
    next_cursor: str | None = None

    model_config = {"extra": "allow"}


class RegisterFederatedOrgRequest(BaseModel):
    """Request body for ``register_federated_org``."""

    peer_org_id: str
    peer_org_label: str
    include_in_quorum: bool = False

    model_config = {"extra": "allow"}


class RegisterFederatedOrgResponse(BaseModel):
    """Response for ``register_federated_org``."""

    org: FederatedOrg

    model_config = {"extra": "allow"}


class UpdateFederationTrustResponse(BaseModel):
    """Response for ``activate_trust``, ``suspend_trust``, ``revoke_trust``."""

    org: FederatedOrg

    model_config = {"extra": "allow"}


class ObserverGrant(BaseModel):
    """An observer grant allowing a peer principal to read home-org data."""

    observer_grant_id: str
    federation_id: str
    home_org_id: str
    peer_org_id: str
    observer_principal: str
    """Principal in the peer org receiving observer access."""
    observer_label: str
    scopes: list[ObserverAccessScope]
    active: bool = True
    created_by: str
    created_at: str
    revoked_at: str | None = None
    revoke_reason: str | None = None

    model_config = {"extra": "allow"}


class ListObserverGrantsResponse(BaseModel):
    """Response for ``list_observer_grants``."""

    grants: list[ObserverGrant] = Field(default_factory=list)
    total: int = 0
    next_cursor: str | None = None

    model_config = {"extra": "allow"}


class CreateObserverGrantRequest(BaseModel):
    """Request body for ``create_observer_grant``."""

    federation_id: str
    observer_principal: str
    observer_label: str
    scopes: list[ObserverAccessScope]

    model_config = {"extra": "allow"}


class CreateObserverGrantResponse(BaseModel):
    """Response for ``create_observer_grant``."""

    grant: ObserverGrant

    model_config = {"extra": "allow"}


class RevokeObserverGrantResponse(BaseModel):
    """Response for ``revoke_observer_grant``."""

    grant: ObserverGrant

    model_config = {"extra": "allow"}


class FederatedApproval(BaseModel):
    """A cross-org approval request requiring a peer org’s sign-off."""

    approval_id: str
    federation_id: str
    home_org_id: str
    peer_org_id: str
    subject_type: str
    """The kind of thing requiring peer approval, e.g. ``\"financial_execution\"``."""
    subject_id: str
    subject_label: str
    status: FederatedApprovalStatus
    requested_by: str
    requested_at: str
    expires_at: str | None = None
    decided_by: str | None = None
    decided_at: str | None = None
    peer_decision: Literal["approve", "reject"] | None = None
    peer_comment: str | None = None

    model_config = {"extra": "allow"}


class ListFederatedApprovalsResponse(BaseModel):
    """Response for ``list_federated_approvals``."""

    approvals: list[FederatedApproval] = Field(default_factory=list)
    total: int = 0
    next_cursor: str | None = None

    model_config = {"extra": "allow"}


class SubmitFederatedApprovalRequest(BaseModel):
    """Request body for ``submit_federated_approval``."""

    peer_decision: Literal["approve", "reject"]
    decided_by: str
    peer_comment: str | None = None

    model_config = {"extra": "allow"}


class SubmitFederatedApprovalResponse(BaseModel):
    """Response for ``submit_federated_approval``."""

    approval: FederatedApproval

    model_config = {"extra": "allow"}


__all__ = [
    "CreateObserverGrantRequest",
    "CreateObserverGrantResponse",
    "FederatedApproval",
    "FederatedApprovalStatus",
    "FederatedOrg",
    "FederationTrustStatus",
    "ListFederatedApprovalsResponse",
    "ListFederatedOrgsResponse",
    "ListObserverGrantsResponse",
    "ObserverAccessScope",
    "ObserverGrant",
    "RegisterFederatedOrgRequest",
    "RegisterFederatedOrgResponse",
    "RevokeObserverGrantResponse",
    "SubmitFederatedApprovalRequest",
    "SubmitFederatedApprovalResponse",
    "UpdateFederationTrustResponse",
]
