"""Financial Action Model — canonical types for financial execution authority.

Mirrors ``atlasent-sdk/typescript/src/financialAction.ts``. Wire-stable as
``financial_action.v1``. Schema lives in ``contract/schemas/`` (pending) and
is enforced by migration ``001_financial_action_model.sql``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

# ─── Type aliases ────────────────────────────────────────────────────

# Open string union: ISO 4217 well-known codes plus any other 3-letter code.
CurrencyCode = str

FinancialRiskTier = Literal["low", "medium", "high", "critical"]

LiabilityClassification = Literal[
    "individual",
    "shared",
    "delegated",
    "supervisory",
    "emergency_override",
]

FinancialActionType = (
    str  # canonical set documented in TS; open-ended for extensibility
)

FinancialExecutionStatus = Literal[
    "pending_approval",
    "approved",
    "executing",
    "completed",
    "failed",
    "reversed",
    "disputed",
    "frozen",
]


@dataclass(frozen=True)
class FinancialActionClass:
    """Canonical per-org definition of a financial action class.

    Stored in ``financial_action_classes``. Drives quorum policy,
    liability classification, and risk-tier assignment.
    """

    action_class_id: str
    name: str
    action_type: FinancialActionType
    risk_tier: FinancialRiskTier
    required_approvals: int
    liability_classification: LiabilityClassification
    reversible: bool
    autonomous_ceiling: float | None
    ceiling_currency: CurrencyCode | None
    created_at: str
    description: str | None = None


@dataclass(frozen=True)
class FinancialExecutionRecord:
    """Immutable record of a financial action execution.

    Written at authorization time. Stored append-only in
    ``financial_execution_records``.
    """

    execution_id: str
    action_class_id: str
    org_id: str
    action_value: float
    currency: CurrencyCode
    risk_tier: FinancialRiskTier
    liability_classification: LiabilityClassification
    initiator_id: str
    executor_id: str
    approver_ids: Sequence[str]
    permit_ids: Sequence[str]
    override_applied: bool
    override_id: str | None
    status: FinancialExecutionStatus
    authorized_at: str
    executed_at: str | None
    audit_hash: str
    context: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RiskTierThreshold:
    """Threshold configuration for risk-tier escalation."""

    tier: FinancialRiskTier
    lower_bound: float
    upper_bound: float | None
    reference_currency: CurrencyCode = "USD"


# Default risk tier thresholds (USD-denominated). Mirrors the TS
# ``DEFAULT_RISK_TIER_THRESHOLDS`` constant exactly.
DEFAULT_RISK_TIER_THRESHOLDS: tuple[RiskTierThreshold, ...] = (
    RiskTierThreshold(
        tier="low", lower_bound=0.0, upper_bound=1_000.0, reference_currency="USD"
    ),
    RiskTierThreshold(
        tier="medium",
        lower_bound=1_000.0,
        upper_bound=50_000.0,
        reference_currency="USD",
    ),
    RiskTierThreshold(
        tier="high",
        lower_bound=50_000.0,
        upper_bound=1_000_000.0,
        reference_currency="USD",
    ),
    RiskTierThreshold(
        tier="critical",
        lower_bound=1_000_000.0,
        upper_bound=None,
        reference_currency="USD",
    ),
)


def classify_risk_tier(
    value: float,
    thresholds: Sequence[RiskTierThreshold] = DEFAULT_RISK_TIER_THRESHOLDS,
) -> FinancialRiskTier:
    """Classify a financial action's risk tier based on its value.

    Iteration order matches the TS implementation: first matching threshold wins.
    Values that fall below all thresholds map to ``"low"`` (when default thresholds
    are used and value >= 0); values above the highest upper_bound fall through to
    the implicit ``"critical"`` final return.
    """
    for t in thresholds:
        if value >= t.lower_bound and (t.upper_bound is None or value < t.upper_bound):
            return t.tier
    return "critical"


def within_autonomous_ceiling(action_value: float, ceiling: float | None) -> bool:
    """Return True iff action_value is within the autonomous-execution ceiling.

    A ``None`` ceiling means no ceiling configured (always within bounds).
    """
    if ceiling is None:
        return True
    return action_value <= ceiling


__all__ = [
    "DEFAULT_RISK_TIER_THRESHOLDS",
    "CurrencyCode",
    "FinancialActionClass",
    "FinancialActionType",
    "FinancialExecutionRecord",
    "FinancialExecutionStatus",
    "FinancialRiskTier",
    "LiabilityClassification",
    "RiskTierThreshold",
    "classify_risk_tier",
    "within_autonomous_ceiling",
]
