"""Budgetary Governance — priority 4.

Mirrors ``atlasent-sdk/typescript/src/budgetaryGovernance.ts``.

Key divergences from the legacy ``atlasent.governance.budgetary_governance``
in the orchestration repo (which this canonical port supersedes):

- ``BudgetLimit`` carries 7 scope types (``org`` / ``department`` / ``team``
  / ``environment`` / ``action_class`` / ``project`` / ``time_bounded``)
  matching migration ``budget_limits.scope_type`` CHECK constraint.
- ``SpendingConstraint`` is a separate model from limits (matching
  migration ``spending_constraints``); the legacy module conflated the two.
- ``BudgetViolation`` taxonomy has 6 typed violations, not a 4-string enum.
- Soft/hard ratio constants are NOT exposed as policy thresholds; they are
  display thresholds in ``budget_utilization_severity``. Enforcement comes
  from the ``BudgetLimit.enforcement`` field (``'hard'`` or ``'soft'``).
- ``check_budget_constraints`` returns hard blocks AND soft warnings
  separately, with limits/constraints checked attribution.
- Adds anonymous-agent gating and time-bounded period expiry.

Wire-stable as ``budget_governance.v1``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from .financial_action import CurrencyCode, FinancialActionType, FinancialRiskTier

BudgetScope = Literal[
    "org",
    "department",
    "team",
    "environment",
    "action_class",
    "project",
    "time_bounded",
]

BudgetEnforcement = Literal["hard", "soft"]

BudgetViolationType = Literal[
    "limit_exceeded",
    "single_transaction_exceeds",
    "daily_aggregate_exceeds",
    "monthly_aggregate_exceeds",
    "anonymous_agent_blocked",
    "period_expired",
]


@dataclass(frozen=True)
class BudgetLimit:
    """A declared budget limit for a scope."""

    limit_id: str
    org_id: str
    scope_type: BudgetScope
    scope_id: str
    limit_amount: float
    currency: CurrencyCode
    enforcement: BudgetEnforcement
    period_start: str | None
    period_end: str | None
    active: bool
    created_by: str
    created_at: str


@dataclass(frozen=True)
class BudgetSpendingState:
    """Current spending state against a budget limit."""

    limit_id: str
    spent_amount: float
    remaining_amount: float
    exceeded: bool
    utilization_pct: float
    updated_at: str


@dataclass(frozen=True)
class _LimitWithSpending:
    """Helper: a limit paired with its current spending state."""

    limit: BudgetLimit
    spending: BudgetSpendingState


@dataclass(frozen=True)
class SpendingConstraint:
    """A spending constraint on a financial action class or type.

    ``action_type='*'`` matches all action types.
    """

    constraint_id: str
    org_id: str
    action_type: str  # FinancialActionType | "*"
    max_single_transaction: float
    max_daily_aggregate: float | None
    max_monthly_aggregate: float | None
    currency: CurrencyCode
    applies_to_tier_gte: FinancialRiskTier | None
    allow_anonymous_agents: bool
    active: bool


@dataclass(frozen=True)
class BudgetViolation:
    """A specific budget violation."""

    violation_type: BudgetViolationType
    description: str
    limit_id: str | None = None
    constraint_id: str | None = None
    overage_amount: float | None = None


@dataclass(frozen=True)
class BudgetConstraintCheckResult:
    """Result of checking an action against budget constraints."""

    permitted: bool
    hard_blocks: Sequence[BudgetViolation]
    soft_warnings: Sequence[BudgetViolation]
    limits_checked: Sequence[str]
    constraints_checked: Sequence[str]


@dataclass(frozen=True)
class BudgetPolicy:
    """A complete budget policy document for an organization."""

    policy_id: str
    org_id: str
    name: str
    limits: Sequence[BudgetLimit]
    constraints: Sequence[SpendingConstraint]
    override_requires_exception: bool
    allow_approved_escalation: bool
    version: str
    effective_from: str
    expires_at: str | None = None


def _now_iso() -> str:
    """UTC now as ISO-8601 string. Lex-comparable with stored period_end."""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def check_budget_constraints(
    *,
    action_value: float,
    currency: CurrencyCode,
    action_type: FinancialActionType,
    risk_tier: FinancialRiskTier,
    is_anonymous_agent: bool,
    current_daily_spend: float,
    current_monthly_spend: float,
    applicable_limits: Sequence[tuple[BudgetLimit, BudgetSpendingState]],
    applicable_constraints: Sequence[SpendingConstraint],
    now: str | None = None,
) -> BudgetConstraintCheckResult:
    """Check an action value against applicable budget limits and constraints.

    Hard limits block execution; soft limits surface as warnings. Mirrors
    ``checkBudgetConstraints`` in TS step-for-step.
    """
    hard_blocks: list[BudgetViolation] = []
    soft_warnings: list[BudgetViolation] = []
    limits_checked: list[str] = []
    constraints_checked: list[str] = []
    now_iso = now if now is not None else _now_iso()

    for limit, spending in applicable_limits:
        limits_checked.append(limit.limit_id)

        if limit.period_end is not None and now_iso > limit.period_end:
            v = BudgetViolation(
                violation_type="period_expired",
                limit_id=limit.limit_id,
                description=(
                    "Budget limit "
                    f"{limit.limit_id} period expired at {limit.period_end}"
                ),
            )
            (hard_blocks if limit.enforcement == "hard" else soft_warnings).append(v)
            continue

        projected = spending.spent_amount + action_value
        if projected > limit.limit_amount:
            v = BudgetViolation(
                violation_type="limit_exceeded",
                limit_id=limit.limit_id,
                description=(
                    f"Action would exceed {limit.scope_type} limit "
                    f"({limit.limit_amount} {limit.currency})"
                ),
                overage_amount=projected - limit.limit_amount,
            )
            (hard_blocks if limit.enforcement == "hard" else soft_warnings).append(v)

    for constraint in applicable_constraints:
        constraints_checked.append(constraint.constraint_id)

        if constraint.action_type != "*" and constraint.action_type != action_type:
            continue

        if not constraint.allow_anonymous_agents and is_anonymous_agent:
            hard_blocks.append(
                BudgetViolation(
                    violation_type="anonymous_agent_blocked",
                    constraint_id=constraint.constraint_id,
                    description=(
                        f"Anonymous agents are not permitted to execute {action_type}"
                    ),
                )
            )

        if action_value > constraint.max_single_transaction:
            hard_blocks.append(
                BudgetViolation(
                    violation_type="single_transaction_exceeds",
                    constraint_id=constraint.constraint_id,
                    description=(
                        f"Value {action_value} exceeds single-transaction limit "
                        f"{constraint.max_single_transaction} {constraint.currency}"
                    ),
                    overage_amount=action_value - constraint.max_single_transaction,
                )
            )

        if (
            constraint.max_daily_aggregate is not None
            and current_daily_spend + action_value > constraint.max_daily_aggregate
        ):
            hard_blocks.append(
                BudgetViolation(
                    violation_type="daily_aggregate_exceeds",
                    constraint_id=constraint.constraint_id,
                    description=(
                        f"Action would exceed daily aggregate limit "
                        f"{constraint.max_daily_aggregate} {constraint.currency}"
                    ),
                    overage_amount=(
                        current_daily_spend
                        + action_value
                        - constraint.max_daily_aggregate
                    ),
                )
            )

        if (
            constraint.max_monthly_aggregate is not None
            and current_monthly_spend + action_value > constraint.max_monthly_aggregate
        ):
            hard_blocks.append(
                BudgetViolation(
                    violation_type="monthly_aggregate_exceeds",
                    constraint_id=constraint.constraint_id,
                    description=(
                        f"Action would exceed monthly aggregate limit "
                        f"{constraint.max_monthly_aggregate} {constraint.currency}"
                    ),
                    overage_amount=(
                        current_monthly_spend
                        + action_value
                        - constraint.max_monthly_aggregate
                    ),
                )
            )

    return BudgetConstraintCheckResult(
        permitted=len(hard_blocks) == 0,
        hard_blocks=tuple(hard_blocks),
        soft_warnings=tuple(soft_warnings),
        limits_checked=tuple(limits_checked),
        constraints_checked=tuple(constraints_checked),
    )


def budget_utilization_severity(
    utilization_pct: float,
) -> Literal["normal", "warn", "critical"]:
    """Determine budget utilization severity for dashboard display.

    These thresholds are display-only; they do not drive enforcement.
    Mirrors ``budgetUtilizationSeverity`` in TS exactly.
    """
    if utilization_pct >= 100:
        return "critical"
    if utilization_pct >= 80:
        return "warn"
    return "normal"


__all__ = [
    "BudgetConstraintCheckResult",
    "BudgetEnforcement",
    "BudgetLimit",
    "BudgetPolicy",
    "BudgetScope",
    "BudgetSpendingState",
    "BudgetViolation",
    "BudgetViolationType",
    "SpendingConstraint",
    "budget_utilization_severity",
    "check_budget_constraints",
]
