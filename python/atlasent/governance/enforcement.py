"""Enforcement-layer helpers for the canonical economic governance primitives.

The canonical EGAS modules in :mod:`atlasent.governance` are **advisory**:
they produce structured decision objects (e.g. :class:`FinancialQuorumResult`)
but never block execution. This module converts "not permitted" advisory
results into thrown :class:`GovernanceEnforcementError` so callers cannot
silently proceed when a governance gate refuses an action.

Three gates, layered in this order at consumer call sites::

    enforce_financial_quorum(quorum_result)
    enforce_budget_constraint(budget_result)
    enforce_autonomous_bounds(autonomous_result)

Each helper is a no-op when its result is permitted; otherwise it raises
with a stable :attr:`GovernanceEnforcementError.deny_code` matching a row
in ``docs/APPROVAL_DENY_REASONS.md``. The deny-code taxonomy is locked
cross-language by the parity fixture at
``compat/governance/fixtures/parity.json``.

Note: this module deliberately does NOT cover dispute / reversal / freeze
lifecycle enforcement. Those are state-machine workflows, not point-in-time
gates.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from ..exceptions import AtlaSentError
from .autonomous_financial import AutonomousExecutionCheckResult
from .budgetary_governance import BudgetConstraintCheckResult
from .financial_quorum import FinancialQuorumResult

GovernanceGate = Literal["financial_quorum", "budget", "autonomous_bounds"]

FinancialQuorumDenyCode = Literal[
    "blocked_by_emergency_freeze",
    "base_count_unmet",
    "amount_threshold_unmet",
    "financial_role_unmet",
    "regulator_approval_missing",
]

BudgetDenyCode = Literal[
    "limit_exceeded",
    "single_transaction_exceeds",
    "daily_aggregate_exceeds",
    "monthly_aggregate_exceeds",
    "anonymous_agent_blocked",
    "period_expired",
]

AutonomousBoundsDenyCode = Literal[
    "inactive",
    "expired",
    "action_type_not_permitted",
    "execution_ceiling_exceeded",
    "daily_aggregate_exceeded",
    "risk_tier_exceeded",
]


class GovernanceEnforcementError(AtlaSentError):
    """Raised when an EGAS advisory result fails an enforcement gate.

    Subclasses :class:`AtlaSentError` so existing ``except AtlaSentError``
    catches these too. Use ``except GovernanceEnforcementError`` to
    distinguish a governance refusal from a transport / config error.

    Attributes:
        gate: Which enforcement gate fired (``financial_quorum`` /
            ``budget`` / ``autonomous_bounds``).
        deny_code: Stable taxonomy code for the specific failure. Maps
            to a row in ``docs/APPROVAL_DENY_REASONS.md``. Cross-language
            stable: the TS SDK raises the same code string for the same
            advisory failure.
        reason: Human-readable explanation pulled from the advisory
            result. Suitable for logs and error messages; do NOT branch
            on this string—branch on :attr:`deny_code`.
        details: The structured advisory result object that produced
            the denial. Useful for audit logs and dispute attribution.
    """

    def __init__(
        self,
        *,
        gate: GovernanceGate,
        deny_code: str,
        reason: str,
        details: Any,
        request_id: Optional[str] = None,
    ) -> None:
        self.gate: GovernanceGate = gate
        self.deny_code: str = deny_code
        self.reason: str = reason
        self.details: Any = details
        super().__init__(
            f"[{gate}/{deny_code}] {reason}",
            code="forbidden",
            request_id=request_id,
        )

    @property
    def fully_qualified_code(self) -> str:
        """Combined ``<gate>/<deny_code>`` string used in audit records.

        Stable cross-language. Matches the row keys in
        ``docs/APPROVAL_DENY_REASONS.md``.
        """
        return f"{self.gate}/{self.deny_code}"


# ─── financial_quorum ──────────────────────────────────────────────────


def _financial_quorum_deny_code(result: FinancialQuorumResult) -> FinancialQuorumDenyCode:
    """Map a failing :class:`FinancialQuorumResult` to a stable deny code.

    Check order matches the canonical TS ``evaluateFinancialQuorum`` so the
    "first failing gate wins" rule produces the same code in both SDKs.
    """
    if result.blocked_by_freeze:
        return "blocked_by_emergency_freeze"
    if not result.base_quorum_passed:
        return "base_count_unmet"
    if not result.amount_threshold_satisfied:
        return "amount_threshold_unmet"
    if not result.financial_roles_satisfied:
        return "financial_role_unmet"
    if result.regulator_approval_missing:
        return "regulator_approval_missing"
    # Should be unreachable when result.passed is False; defensive fallback.
    return "base_count_unmet"


def enforce_financial_quorum(result: FinancialQuorumResult) -> None:
    """Raise :class:`GovernanceEnforcementError` if a quorum result fails.

    Returns ``None`` when ``result.passed`` is True. Otherwise raises with
    a deny code from :data:`FinancialQuorumDenyCode`.
    """
    if result.passed:
        return
    deny_code = _financial_quorum_deny_code(result)
    raise GovernanceEnforcementError(
        gate="financial_quorum",
        deny_code=deny_code,
        reason=result.denial_reason or f"financial quorum failed: {deny_code}",
        details=result,
    )


# ─── budget ─────────────────────────────────────────────────────────────────


def enforce_budget_constraint(result: BudgetConstraintCheckResult) -> None:
    """Raise :class:`GovernanceEnforcementError` on a budget hard block.

    Returns ``None`` when ``result.permitted`` is True (which means no
    hard blocks; soft warnings do not cause enforcement to fire). Otherwise
    raises with the deny code matching the first hard block's
    ``violation_type``.
    """
    if result.permitted:
        return
    if not result.hard_blocks:
        # Defensive: result.permitted=False without a hard block is a contract
        # bug in the producer. Raise with a generic code rather than a misleading one.
        raise GovernanceEnforcementError(
            gate="budget",
            deny_code="limit_exceeded",
            reason="budget enforcement failed without a structured violation",
            details=result,
        )
    first = result.hard_blocks[0]
    raise GovernanceEnforcementError(
        gate="budget",
        deny_code=first.violation_type,
        reason=first.description,
        details=result,
    )


# ─── autonomous_bounds ────────────────────────────────────────────────────


def _autonomous_bounds_deny_code(
    result: AutonomousExecutionCheckResult,
) -> AutonomousBoundsDenyCode:
    """Map a failing :class:`AutonomousExecutionCheckResult` to a stable deny code.

    Check order matches the canonical TS ``checkAutonomousBounds`` so the
    "first failing gate wins" rule produces the same code in both SDKs.
    """
    if not result.bounds_active:
        return "inactive"
    if not result.bounds_not_expired:
        return "expired"
    if not result.action_type_permitted:
        return "action_type_not_permitted"
    if not result.within_execution_ceiling:
        return "execution_ceiling_exceeded"
    if not result.within_daily_aggregate:
        return "daily_aggregate_exceeded"
    if not result.within_risk_tier:
        return "risk_tier_exceeded"
    # Defensive fallback; unreachable when permitted is False.
    return "inactive"


def enforce_autonomous_bounds(result: AutonomousExecutionCheckResult) -> None:
    """Raise :class:`GovernanceEnforcementError` if autonomous bounds fail.

    Returns ``None`` when ``result.permitted`` is True. Otherwise raises
    with a deny code from :data:`AutonomousBoundsDenyCode`.
    """
    if result.permitted:
        return
    deny_code = _autonomous_bounds_deny_code(result)
    raise GovernanceEnforcementError(
        gate="autonomous_bounds",
        deny_code=deny_code,
        reason=result.denial_reason or f"autonomous execution out of bounds: {deny_code}",
        details=result,
    )


def enforce_economic_governance(
    *,
    quorum: Optional[FinancialQuorumResult] = None,
    budget: Optional[BudgetConstraintCheckResult] = None,
    autonomous: Optional[AutonomousExecutionCheckResult] = None,
) -> None:
    """Convenience: layer all three gates in canonical order.

    Order matches the natural authorization sequence: quorum (who approved)
    → budget (does it fit policy spend) → autonomous_bounds (is the agent
    allowed to do this autonomously). The first failing gate raises;
    subsequent gates are not evaluated.

    Pass ``None`` for gates that don't apply to the action (e.g. omit
    ``autonomous`` for human-initiated actions).
    """
    if quorum is not None:
        enforce_financial_quorum(quorum)
    if budget is not None:
        enforce_budget_constraint(budget)
    if autonomous is not None:
        enforce_autonomous_bounds(autonomous)


__all__ = [
    "AutonomousBoundsDenyCode",
    "BudgetDenyCode",
    "FinancialQuorumDenyCode",
    "GovernanceEnforcementError",
    "GovernanceGate",
    "enforce_autonomous_bounds",
    "enforce_budget_constraint",
    "enforce_economic_governance",
    "enforce_financial_quorum",
]
