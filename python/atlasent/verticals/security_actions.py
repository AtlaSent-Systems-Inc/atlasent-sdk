"""Security action protect wrappers — Phase 5 vertical.

Covers incident escalation and access quarantine. Both are critical-risk,
machine_executable=False, fail-closed, and route to the security-approver
role via HITL escalation.
"""

from __future__ import annotations

from typing import Any, Literal

from atlasent.authorize import protect
from atlasent.models import Permit

SecurityActionType = Literal[
    "security.incident.escalate",
    "security.access.quarantine",
]

SecurityIncidentSeverity = Literal["low", "medium", "high", "critical"]

_RISK_LEVEL = "critical"
_MACHINE_EXECUTABLE = False
_FAIL_CLOSED = True
_ASSIGNED_TO_ROLE = "security-approver"
_QUORUM = "simple_majority"
_WAIT_MS = 60 * 60 * 1000  # 1 h


def protect_security_action(
    action: SecurityActionType,
    actor_id: str,
    authorized_by: str,
    **kwargs: Any,
) -> Permit:
    """Generic security action protect wrapper.

    Args:
        action: One of the ``SecurityActionType`` literals.
        actor_id: The resource/entity being acted upon (incident ID or
            target access ID).
        authorized_by: Agent or human ID authorising the action.
        **kwargs: Action-specific fields. For
            ``security.incident.escalate``: ``incident_id`` and
            ``severity`` (``SecurityIncidentSeverity``) are required.
            For ``security.access.quarantine``: ``target_id`` and
            ``quarantine_reason`` are required. Optional overrides:
            ``assigned_to_role``, ``wait_ms``.

    Raises:
        ValueError: If required action-specific fields are missing.
    """
    if action == "security.incident.escalate":
        if not kwargs.get("incident_id"):
            raise ValueError(
                "Security action 'security.incident.escalate' requires 'incident_id'"
            )
        if not kwargs.get("severity"):
            raise ValueError(
                "Security action 'security.incident.escalate' requires 'severity'"
            )
        _valid_severities = ("low", "medium", "high", "critical")
        if kwargs["severity"] not in _valid_severities:
            raise ValueError(
                f"Invalid severity '{kwargs['severity']}'. "
                f"Must be one of: {', '.join(_valid_severities)}"
            )

    if action == "security.access.quarantine":
        if not kwargs.get("target_id"):
            raise ValueError(
                "Security action 'security.access.quarantine' requires 'target_id'"
            )
        if not kwargs.get("quarantine_reason"):
            raise ValueError(
                "Security action 'security.access.quarantine' requires "
                "'quarantine_reason'"
            )

    context: dict[str, Any] = {
        "machine_executable": _MACHINE_EXECUTABLE,
        "risk_level": _RISK_LEVEL,
        "fail_closed": _FAIL_CLOSED,
        "actor_id": actor_id,
        "security_action": action,
        "hitl_escalation": {
            "assigned_to_role": kwargs.get("assigned_to_role", _ASSIGNED_TO_ROLE),
            "quorum_required": kwargs.get("quorum_required", _QUORUM),
            "wait_ms": kwargs.get("wait_ms", _WAIT_MS),
        },
    }

    # Incident-specific fields
    if kwargs.get("incident_id"):
        context["incident_id"] = kwargs["incident_id"]
    if kwargs.get("severity"):
        context["severity"] = kwargs["severity"]

    # Quarantine-specific fields
    if kwargs.get("target_id"):
        context["target_id"] = kwargs["target_id"]
    if kwargs.get("quarantine_reason"):
        context["quarantine_reason"] = kwargs["quarantine_reason"]

    return protect(agent=authorized_by, action=action, context=context)


def protect_security_incident_escalate(
    incident_id: str,
    severity: SecurityIncidentSeverity,
    authorized_by: str,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``security.incident.escalate``.

    Args:
        incident_id: Identifier of the security incident.
        severity: One of ``SecurityIncidentSeverity``.
        authorized_by: Authorising agent/human ID.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``).
    """
    return protect_security_action(
        "security.incident.escalate",
        incident_id,
        authorized_by,
        incident_id=incident_id,
        severity=severity,
        **kwargs,
    )


def protect_security_access_quarantine(
    target_id: str,
    quarantine_reason: str,
    authorized_by: str,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``security.access.quarantine``.

    Args:
        target_id: ID of the access target being quarantined.
        quarantine_reason: Human-readable reason for quarantine.
        authorized_by: Authorising agent/human ID.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``).
    """
    return protect_security_action(
        "security.access.quarantine",
        target_id,
        authorized_by,
        target_id=target_id,
        quarantine_reason=quarantine_reason,
        **kwargs,
    )
