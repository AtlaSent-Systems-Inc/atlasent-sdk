"""Financial Quorum — priority 3.

Mirrors ``atlasent-sdk/typescript/src/financialQuorum.ts``.

Key divergences from the legacy ``atlasent.governance.financial_quorum``
in the orchestration repo (which this canonical port supersedes):

- ``FinancialQuorumPolicy`` carries ``amount_thresholds``,
  ``financial_role_requirements``, ``regulator_approval_threshold``, and
  ``dual_release_threshold`` as first-class fields. Migration 004
  (``financial_quorum_policies``) is the schema source of truth.
- ``EmergencyFreeze`` is modeled as a separate record (matching migration
  ``emergency_freezes``); the legacy module had only a per-evaluation flag.
- ``evaluate_financial_quorum`` runs the canonical 5-stage check:
  freeze → base count → amount escalation → financial roles → regulator approval.

Wire-stable as ``financial_quorum.v1``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal

from .financial_action import CurrencyCode, FinancialRiskTier

FreezeScope = Literal["org", "department", "action_class"]


@dataclass(frozen=True)
class FinancialRoleRequirement:
    """A financial role requirement with optional monetary and tier filters."""

    role: str
    min: int
    applies_above: float | None = None
    applies_to_tiers: Sequence[FinancialRiskTier] | None = None


@dataclass(frozen=True)
class AmountThreshold:
    """Amount-based threshold that triggers additional quorum requirements."""

    value: float
    currency: CurrencyCode
    additional_approvals: int
    additional_roles: Sequence[FinancialRoleRequirement] = field(default_factory=tuple)
    senior_review_required: bool = False


@dataclass(frozen=True)
class FinancialQuorumPolicy:
    """Financial quorum policy.

    Extends the base ``QuorumPolicy`` with amount thresholds, financial role
    requirements, regulator approval thresholds, and dual-release thresholds.
    """

    required_count: int
    financial_role_requirements: Sequence[FinancialRoleRequirement]
    amount_thresholds: Sequence[AmountThreshold]
    reference_currency: CurrencyCode = "USD"
    emergency_freeze_active: bool = False
    regulator_approval_threshold: float | None = None
    dual_release_threshold: float | None = None


@dataclass(frozen=True)
class EmergencyFreeze:
    """Emergency freeze record — applied org-wide or per scope.

    Matches migration table ``emergency_freezes``.
    """

    freeze_id: str
    scope_id: str
    scope_type: FreezeScope
    triggered_by: str
    reason: str
    triggered_at: str
    expires_at: str | None = None
    lifted: bool = False
    lifted_at: str | None = None
    lifted_by: str | None = None


@dataclass(frozen=True)
class FinancialQuorumInput:
    """Input to financial quorum evaluation."""

    policy: FinancialQuorumPolicy
    action_value: float
    risk_tier: FinancialRiskTier
    present_roles: dict[str, int]
    approval_count: int
    regulator_approval_present: bool
    base_quorum_proof: dict | None
    active_freezes: Sequence[EmergencyFreeze] = field(default_factory=tuple)


@dataclass(frozen=True)
class FinancialQuorumResult:
    """Result of evaluating a financial quorum."""

    passed: bool
    base_quorum_passed: bool
    amount_threshold_satisfied: bool
    financial_roles_satisfied: bool
    regulator_approval_missing: bool
    blocked_by_freeze: bool
    base_quorum_proof: dict | None
    denial_reason: str | None
    unmet_requirements: Sequence[str]


def evaluate_financial_quorum(input: FinancialQuorumInput) -> FinancialQuorumResult:
    """Evaluate a financial quorum policy.

    Checks in order: emergency freeze → base count → amount thresholds
    → financial roles → regulator approval. Mirrors
    ``evaluateFinancialQuorum`` in TS step-for-step.
    """
    unmet: list[str] = []

    # Hard block: emergency freeze
    active_freeze = next((f for f in input.active_freezes if not f.lifted), None)
    if active_freeze is not None:
        return FinancialQuorumResult(
            passed=False,
            base_quorum_passed=False,
            amount_threshold_satisfied=False,
            financial_roles_satisfied=False,
            regulator_approval_missing=False,
            blocked_by_freeze=True,
            base_quorum_proof=None,
            denial_reason=(
                f"action blocked by emergency freeze ({active_freeze.freeze_id}): "
                f"{active_freeze.reason}"
            ),
            unmet_requirements=(f"emergency_freeze:{active_freeze.freeze_id}",),
        )

    # Base quorum
    base_quorum_passed = (
        input.base_quorum_proof is not None
        or input.approval_count >= input.policy.required_count
    )
    if not base_quorum_passed:
        unmet.append(
            f"base quorum requires {input.policy.required_count} approvals, "
            f"have {input.approval_count}"
        )

    # Amount threshold escalation
    amount_threshold_satisfied = True
    for threshold in input.policy.amount_thresholds:
        if input.action_value >= threshold.value:
            needed = input.policy.required_count + threshold.additional_approvals
            if input.approval_count < needed:
                amount_threshold_satisfied = False
                unmet.append(
                    f"amount threshold {threshold.value} {threshold.currency} "
                    f"requires {needed} approvals"
                )
            for req in threshold.additional_roles:
                present = input.present_roles.get(req.role, 0)
                if present < req.min:
                    amount_threshold_satisfied = False
                    unmet.append(
                        f"amount threshold requires {req.min} {req.role} "
                        f"approver(s), have {present}"
                    )
            if threshold.senior_review_required and not input.present_roles.get(
                "senior_finance", 0
            ):
                amount_threshold_satisfied = False
                unmet.append("amount threshold requires senior_finance review")

    # Financial role requirements
    financial_roles_satisfied = True
    for req in input.policy.financial_role_requirements:
        if (
            req.applies_to_tiers is not None
            and input.risk_tier not in req.applies_to_tiers
        ):
            continue
        if req.applies_above is not None and input.action_value < req.applies_above:
            continue
        present = input.present_roles.get(req.role, 0)
        if present < req.min:
            financial_roles_satisfied = False
            unmet.append(
                f"financial role {req.role} requires {req.min} approver(s), "
                f"have {present}"
            )

    # Regulator approval
    regulator_missing = (
        input.policy.regulator_approval_threshold is not None
        and input.action_value >= input.policy.regulator_approval_threshold
        and not input.regulator_approval_present
    )
    if regulator_missing:
        unmet.append("regulator approval required for this action value")

    passed = (
        base_quorum_passed
        and amount_threshold_satisfied
        and financial_roles_satisfied
        and not regulator_missing
    )

    return FinancialQuorumResult(
        passed=passed,
        base_quorum_passed=base_quorum_passed,
        amount_threshold_satisfied=amount_threshold_satisfied,
        financial_roles_satisfied=financial_roles_satisfied,
        regulator_approval_missing=regulator_missing,
        blocked_by_freeze=False,
        base_quorum_proof=input.base_quorum_proof,
        denial_reason=(
            None
            if passed
            else (unmet[0] if unmet else "financial quorum not satisfied")
        ),
        unmet_requirements=tuple(unmet),
    )


def compute_escalated_approval_count(
    base_count: int,
    action_value: float,
    thresholds: Sequence[AmountThreshold],
) -> int:
    """Determine the escalated minimum approval count for a given action value.

    Returns base count plus the largest ``additional_approvals`` from
    matching thresholds. Mirrors ``computeEscalatedApprovalCount`` in TS.
    """
    additional = 0
    for t in thresholds:
        if action_value >= t.value:
            additional = max(additional, t.additional_approvals)
    return base_count + additional


__all__ = [
    "AmountThreshold",
    "EmergencyFreeze",
    "FinancialQuorumInput",
    "FinancialQuorumPolicy",
    "FinancialQuorumResult",
    "FinancialRoleRequirement",
    "FreezeScope",
    "compute_escalated_approval_count",
    "evaluate_financial_quorum",
]
