"""Tests for atlasent.governance.enforcement.

Verifies:
- Permitted advisory results pass through silently.
- Failing advisory results raise GovernanceEnforcementError with the
  expected deny_code (matches docs/APPROVAL_DENY_REASONS.md).
- The fully_qualified_code is stable cross-language (string format
  matches the canonical fixture).
- The combined enforce_economic_governance helper short-circuits on
  the first failing gate.
"""

from __future__ import annotations

import pytest

from atlasent.governance import (
    AutonomousExecutionCheckResult,
    BudgetConstraintCheckResult,
    BudgetViolation,
    ExecutionCeiling,
    FinancialQuorumResult,
)
from atlasent.governance.enforcement import (
    GovernanceEnforcementError,
    enforce_autonomous_bounds,
    enforce_budget_constraint,
    enforce_economic_governance,
    enforce_financial_quorum,
)


# ─── financial_quorum ──────────────────────────────────────────────────


def _quorum(
    *,
    passed: bool = False,
    base_quorum_passed: bool = True,
    amount_threshold_satisfied: bool = True,
    financial_roles_satisfied: bool = True,
    regulator_approval_missing: bool = False,
    blocked_by_freeze: bool = False,
    denial_reason: str | None = None,
) -> FinancialQuorumResult:
    return FinancialQuorumResult(
        passed=passed,
        base_quorum_passed=base_quorum_passed,
        amount_threshold_satisfied=amount_threshold_satisfied,
        financial_roles_satisfied=financial_roles_satisfied,
        regulator_approval_missing=regulator_approval_missing,
        blocked_by_freeze=blocked_by_freeze,
        base_quorum_proof=None,
        denial_reason=denial_reason,
        unmet_requirements=(),
    )


def test_quorum_passes_silently_when_passed() -> None:
    enforce_financial_quorum(_quorum(passed=True))
    # No exception — test passes by reaching this point.


def test_quorum_blocked_by_freeze() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_financial_quorum(_quorum(
            blocked_by_freeze=True,
            denial_reason="action blocked by emergency freeze (frz_001)",
        ))
    err = exc_info.value
    assert err.gate == "financial_quorum"
    assert err.deny_code == "blocked_by_emergency_freeze"
    assert err.fully_qualified_code == "financial_quorum/blocked_by_emergency_freeze"
    assert "frz_001" in err.reason


def test_quorum_base_count_unmet() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_financial_quorum(_quorum(base_quorum_passed=False))
    assert exc_info.value.deny_code == "base_count_unmet"


def test_quorum_amount_threshold_unmet() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_financial_quorum(_quorum(amount_threshold_satisfied=False))
    assert exc_info.value.deny_code == "amount_threshold_unmet"


def test_quorum_financial_role_unmet() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_financial_quorum(_quorum(financial_roles_satisfied=False))
    assert exc_info.value.deny_code == "financial_role_unmet"


def test_quorum_regulator_approval_missing() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_financial_quorum(_quorum(regulator_approval_missing=True))
    assert exc_info.value.deny_code == "regulator_approval_missing"


def test_quorum_check_order_freeze_first() -> None:
    # Multiple checks failing simultaneously — freeze must win.
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_financial_quorum(_quorum(
            blocked_by_freeze=True,
            base_quorum_passed=False,
            amount_threshold_satisfied=False,
        ))
    assert exc_info.value.deny_code == "blocked_by_emergency_freeze"


# ─── budget ─────────────────────────────────────────────────────────────────


def _budget_with_violations(
    *violations: BudgetViolation,
) -> BudgetConstraintCheckResult:
    return BudgetConstraintCheckResult(
        permitted=len(violations) == 0,
        hard_blocks=violations,
        soft_warnings=(),
        limits_checked=(),
        constraints_checked=(),
    )


def test_budget_passes_silently_when_permitted() -> None:
    enforce_budget_constraint(_budget_with_violations())


def test_budget_passes_when_only_soft_warnings() -> None:
    result = BudgetConstraintCheckResult(
        permitted=True,
        hard_blocks=(),
        soft_warnings=(BudgetViolation(
            violation_type="limit_exceeded",
            description="soft warning only",
        ),),
        limits_checked=(),
        constraints_checked=(),
    )
    enforce_budget_constraint(result)


def test_budget_limit_exceeded() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_budget_constraint(_budget_with_violations(BudgetViolation(
            violation_type="limit_exceeded",
            description="Action would exceed department limit",
        )))
    assert exc_info.value.gate == "budget"
    assert exc_info.value.deny_code == "limit_exceeded"


def test_budget_anonymous_agent_blocked() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_budget_constraint(_budget_with_violations(BudgetViolation(
            violation_type="anonymous_agent_blocked",
            description="Anonymous agents not permitted for refund",
        )))
    assert exc_info.value.deny_code == "anonymous_agent_blocked"


def test_budget_period_expired() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_budget_constraint(_budget_with_violations(BudgetViolation(
            violation_type="period_expired",
            description="Budget limit period expired",
        )))
    assert exc_info.value.deny_code == "period_expired"


