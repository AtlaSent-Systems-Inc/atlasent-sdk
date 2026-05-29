"""HR action protect wrappers — Phase 4 vertical.

Covers employee offboarding, access revocation, and role escalation.
All non-machine-executable actions route through HITL escalation via
the ``hitl_escalation`` context key; the server-side resolver handles
quorum and assignment.
"""

from __future__ import annotations

from typing import Any, Literal

from atlasent.authorize import protect
from atlasent.models import Permit

HrActionType = Literal[
    "hr.employee.offboard",
    "hr.access.revoke",
    "hr.role.escalate",
]

_HR_RISK: dict[str, str] = {
    "hr.employee.offboard": "high",
    "hr.access.revoke": "high",
    "hr.role.escalate": "critical",
}

# Actions that can be executed by a machine without human review.
_MACHINE_EXECUTABLE: set[str] = {"hr.access.revoke"}


def protect_hr_action(
    action: HrActionType,
    employee_id: str,
    authorized_by: str,
    **kwargs: Any,
) -> Permit:
    """Generic HR action protect wrapper.

    Args:
        action: One of the ``HrActionType`` literals.
        employee_id: The employee being acted upon.
        authorized_by: Agent or human ID authorising the action.
        **kwargs: Action-specific fields (``effective_date``,
            ``offboarding_reason``, ``requested_role``,
            ``business_justification``) plus optional overrides
            (``assigned_to_role``, ``wait_ms``).

    Raises:
        ValueError: If required action-specific fields are missing.
    """
    if action == "hr.employee.offboard":
        if not kwargs.get("effective_date"):
            raise ValueError(
                "HR action 'hr.employee.offboard' requires 'effective_date'"
            )
        if not kwargs.get("offboarding_reason"):
            raise ValueError(
                "HR action 'hr.employee.offboard' requires 'offboarding_reason'"
            )

    if action == "hr.role.escalate":
        if not kwargs.get("requested_role"):
            raise ValueError(
                "HR action 'hr.role.escalate' requires 'requested_role'"
            )
        if not kwargs.get("business_justification"):
            raise ValueError(
                "HR action 'hr.role.escalate' requires 'business_justification'"
            )

    risk_level = _HR_RISK.get(action, "high")
    machine_executable = action in _MACHINE_EXECUTABLE

    context: dict[str, Any] = {
        "machine_executable": machine_executable,
        "risk_level": risk_level,
        "employee_id": employee_id,
        "hr_action": action,
    }

    # Offboard-specific fields
    if kwargs.get("effective_date"):
        context["effective_date"] = kwargs["effective_date"]
    if kwargs.get("offboarding_reason"):
        context["offboarding_reason"] = kwargs["offboarding_reason"]

    # Role-escalate-specific fields
    if kwargs.get("requested_role"):
        context["requested_role"] = kwargs["requested_role"]
    if kwargs.get("business_justification"):
        context["business_justification"] = kwargs["business_justification"]

    if not machine_executable:
        quorum = "simple_majority" if risk_level == "critical" else "single_approver"
        context["hitl_escalation"] = {
            "assigned_to_role": kwargs.get("assigned_to_role", "hr-approver"),
            "quorum_required": quorum,
            "wait_ms": kwargs.get("wait_ms", 86_400_000),  # 24 h default
        }

    return protect(agent=authorized_by, action=action, context=context)


def protect_hr_offboard(
    employee_id: str,
    authorized_by: str,
    effective_date: str,
    offboarding_reason: str,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``hr.employee.offboard``.

    Args:
        employee_id: Target employee ID.
        authorized_by: Authorising agent/human ID.
        effective_date: ISO-8601 date string for the offboarding date.
        offboarding_reason: Human-readable reason for offboarding.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``).
    """
    return protect_hr_action(
        "hr.employee.offboard",
        employee_id,
        authorized_by,
        effective_date=effective_date,
        offboarding_reason=offboarding_reason,
        **kwargs,
    )


def protect_hr_role_escalate(
    employee_id: str,
    authorized_by: str,
    requested_role: str,
    business_justification: str,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``hr.role.escalate``.

    Args:
        employee_id: Target employee ID.
        authorized_by: Authorising agent/human ID.
        requested_role: Role being requested.
        business_justification: Reason for the escalation.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``).
    """
    return protect_hr_action(
        "hr.role.escalate",
        employee_id,
        authorized_by,
        requested_role=requested_role,
        business_justification=business_justification,
        **kwargs,
    )
