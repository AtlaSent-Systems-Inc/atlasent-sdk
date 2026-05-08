"""Autonomous Financial Execution — priority 5.

Mirrors ``atlasent-sdk/typescript/src/autonomousFinancial.ts``.

Key divergences from the legacy ``atlasent.governance.autonomous_financial``
in the orchestration repo (which this canonical port supersedes):

- Allowlist-based ``permitted_action_types`` (not denylist).
- Per-action-type ``ExecutionCeiling`` with optional ``max_daily_count``.
- ``max_risk_tier`` ceiling with strict ordinal comparison
  (low < medium < high < critical).
- Bounds expiry via ``expires_at`` (ISO-8601 string, lex-comparable).
- ``detect_autonomous_anomaly`` covers z-score (3σ), burst, and
  off-hours-with-above-mean. The legacy module had only z-score.
- The legacy ``max_counterparty_exposure`` field is intentionally NOT
  ported; it is not in the canonical TS module or in migration
  ``autonomous_execution_bounds`` and would be enforcing a constraint the
  rest of the system doesn't know about.

Wire-stable as ``autonomous_financial.v1``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Sequence

from .financial_action import CurrencyCode, FinancialActionType, FinancialRiskTier

_RISK_TIER_ORDER: dict[str, int] = {
    "low": 1,
    "medium": 2,
    "high": 3,
    "critical": 4,
}


@dataclass(frozen=True)
class ExecutionCeiling:
    """Per-action-type execution ceiling."""

    action_type: FinancialActionType
    per_execution_max: float
    currency: CurrencyCode
    max_daily_count: Optional[int]
    require_permit: bool = False


@dataclass(frozen=True)
class AutonomousExecutionBounds:
    """Authority bounds for an autonomous financial agent.

    Stored in migration table ``autonomous_execution_bounds``. Agents may
    not self-modify their own bounds.
    """

    bounds_id: str
    org_id: str
    agent_id: str
    agent_name: str
    permitted_action_types: Sequence[FinancialActionType]
    ceilings: Sequence[ExecutionCeiling]
    daily_aggregate_ceiling: float
    aggregate_currency: CurrencyCode
    max_risk_tier: FinancialRiskTier
    require_runtime_verification: bool
    anomaly_detection_enabled: bool
    created_at: str
    expires_at: Optional[str]
    active: bool


@dataclass(frozen=True)
class AutonomousExecutionRecord:
    """Record of an autonomous execution attempt (audit trail)."""

    record_id: str
    agent_id: str
    org_id: str
    action_type: FinancialActionType
    action_value: float
    currency: CurrencyCode
    permitted: bool
    denial_reason: Optional[str]
    permit_id: Optional[str]
    anomaly_detected: bool
    anomaly_description: Optional[str]
    attempted_at: str
    executed_at: Optional[str]


@dataclass(frozen=True)
class AutonomousExecutionCheckResult:
    """Result of checking whether an autonomous execution is within bounds."""

    permitted: bool
    action_type_permitted: bool
    within_execution_ceiling: bool
    within_daily_aggregate: bool
    within_risk_tier: bool
    bounds_active: bool
    bounds_not_expired: bool
    applicable_ceiling: Optional[ExecutionCeiling]
    denial_reason: Optional[str]
    violations: Sequence[str]


@dataclass(frozen=True)
class AnomalyDetectionResult:
    """Result of ``detect_autonomous_anomaly``."""

    anomaly_detected: bool
    description: Optional[str]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def check_autonomous_bounds(
    *,
    bounds: AutonomousExecutionBounds,
    action_type: FinancialActionType,
    action_value: float,
    currency: CurrencyCode,
    risk_tier: FinancialRiskTier,
    current_daily_aggregate: float,
    current_daily_count: dict[str, int],
    now: Optional[str] = None,
) -> AutonomousExecutionCheckResult:
    """Check whether an autonomous execution is within declared bounds.

    Mirrors ``checkAutonomousBounds`` in TS step-for-step.
    """
    violations: list[str] = []
    now_iso = now if now is not None else _now_iso()

    bounds_active = bounds.active
    if not bounds_active:
        violations.append("agent execution bounds are inactive")

    bounds_not_expired = bounds.expires_at is None or bounds.expires_at > now_iso
    if not bounds_not_expired:
        violations.append(f"agent bounds expired at {bounds.expires_at}")

    action_type_permitted = action_type in bounds.permitted_action_types
    if not action_type_permitted:
        violations.append(
            f"action type {action_type} not in agent's permitted set"
        )

    applicable_ceiling: Optional[ExecutionCeiling] = next(
        (c for c in bounds.ceilings if c.action_type == action_type), None
    )

    within_execution_ceiling = True
    if applicable_ceiling is not None:
        if action_value > applicable_ceiling.per_execution_max:
            within_execution_ceiling = False
            violations.append(
                f"value {action_value} exceeds per-execution ceiling "
                f"{applicable_ceiling.per_execution_max} {applicable_ceiling.currency}"
            )
        if applicable_ceiling.max_daily_count is not None:
            today_count = current_daily_count.get(action_type, 0)
            if today_count >= applicable_ceiling.max_daily_count:
                within_execution_ceiling = False
                violations.append(
                    f"daily count {today_count} at or exceeds limit "
                    f"{applicable_ceiling.max_daily_count} for {action_type}"
                )

    within_daily_aggregate = (
        current_daily_aggregate + action_value <= bounds.daily_aggregate_ceiling
    )
    if not within_daily_aggregate:
        violations.append(
            f"daily aggregate {current_daily_aggregate + action_value} would exceed "
            f"ceiling {bounds.daily_aggregate_ceiling} {bounds.aggregate_currency}"
        )

    within_risk_tier = (
        _RISK_TIER_ORDER[risk_tier] <= _RISK_TIER_ORDER[bounds.max_risk_tier]
    )
    if not within_risk_tier:
        violations.append(
            f"action risk tier {risk_tier} exceeds agent max {bounds.max_risk_tier}"
        )

    permitted = (
        bounds_active
        and bounds_not_expired
        and action_type_permitted
        and within_execution_ceiling
        and within_daily_aggregate
        and within_risk_tier
    )

    return AutonomousExecutionCheckResult(
        permitted=permitted,
        action_type_permitted=action_type_permitted,
        within_execution_ceiling=within_execution_ceiling,
        within_daily_aggregate=within_daily_aggregate,
        within_risk_tier=within_risk_tier,
        bounds_active=bounds_active,
        bounds_not_expired=bounds_not_expired,
        applicable_ceiling=applicable_ceiling,
        denial_reason=(
            None if permitted else (violations[0] if violations else "execution out of bounds")
        ),
        violations=tuple(violations),
    )


def detect_autonomous_anomaly(
    *,
    action_value: float,
    historical_mean_value: float,
    historical_std_dev: float,
    recent_execution_count: int,
    burst_threshold: int,
    is_off_hours: bool,
) -> AnomalyDetectionResult:
    """Detect a potential anomaly in autonomous execution.

    Returns an ``AnomalyDetectionResult`` with a description when an anomaly
    is detected, or ``description=None``. Mirrors ``detectAutonomousAnomaly``
    in TS.
    """
    z_score = (
        abs(action_value - historical_mean_value) / historical_std_dev
        if historical_std_dev > 0
        else 0.0
    )

    if z_score > 3:
        return AnomalyDetectionResult(
            anomaly_detected=True,
            description=(
                f"action value {action_value} is {z_score:.1f}σ from mean "
                f"({historical_mean_value})"
            ),
        )

    if recent_execution_count > burst_threshold:
        return AnomalyDetectionResult(
            anomaly_detected=True,
            description=(
                f"execution burst: {recent_execution_count} in window "
                f"(threshold: {burst_threshold})"
            ),
        )

    if is_off_hours and action_value > historical_mean_value * 2:
        return AnomalyDetectionResult(
            anomaly_detected=True,
            description=f"off-hours execution with above-average value {action_value}",
        )

    return AnomalyDetectionResult(anomaly_detected=False, description=None)


__all__ = [
    "AnomalyDetectionResult",
    "AutonomousExecutionBounds",
    "AutonomousExecutionCheckResult",
    "AutonomousExecutionRecord",
    "ExecutionCeiling",
    "check_autonomous_bounds",
    "detect_autonomous_anomaly",
]
