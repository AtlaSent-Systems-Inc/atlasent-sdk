"""ML model governance protect wrappers — Phase 4 vertical.

All model governance actions are critical-risk, machine_executable=False,
and route through the ML governance board via HITL escalation.
"""

from __future__ import annotations

from typing import Any, Literal

from atlasent.authorize import protect
from atlasent.models import Permit

ModelGovernanceActionType = Literal[
    "ml.model.promote",
    "ml.model.retire",
    "ml.model.fine_tune",
]

# All model governance actions share these defaults.
_RISK_LEVEL = "critical"
_MACHINE_EXECUTABLE = False
_FAIL_CLOSED = True
_ASSIGNED_TO_ROLE = "ml-governance-board"
_QUORUM = "simple_majority"
_WAIT_MS = 48 * 60 * 60 * 1000  # 48 h


def protect_model_governance(
    action: ModelGovernanceActionType,
    model_id: str,
    authorized_by: str,
    **kwargs: Any,
) -> Permit:
    """Generic ML model governance protect wrapper.

    Args:
        action: One of the ``ModelGovernanceActionType`` literals.
        model_id: The ML model being governed.
        authorized_by: Agent or human ID authorising the action.
        **kwargs: Optional fields (``reason``, ``safety_review_id``,
            ``service_impact_assessed``, ``alignment_verified``,
            ``target_environment``) plus optional overrides
            (``assigned_to_role``, ``wait_ms``).
    """
    context: dict[str, Any] = {
        "machine_executable": _MACHINE_EXECUTABLE,
        "risk_level": _RISK_LEVEL,
        "fail_closed": _FAIL_CLOSED,
        "model_id": model_id,
        "model_action": action,
        "hitl_escalation": {
            "assigned_to_role": kwargs.get("assigned_to_role", _ASSIGNED_TO_ROLE),
            "quorum_required": kwargs.get("quorum_required", _QUORUM),
            "wait_ms": kwargs.get("wait_ms", _WAIT_MS),
        },
    }

    # Optional supplementary fields
    for field in (
        "reason",
        "safety_review_id",
        "service_impact_assessed",
        "alignment_verified",
        "target_environment",
    ):
        if field in kwargs:
            context[field] = kwargs[field]

    return protect(agent=authorized_by, action=action, context=context)


def protect_model_promotion(
    model_id: str,
    authorized_by: str,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``ml.model.promote``.

    Args:
        model_id: The ML model being promoted.
        authorized_by: Authorising agent/human ID.
        **kwargs: Optional fields forwarded to ``protect_model_governance``.
    """
    return protect_model_governance(
        "ml.model.promote",
        model_id,
        authorized_by,
        **kwargs,
    )
