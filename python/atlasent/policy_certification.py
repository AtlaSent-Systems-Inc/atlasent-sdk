"""Policy Certification Lifecycle wire types.

Parity with ``typescript/src/policyCertification.ts``.

Wire surface: ``v1-certifications`` edge function (POST only).
Operations: ``list_policy_versions``, ``create_approval``,
``list_attestations``.

Certification flow::

    1. A policy version is published → ``PolicyVersion`` row created
       with ``status="pending"``.
    2. Designated certifiers submit ``PolicyApproval`` records via
       ``create_approval``.
    3. Once the quorum requirement is met the version transitions to
       ``status="certified"`` and a ``PolicyAttestation`` is recorded.
    4. Attestations are append-only and immutable; read them via
       ``list_attestations``.

Wire-stable as ``policy_certification.v1``.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Literals
# ---------------------------------------------------------------------------

PolicyVersionStatus = Literal[
    "draft",
    "pending",
    "certified",
    "rejected",
    "superseded",
    "archived",
]
"""Lifecycle status of a policy version under certification."""

PolicyApprovalDecision = Literal["approve", "reject"]
"""Vote a certifier may cast on a policy version."""


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class PolicyVersion(BaseModel):
    """A versioned snapshot of an org's policy."""

    version_id: str
    org_id: str
    policy_name: str
    version_number: int
    """Monotonically-increasing integer per ``policy_name``."""
    status: PolicyVersionStatus
    body_hash: str
    """SHA-256 hex of the policy body."""
    submitted_by: str
    submitted_at: str
    certified_at: str | None = None
    """ISO 8601 when the last approval quorum was met; ``None`` while pending."""
    approval_count: int = 0
    approval_quorum: int = 1

    model_config = {"extra": "allow"}


class ListPolicyVersionsResponse(BaseModel):
    """Response for ``list_policy_versions``."""

    versions: list[PolicyVersion] = Field(default_factory=list)
    total: int = 0
    next_cursor: str | None = None

    model_config = {"extra": "allow"}


class PolicyApproval(BaseModel):
    """A single certifier approval record."""

    approval_id: str
    version_id: str
    org_id: str
    approver_id: str
    approver_label: str
    decision: PolicyApprovalDecision
    comment: str | None = None
    created_at: str

    model_config = {"extra": "allow"}


class CreatePolicyApprovalRequest(BaseModel):
    """Request body for ``create_approval``."""

    version_id: str
    approver_id: str
    approver_label: str
    decision: PolicyApprovalDecision
    comment: str | None = None

    model_config = {"extra": "allow"}


class CreatePolicyApprovalResponse(BaseModel):
    """Response for ``create_approval``.

    Contains both the recorded approval and the updated policy version
    (reflects new ``approval_count`` / ``status``).
    """

    approval: PolicyApproval
    version: PolicyVersion

    model_config = {"extra": "allow"}


class PolicyAttestation(BaseModel):
    """Signed attestation record emitted when a version reaches ``certified``.

    Attestations are append-only and immutable.
    """

    attestation_id: str
    version_id: str
    org_id: str
    policy_name: str
    version_number: int
    body_hash: str
    certified_at: str
    approval_chain_hash: str
    """SHA-256 over canonical JSON of the approval records."""
    approver_ids: list[str] = Field(default_factory=list)
    """Ordered list of approver IDs whose votes satisfied the quorum."""

    model_config = {"extra": "allow"}


class ListPolicyAttestationsResponse(BaseModel):
    """Response for ``list_attestations``."""

    attestations: list[PolicyAttestation] = Field(default_factory=list)
    total: int = 0
    next_cursor: str | None = None

    model_config = {"extra": "allow"}


__all__ = [
    "CreatePolicyApprovalRequest",
    "CreatePolicyApprovalResponse",
    "ListPolicyAttestationsResponse",
    "ListPolicyVersionsResponse",
    "PolicyApproval",
    "PolicyApprovalDecision",
    "PolicyAttestation",
    "PolicyVersion",
    "PolicyVersionStatus",
]
