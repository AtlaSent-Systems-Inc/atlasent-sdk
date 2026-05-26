"""Tests for atlasent.governance.financial_quorum.

Focus on parity-relevant behaviors absent from the legacy module:
emergency-freeze pre-check, amount-threshold escalation, financial role
requirements, regulator approval threshold, escalated approval count.
"""

from __future__ import annotations

from atlasent.governance import (
    AmountThreshold,
    EmergencyFreeze,
    FinancialQuorumInput,
    FinancialQuorumPolicy,
    FinancialRoleRequirement,
    compute_escalated_approval_count,
    evaluate_financial_quorum,
)


def _baseline_policy(**overrides) -> FinancialQuorumPolicy:
    base = dict(
        required_count=2,
        financial_role_requirements=(),
        amount_thresholds=(),
        reference_currency="USD",
        emergency_freeze_active=False,
        regulator_approval_threshold=None,
        dual_release_threshold=None,
    )
    base.update(overrides)
    return FinancialQuorumPolicy(**base)


def _input(
    policy: FinancialQuorumPolicy,
    *,
    action_value: float = 5_000.0,
    risk_tier: str = "medium",
    present_roles: dict | None = None,
    approval_count: int = 2,
    regulator_approval_present: bool = False,
    active_freezes=(),
) -> FinancialQuorumInput:
    return FinancialQuorumInput(
        policy=policy,
        action_value=action_value,
        risk_tier=risk_tier,
        present_roles=present_roles or {},
        approval_count=approval_count,
        regulator_approval_present=regulator_approval_present,
        base_quorum_proof=None,
        active_freezes=active_freezes,
    )


def test_active_emergency_freeze_blocks_unconditionally() -> None:
    freeze = EmergencyFreeze(
        freeze_id="frz_001",
        scope_id="org_x",
        scope_type="org",
        triggered_by="u_admin",
        reason="suspected fraud incident",
        triggered_at="2026-05-08T10:00:00Z",
    )
    result = evaluate_financial_quorum(
        _input(
            _baseline_policy(),
            approval_count=99,
            active_freezes=(freeze,),
        )
    )
    assert result.passed is False
    assert result.blocked_by_freeze is True
    assert "frz_001" in (result.denial_reason or "")


def test_lifted_freeze_does_not_block() -> None:
    freeze = EmergencyFreeze(
        freeze_id="frz_001",
        scope_id="org_x",
        scope_type="org",
        triggered_by="u_admin",
        reason="resolved",
        triggered_at="2026-05-08T10:00:00Z",
        lifted=True,
        lifted_at="2026-05-08T11:00:00Z",
        lifted_by="u_admin",
    )
    result = evaluate_financial_quorum(
        _input(
            _baseline_policy(),
            approval_count=2,
            active_freezes=(freeze,),
        )
    )
    assert result.blocked_by_freeze is False
    assert result.passed is True


def test_base_quorum_count_failure() -> None:
    result = evaluate_financial_quorum(
        _input(
            _baseline_policy(required_count=3),
            approval_count=2,
        )
    )
    assert result.passed is False
    assert result.base_quorum_passed is False


def test_amount_threshold_escalation_requires_more_approvals() -> None:
    policy = _baseline_policy(
        required_count=2,
        amount_thresholds=(
            AmountThreshold(
                value=100_000,
                currency="USD",
                additional_approvals=2,
            ),
        ),
    )
    # Action value crosses threshold; need 2 + 2 = 4 approvals.
    result = evaluate_financial_quorum(
        _input(
            policy,
            action_value=150_000,
            approval_count=3,
        )
    )
    assert result.passed is False
    assert result.amount_threshold_satisfied is False

    # Same threshold satisfied with the right count.
    result_ok = evaluate_financial_quorum(
        _input(
            policy,
            action_value=150_000,
            approval_count=4,
        )
    )
    assert result_ok.passed is True


def test_amount_threshold_role_requirement() -> None:
    policy = _baseline_policy(
        required_count=2,
        amount_thresholds=(
            AmountThreshold(
                value=50_000,
                currency="USD",
                additional_approvals=0,
                additional_roles=(FinancialRoleRequirement(role="cfo", min=1),),
            ),
        ),
    )
    # CFO not present → fail.
    result = evaluate_financial_quorum(
        _input(
            policy,
            action_value=75_000,
            approval_count=2,
            present_roles={"finance_lead": 2},
        )
    )
    assert result.passed is False
    assert result.amount_threshold_satisfied is False

    # CFO present → pass.
    result_ok = evaluate_financial_quorum(
        _input(
            policy,
            action_value=75_000,
            approval_count=2,
            present_roles={"finance_lead": 1, "cfo": 1},
        )
    )
    assert result_ok.passed is True


def test_financial_role_requirement_with_tier_filter() -> None:
    policy = _baseline_policy(
        required_count=2,
        financial_role_requirements=(
            FinancialRoleRequirement(
                role="cfo",
                min=1,
                applies_to_tiers=("high", "critical"),
            ),
        ),
    )
    # Medium tier — requirement does not apply.
    result_medium = evaluate_financial_quorum(
        _input(
            policy,
            risk_tier="medium",
            approval_count=2,
            present_roles={},
        )
    )
    assert result_medium.passed is True

    # High tier — CFO required.
    result_high = evaluate_financial_quorum(
        _input(
            policy,
            risk_tier="high",
            approval_count=2,
            present_roles={},
        )
    )
    assert result_high.passed is False
    assert result_high.financial_roles_satisfied is False


def test_regulator_approval_threshold() -> None:
    policy = _baseline_policy(
        required_count=2,
        regulator_approval_threshold=1_000_000,
    )
    # Below threshold — no regulator needed.
    r_below = evaluate_financial_quorum(
        _input(
            policy,
            action_value=500_000,
            approval_count=2,
        )
    )
    assert r_below.passed is True

    # At/above threshold without regulator approval — fail.
    r_above = evaluate_financial_quorum(
        _input(
            policy,
            action_value=2_000_000,
            approval_count=2,
            regulator_approval_present=False,
        )
    )
    assert r_above.passed is False
    assert r_above.regulator_approval_missing is True

    # At/above threshold with regulator approval — pass.
    r_with = evaluate_financial_quorum(
        _input(
            policy,
            action_value=2_000_000,
            approval_count=2,
            regulator_approval_present=True,
        )
    )
    assert r_with.passed is True


def test_compute_escalated_approval_count_picks_max_additional() -> None:
    thresholds = (
        AmountThreshold(value=10_000, currency="USD", additional_approvals=1),
        AmountThreshold(value=100_000, currency="USD", additional_approvals=3),
        AmountThreshold(value=1_000_000, currency="USD", additional_approvals=5),
    )
    assert compute_escalated_approval_count(2, 5_000, thresholds) == 2
    assert compute_escalated_approval_count(2, 50_000, thresholds) == 3
    assert compute_escalated_approval_count(2, 500_000, thresholds) == 5
    assert compute_escalated_approval_count(2, 5_000_000, thresholds) == 7
