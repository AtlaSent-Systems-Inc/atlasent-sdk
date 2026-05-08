"""Tests for atlasent.governance.budgetary_governance.

Focus on parity-relevant behaviors absent from the legacy module:
7-scope BudgetLimit, separate SpendingConstraint with single/daily/monthly
aggregates, anonymous-agent gating, period expiry, hard/soft enforcement,
6-typed violation taxonomy.
"""

from __future__ import annotations

from atlasent.governance import (
    BudgetLimit,
    BudgetSpendingState,
    SpendingConstraint,
    budget_utilization_severity,
    check_budget_constraints,
)


def _limit(
    *,
    limit_id: str = "lim_dept_q4",
    scope_type: str = "department",
    scope_id: str = "finance",
    limit_amount: float = 100_000.0,
    enforcement: str = "hard",
    period_end: str | None = None,
) -> BudgetLimit:
    return BudgetLimit(
        limit_id=limit_id,
        org_id="org_x",
        scope_type=scope_type,
        scope_id=scope_id,
        limit_amount=limit_amount,
        currency="USD",
        enforcement=enforcement,
        period_start=None,
        period_end=period_end,
        active=True,
        created_by="u_admin",
        created_at="2026-01-01T00:00:00Z",
    )


def _state(spent: float, limit_id: str = "lim_dept_q4") -> BudgetSpendingState:
    return BudgetSpendingState(
        limit_id=limit_id,
        spent_amount=spent,
        remaining_amount=0.0,
        exceeded=False,
        utilization_pct=0.0,
        updated_at="2026-05-08T12:00:00Z",
    )


def _constraint(
    *,
    constraint_id: str = "con_default",
    action_type: str = "*",
    max_single_transaction: float = 50_000.0,
    max_daily_aggregate: float | None = None,
    max_monthly_aggregate: float | None = None,
    allow_anonymous_agents: bool = True,
) -> SpendingConstraint:
    return SpendingConstraint(
        constraint_id=constraint_id,
        org_id="org_x",
        action_type=action_type,
        max_single_transaction=max_single_transaction,
        max_daily_aggregate=max_daily_aggregate,
        max_monthly_aggregate=max_monthly_aggregate,
        currency="USD",
        applies_to_tier_gte=None,
        allow_anonymous_agents=allow_anonymous_agents,
        active=True,
    )


def test_happy_path_under_limit() -> None:
    result = check_budget_constraints(
        action_value=10_000,
        currency="USD",
        action_type="wire_transfer",
        risk_tier="medium",
        is_anonymous_agent=False,
        current_daily_spend=0,
        current_monthly_spend=0,
        applicable_limits=((_limit(), _state(50_000)),),
        applicable_constraints=(_constraint(),),
    )
    assert result.permitted is True
    assert len(result.hard_blocks) == 0


def test_hard_limit_exceeded() -> None:
    result = check_budget_constraints(
        action_value=60_000,
        currency="USD",
        action_type="wire_transfer",
        risk_tier="high",
        is_anonymous_agent=False,
        current_daily_spend=0,
        current_monthly_spend=0,
        applicable_limits=((_limit(limit_amount=100_000, enforcement="hard"), _state(50_000)),),
        applicable_constraints=(_constraint(max_single_transaction=100_000),),
    )
    assert result.permitted is False
    assert any(v.violation_type == "limit_exceeded" for v in result.hard_blocks)


def test_soft_limit_warns_but_permits() -> None:
    result = check_budget_constraints(
        action_value=60_000,
        currency="USD",
        action_type="wire_transfer",
        risk_tier="high",
        is_anonymous_agent=False,
        current_daily_spend=0,
        current_monthly_spend=0,
        applicable_limits=((_limit(limit_amount=100_000, enforcement="soft"), _state(50_000)),),
        applicable_constraints=(_constraint(max_single_transaction=100_000),),
    )
    assert result.permitted is True
    assert any(v.violation_type == "limit_exceeded" for v in result.soft_warnings)