def test_budget_first_violation_wins() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_budget_constraint(_budget_with_violations(
            BudgetViolation(
                violation_type="single_transaction_exceeds",
                description="first",
            ),
            BudgetViolation(
                violation_type="daily_aggregate_exceeds",
                description="second",
            ),
        ))
    assert exc_info.value.deny_code == "single_transaction_exceeds"


# ─── autonomous_bounds ────────────────────────────────────────────────────


def _autonomous(
    *,
    permitted: bool = False,
    bounds_active: bool = True,
    bounds_not_expired: bool = True,
    action_type_permitted: bool = True,
    within_execution_ceiling: bool = True,
    within_daily_aggregate: bool = True,
    within_risk_tier: bool = True,
    denial_reason: str | None = None,
    applicable_ceiling: ExecutionCeiling | None = None,
) -> AutonomousExecutionCheckResult:
    return AutonomousExecutionCheckResult(
        permitted=permitted,
        action_type_permitted=action_type_permitted,
        within_execution_ceiling=within_execution_ceiling,
        within_daily_aggregate=within_daily_aggregate,
        within_risk_tier=within_risk_tier,
        bounds_active=bounds_active,
        bounds_not_expired=bounds_not_expired,
        applicable_ceiling=applicable_ceiling,
        denial_reason=denial_reason,
        violations=(),
    )


def test_autonomous_passes_silently_when_permitted() -> None:
    enforce_autonomous_bounds(_autonomous(permitted=True))


def test_autonomous_inactive() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_autonomous_bounds(_autonomous(bounds_active=False))
    assert exc_info.value.gate == "autonomous_bounds"
    assert exc_info.value.deny_code == "inactive"


def test_autonomous_expired() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_autonomous_bounds(_autonomous(bounds_not_expired=False))
    assert exc_info.value.deny_code == "expired"


def test_autonomous_action_type_not_permitted() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_autonomous_bounds(_autonomous(action_type_permitted=False))
    assert exc_info.value.deny_code == "action_type_not_permitted"


def test_autonomous_execution_ceiling_exceeded() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_autonomous_bounds(_autonomous(within_execution_ceiling=False))
    assert exc_info.value.deny_code == "execution_ceiling_exceeded"


def test_autonomous_daily_aggregate_exceeded() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_autonomous_bounds(_autonomous(within_daily_aggregate=False))
    assert exc_info.value.deny_code == "daily_aggregate_exceeded"


def test_autonomous_risk_tier_exceeded() -> None:
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_autonomous_bounds(_autonomous(within_risk_tier=False))
    assert exc_info.value.deny_code == "risk_tier_exceeded"


def test_autonomous_check_order_inactive_first() -> None:
    # All checks failing — inactive must win.
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_autonomous_bounds(_autonomous(
            bounds_active=False,
            bounds_not_expired=False,
            action_type_permitted=False,
            within_risk_tier=False,
        ))
    assert exc_info.value.deny_code == "inactive"


# ─── enforce_economic_governance ─────────────────────────────────────────────


def test_combined_passes_when_all_permitted() -> None:
    enforce_economic_governance(
        quorum=_quorum(passed=True),
        budget=_budget_with_violations(),
        autonomous=_autonomous(permitted=True),
    )


def test_combined_short_circuits_on_quorum_failure() -> None:
    # Quorum fails first; budget and autonomous failures should not surface.
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_economic_governance(
            quorum=_quorum(base_quorum_passed=False),
            budget=_budget_with_violations(BudgetViolation(
                violation_type="limit_exceeded",
                description="would also fail",
            )),
            autonomous=_autonomous(bounds_active=False),
        )
    assert exc_info.value.gate == "financial_quorum"
    assert exc_info.value.deny_code == "base_count_unmet"


def test_combined_handles_omitted_gates() -> None:
    # Budget and autonomous omitted — only quorum is checked.
    enforce_economic_governance(quorum=_quorum(passed=True))
    # No exception.


def test_combined_quorum_then_budget() -> None:
    # Quorum passes; budget fails — budget code surfaces.
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_economic_governance(
            quorum=_quorum(passed=True),
            budget=_budget_with_violations(BudgetViolation(
                violation_type="daily_aggregate_exceeds",
                description="daily limit",
            )),
        )
    assert exc_info.value.gate == "budget"
    assert exc_info.value.deny_code == "daily_aggregate_exceeds"


def test_error_inherits_atlasent_error() -> None:
    # Existing ``except AtlaSentError`` handlers must catch governance enforcement.
    from atlasent.exceptions import AtlaSentError
    with pytest.raises(AtlaSentError):
        enforce_financial_quorum(_quorum(base_quorum_passed=False))


def test_error_carries_details_for_audit() -> None:
    failing = _quorum(base_quorum_passed=False)
    with pytest.raises(GovernanceEnforcementError) as exc_info:
        enforce_financial_quorum(failing)
    assert exc_info.value.details is failing
