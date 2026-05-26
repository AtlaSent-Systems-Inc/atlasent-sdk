"""Tests for atlasent.governance.autonomous_financial.

Focus on parity-relevant behaviors absent from the legacy module:
allowlist-based action types, per-action-type ceilings, max_risk_tier
ordinal cap, ISO-8601 expires_at via lex-comparable strings, three-arm
anomaly detection.
"""

from __future__ import annotations

from atlasent.governance import (
    AutonomousExecutionBounds,
    ExecutionCeiling,
    check_autonomous_bounds,
    detect_autonomous_anomaly,
)


def _bounds(
    *,
    permitted_action_types: tuple[str, ...] = ("refund", "vendor_payment"),
    ceilings: tuple[ExecutionCeiling, ...] = (),
    daily_aggregate_ceiling: float = 100_000.0,
    max_risk_tier: str = "medium",
    expires_at: str | None = None,
    active: bool = True,
) -> AutonomousExecutionBounds:
    return AutonomousExecutionBounds(
        bounds_id="bnd_001",
        org_id="org_x",
        agent_id="agent_refundbot",
        agent_name="refund-bot",
        permitted_action_types=permitted_action_types,
        ceilings=ceilings,
        daily_aggregate_ceiling=daily_aggregate_ceiling,
        aggregate_currency="USD",
        max_risk_tier=max_risk_tier,
        require_runtime_verification=True,
        anomaly_detection_enabled=True,
        created_at="2026-05-01T00:00:00Z",
        expires_at=expires_at,
        active=active,
    )


def _ceiling(
    action_type: str = "refund",
    per_execution_max: float = 5_000.0,
    max_daily_count: int | None = None,
) -> ExecutionCeiling:
    return ExecutionCeiling(
        action_type=action_type,
        per_execution_max=per_execution_max,
        currency="USD",
        max_daily_count=max_daily_count,
    )


def test_inactive_bounds_block_execution() -> None:
    result = check_autonomous_bounds(
        bounds=_bounds(active=False),
        action_type="refund",
        action_value=100,
        currency="USD",
        risk_tier="low",
        current_daily_aggregate=0,
        current_daily_count={},
    )
    assert result.permitted is False
    assert result.bounds_active is False


def test_expired_bounds_block_execution() -> None:
    result = check_autonomous_bounds(
        bounds=_bounds(expires_at="2026-04-01T00:00:00Z"),
        action_type="refund",
        action_value=100,
        currency="USD",
        risk_tier="low",
        current_daily_aggregate=0,
        current_daily_count={},
        now="2026-05-08T12:00:00Z",
    )
    assert result.permitted is False
    assert result.bounds_not_expired is False


def test_action_type_outside_allowlist_blocks() -> None:
    # Allowlist: refund, vendor_payment. Action: wire_transfer. → blocked.
    result = check_autonomous_bounds(
        bounds=_bounds(),
        action_type="wire_transfer",
        action_value=100,
        currency="USD",
        risk_tier="low",
        current_daily_aggregate=0,
        current_daily_count={},
    )
    assert result.permitted is False
    assert result.action_type_permitted is False


def test_per_execution_ceiling_blocks() -> None:
    result = check_autonomous_bounds(
        bounds=_bounds(ceilings=(_ceiling(per_execution_max=5_000),)),
        action_type="refund",
        action_value=10_000,
        currency="USD",
        risk_tier="low",
        current_daily_aggregate=0,
        current_daily_count={},
    )
    assert result.permitted is False
    assert result.within_execution_ceiling is False


def test_daily_count_limit_blocks() -> None:
    result = check_autonomous_bounds(
        bounds=_bounds(
            ceilings=(_ceiling(per_execution_max=5_000, max_daily_count=10),)
        ),
        action_type="refund",
        action_value=100,
        currency="USD",
        risk_tier="low",
        current_daily_aggregate=0,
        current_daily_count={"refund": 10},
    )
    assert result.permitted is False
    assert result.within_execution_ceiling is False


def test_daily_aggregate_blocks() -> None:
    result = check_autonomous_bounds(
        bounds=_bounds(daily_aggregate_ceiling=100_000),
        action_type="refund",
        action_value=20_000,
        currency="USD",
        risk_tier="low",
        current_daily_aggregate=85_000,
        current_daily_count={},
    )
    assert result.permitted is False
    assert result.within_daily_aggregate is False


def test_risk_tier_above_max_blocks() -> None:
    # Bounds max = medium; action tier = high → blocked.
    result = check_autonomous_bounds(
        bounds=_bounds(max_risk_tier="medium"),
        action_type="refund",
        action_value=100,
        currency="USD",
        risk_tier="high",
        current_daily_aggregate=0,
        current_daily_count={},
    )
    assert result.permitted is False
    assert result.within_risk_tier is False


def test_happy_path_within_all_bounds() -> None:
    result = check_autonomous_bounds(
        bounds=_bounds(
            ceilings=(_ceiling(per_execution_max=5_000),),
            max_risk_tier="high",
            expires_at="2026-12-31T23:59:59Z",
        ),
        action_type="refund",
        action_value=2_500,
        currency="USD",
        risk_tier="medium",
        current_daily_aggregate=10_000,
        current_daily_count={"refund": 3},
        now="2026-05-08T12:00:00Z",
    )
    assert result.permitted is True
    assert result.applicable_ceiling is not None


def test_anomaly_zscore_above_three() -> None:
    result = detect_autonomous_anomaly(
        action_value=100_000,
        historical_mean_value=1_000,
        historical_std_dev=500,
        recent_execution_count=2,
        burst_threshold=20,
        is_off_hours=False,
    )
    assert result.anomaly_detected is True
    assert result.description is not None
    assert "σ" in result.description


def test_anomaly_burst_detection() -> None:
    result = detect_autonomous_anomaly(
        action_value=1_000,
        historical_mean_value=1_000,
        historical_std_dev=100,
        recent_execution_count=50,
        burst_threshold=20,
        is_off_hours=False,
    )
    assert result.anomaly_detected is True
    assert result.description is not None
    assert "burst" in result.description.lower()


def test_anomaly_off_hours_above_mean() -> None:
    result = detect_autonomous_anomaly(
        action_value=5_000,
        historical_mean_value=1_000,
        historical_std_dev=2_000,  # z-score = 2.0 (< 3) so off-hours branch fires
        recent_execution_count=2,
        burst_threshold=20,
        is_off_hours=True,
    )
    # 5000 > 1000 * 2 → off-hours anomaly.
    assert result.anomaly_detected is True
    assert result.description is not None
    assert "off-hours" in result.description.lower()


def test_anomaly_no_signal_in_normal_range() -> None:
    result = detect_autonomous_anomaly(
        action_value=1_050,
        historical_mean_value=1_000,
        historical_std_dev=100,
        recent_execution_count=3,
        burst_threshold=20,
        is_off_hours=False,
    )
    assert result.anomaly_detected is False