def test_period_expired_blocks_hard_limit() -> None:
    result = check_budget_constraints(
        action_value=10_000,
        currency="USD",
        action_type="wire_transfer",
        risk_tier="medium",
        is_anonymous_agent=False,
        current_daily_spend=0,
        current_monthly_spend=0,
        applicable_limits=((_limit(period_end="2026-04-01T00:00:00Z"), _state(0)),),
        applicable_constraints=(_constraint(),),
        now="2026-05-08T12:00:00Z",
    )
    assert result.permitted is False
    assert any(v.violation_type == "period_expired" for v in result.hard_blocks)


def test_anonymous_agent_blocked() -> None:
    result = check_budget_constraints(
        action_value=100,
        currency="USD",
        action_type="refund",
        risk_tier="low",
        is_anonymous_agent=True,
        current_daily_spend=0,
        current_monthly_spend=0,
        applicable_limits=(),
        applicable_constraints=(_constraint(allow_anonymous_agents=False),),
    )
    assert result.permitted is False
    assert any(v.violation_type == "anonymous_agent_blocked" for v in result.hard_blocks)


def test_single_transaction_exceeds_blocks() -> None:
    result = check_budget_constraints(
        action_value=75_000,
        currency="USD",
        action_type="wire_transfer",
        risk_tier="high",
        is_anonymous_agent=False,
        current_daily_spend=0,
        current_monthly_spend=0,
        applicable_limits=(),
        applicable_constraints=(_constraint(max_single_transaction=50_000),),
    )
    assert result.permitted is False
    assert any(v.violation_type == "single_transaction_exceeds" for v in result.hard_blocks)


def test_daily_aggregate_exceeds_blocks() -> None:
    result = check_budget_constraints(
        action_value=20_000,
        currency="USD",
        action_type="wire_transfer",
        risk_tier="medium",
        is_anonymous_agent=False,
        current_daily_spend=85_000,
        current_monthly_spend=0,
        applicable_limits=(),
        applicable_constraints=(_constraint(
            max_single_transaction=50_000,
            max_daily_aggregate=100_000,
        ),),
    )
    assert result.permitted is False
    assert any(v.violation_type == "daily_aggregate_exceeds" for v in result.hard_blocks)


def test_monthly_aggregate_exceeds_blocks() -> None:
    result = check_budget_constraints(
        action_value=20_000,
        currency="USD",
        action_type="wire_transfer",
        risk_tier="medium",
        is_anonymous_agent=False,
        current_daily_spend=0,
        current_monthly_spend=985_000,
        applicable_limits=(),
        applicable_constraints=(_constraint(
            max_single_transaction=50_000,
            max_monthly_aggregate=1_000_000,
        ),),
    )
    assert result.permitted is False
    assert any(v.violation_type == "monthly_aggregate_exceeds" for v in result.hard_blocks)


def test_action_type_filter_skips_non_matching_constraints() -> None:
    # Constraint targets refunds; action is a wire transfer — constraint should not apply.
    result = check_budget_constraints(
        action_value=75_000,
        currency="USD",
        action_type="wire_transfer",
        risk_tier="medium",
        is_anonymous_agent=False,
        current_daily_spend=0,
        current_monthly_spend=0,
        applicable_limits=(),
        applicable_constraints=(_constraint(
            constraint_id="con_refund_only",
            action_type="refund",
            max_single_transaction=100,
        ),),
    )
    assert result.permitted is True


def test_severity_thresholds() -> None:
    assert budget_utilization_severity(0) == "normal"
    assert budget_utilization_severity(50) == "normal"
    assert budget_utilization_severity(79.99) == "normal"
    assert budget_utilization_severity(80) == "warn"
    assert budget_utilization_severity(99.99) == "warn"
    assert budget_utilization_severity(100) == "critical"
    assert budget_utilization_severity(150) == "critical"
