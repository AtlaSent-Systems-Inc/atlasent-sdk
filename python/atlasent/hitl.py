"""Human-in-the-loop (HITL) types — wire shape for ``/v1/hitl/*``.

Mirrors ``typescript/src/hitl.ts`` and the ``hitl_escalations`` row
shape after atlasent-api migration ``20260507060000``. Treat as
wire-types only: do not embed business logic that the server-side
resolver owns (quorum math, status transitions).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from .models import RateLimitState


HitlQuorumTier = Literal[
    "single_approver",
    "simple_majority",
    "two_thirds",
    "unanimous",
]

HitlStatus = Literal[
    "pending",
    "escalated",
    "approved",
    "rejected",
    "auto_approved",
    "timed_out",
]

HitlFallbackDecision = Literal["reject", "approve"]


class HitlQuorumProgress(BaseModel):
    """Live quorum progress snapshot returned with open escalations."""

    required: int
    approved: int
    rejected: int
    remaining: int
    satisfied: bool
    rejected_terminal: bool

    model_config = ConfigDict(extra="allow")


class HitlEscalation(BaseModel):
    """Wire shape of a hitl_escalations row, post-hardening migration."""

    id: str
    org_id: str
    agent_id: str
    sandbox_run_id: str | None = None
    status: HitlStatus
    escalation_reason: str
    proposed_action: dict[str, Any] = {}
    risk_score: float | None = None
    assigned_to_user_id: str | None = None
    assigned_to_role: str | None = None
    resolved_by: str | None = None
    resolution_note: str | None = None
    auto_approved_reason: str | None = None
    resolved_at: str | None = None
    timeout_at: str | None = None
    created_at: str

    quorum_required: HitlQuorumTier
    min_approvers: int
    approver_pool_size: int
    escalation_depth: int
    max_escalation_depth: int
    fallback_decision: HitlFallbackDecision
    governance_advisory_id: str | None = None
    expired_reason: Literal[
        "sla_expired", "escalation_chain_exhausted", "manual_expire"
    ] | None = None

    quorum_progress: HitlQuorumProgress | None = None

    model_config = ConfigDict(extra="allow")


class HitlApprovalRecord(BaseModel):
    """One row from ``GET /v1/hitl/:id/approvals``."""

    id: str
    user_id: str | None = None
    actor_label: str | None = None
    decision: Literal["approve", "reject"]
    note: str | None = None
    quorum_at_vote: HitlQuorumTier
    created_at: str

    model_config = ConfigDict(extra="allow")


class HitlChainHop(BaseModel):
    """One row from ``GET /v1/hitl/:id/chain``."""

    id: str
    depth: int
    from_user_id: str | None = None
    from_role: str | None = None
    to_user_id: str | None = None
    to_role: str | None = None
    escalated_by: str | None = None
    reason: str | None = None
    created_at: str

    model_config = ConfigDict(extra="allow")


class ListHitlEscalationsResult(BaseModel):
    """Result of :meth:`AtlaSentClient.list_hitl_escalations`."""

    escalations: list[HitlEscalation]
    total: int
    next_cursor: str | None = None
    rate_limit: RateLimitState | None = None


class HitlEscalationResult(BaseModel):
    """Result of single-escalation read or mutation."""

    escalation: HitlEscalation
    rate_limit: RateLimitState | None = None


class HitlApprovalsResult(BaseModel):
    """Result of :meth:`AtlaSentClient.list_hitl_approvals`."""

    approvals: list[HitlApprovalRecord]
    rate_limit: RateLimitState | None = None


class HitlChainResult(BaseModel):
    """Result of :meth:`AtlaSentClient.get_hitl_chain`."""

    chain: list[HitlChainHop]
    rate_limit: RateLimitState | None = None


def hitl_required_approver_count(
    quorum: HitlQuorumTier,
    pool_size: int,
) -> int:
    """Translate a quorum tier and pool size to required approve count.

    Mirrors the canonical ``requiredApproverCount`` in atlasent-api's
    ``_shared/hitl-policy.ts`` and the SQL helper
    ``public.hitl_required_approver_count``. Provided so SDK consumers
    can render local progress hints without a server round-trip; the
    authoritative count is still the server's ``quorum_progress``
    payload.
    """
    n = max(1, int(pool_size)) if pool_size and pool_size >= 1 else 1
    if quorum == "single_approver":
        return 1
    if quorum == "simple_majority":
        return (n // 2) + 1
    if quorum == "two_thirds":
        # ceil(2N/3)
        return -(-(2 * n) // 3)
    if quorum == "unanimous":
        return n
    raise ValueError(f"unknown quorum tier: {quorum}")
