"""Tests for atlasent.governance.financial_action."""

from __future__ import annotations

from atlasent.governance import (
    DEFAULT_RISK_TIER_THRESHOLDS,
    classify_risk_tier,
    within_autonomous_ceiling,
)


def test_default_thresholds_are_locked() -> None:
    # Locked numeric thresholds; changing them is a wire-breaking event.
    bounds = [(t.tier, t.lower_bound, t.upper_bound) for t in DEFAULT_RISK_TIER_THRESHOLDS]
    assert bounds == [
        ("low", 0.0, 1_000.0),
        ("medium", 1_000.0, 50_000.0),
        ("high", 50_000.0, 1_000_000.0),
        ("critical", 1_000_000.0, None),
    ]


def test_classify_risk_tier_at_boundaries() -> None:
    # Lower bound is inclusive, upper bound is exclusive.
    assert classify_risk_tier(0) == "low"
    assert classify_risk_tier(999.99) == "low"
    assert classify_risk_tier(1_000) == "medium"
    assert classify_risk_tier(49_999.99) == "medium"
    assert classify_risk_tier(50_000) == "high"
    assert classify_risk_tier(999_999.99) == "high"
    assert classify_risk_tier(1_000_000) == "critical"
    assert classify_risk_tier(10_000_000) == "critical"


def test_within_autonomous_ceiling_handles_none() -> None:
    assert within_autonomous_ceiling(0, None) is True
    assert within_autonomous_ceiling(1_000_000, None) is True


def test_within_autonomous_ceiling_inclusive() -> None:
    assert within_autonomous_ceiling(100, 100) is True
    assert within_autonomous_ceiling(99, 100) is True
    assert within_autonomous_ceiling(101, 100) is False
