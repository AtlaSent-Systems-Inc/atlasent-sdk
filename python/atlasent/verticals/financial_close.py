"""Financial period-close certification protect wrappers — Phase 5 vertical.

Period-close certifications are critical-risk, machine_executable=False,
fail-closed, and require financial controller approval within 48 hours.
"""

from __future__ import annotations

from typing import Any, Literal

from atlasent.authorize import protect
from atlasent.models import Permit

FinancialCloseActionType = Literal["period.close.certify"]

_RISK_LEVEL = "critical"
_MACHINE_EXECUTABLE = False
_FAIL_CLOSED = True
_ASSIGNED_TO_ROLE = "financial-controller"
_QUORUM = "simple_majority"
_WAIT_MS = 48 * 60 * 60 * 1000  # 48 h


def protect_financial_close_action(
    action: FinancialCloseActionType,
    period_id: str,
    authorized_by: str,
    certified_by: str,
    financial_controller: str,
    **kwargs: Any,
) -> Permit:
    """Generic financial close action protect wrapper.

    Args:
        action: Must be ``"period.close.certify"``.
        period_id: Accounting period identifier (e.g. ``"2026-Q1"``).
        authorized_by: Agent or human ID authorising the action.
        certified_by: Identity of the person certifying the close.
        financial_controller: Financial controller responsible for
            sign-off.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``).
    """
    context: dict[str, Any] = {
        "machine_executable": _MACHINE_EXECUTABLE,
        "risk_level": _RISK_LEVEL,
        "fail_closed": _FAIL_CLOSED,
        "period_id": period_id,
        "financial_close_action": action,
        "certified_by": certified_by,
        "financial_controller": financial_controller,
        "hitl_escalation": {
            "assigned_to_role": kwargs.get("assigned_to_role", _ASSIGNED_TO_ROLE),
            "quorum_required": kwargs.get("quorum_required", _QUORUM),
            "wait_ms": kwargs.get("wait_ms", _WAIT_MS),
        },
    }

    return protect(agent=authorized_by, action=action, context=context)


def protect_period_close_certify(
    period_id: str,
    authorized_by: str,
    certified_by: str,
    financial_controller: str,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``period.close.certify``.

    Args:
        period_id: Accounting period identifier.
        authorized_by: Authorising agent/human ID.
        certified_by: Identity of the certifier.
        financial_controller: Financial controller for sign-off.
        **kwargs: Optional overrides forwarded to
            ``protect_financial_close_action``.
    """
    return protect_financial_close_action(
        "period.close.certify",
        period_id,
        authorized_by,
        certified_by,
        financial_controller,
        **kwargs,
    )
