"""Contract action protect wrappers — Phase 4 vertical.

Covers contract execution (irreversible, critical) and amendment
(partial reversibility, high risk). Both actions require human review
and are fail-closed.
"""

from __future__ import annotations

from typing import Any, Literal

from atlasent.authorize import protect
from atlasent.models import Permit

ContractActionType = Literal[
    "contract.execute",
    "contract.amend",
]

_CONTRACT_RISK: dict[str, str] = {
    "contract.execute": "critical",
    "contract.amend": "high",
}

_CONTRACT_REVERSIBILITY: dict[str, str] = {
    "contract.execute": "irreversible",
    "contract.amend": "partial",
}

_MACHINE_EXECUTABLE = False
_FAIL_CLOSED = True


def protect_contract_action(
    action: ContractActionType,
    contract_id: str,
    authorized_by: str,
    **kwargs: Any,
) -> Permit:
    """Generic contract action protect wrapper.

    Args:
        action: One of the ``ContractActionType`` literals.
        contract_id: The contract being acted upon.
        authorized_by: Agent or human ID authorising the action.
        **kwargs: Action-specific fields. For ``contract.amend``,
            ``amendment_description`` is required. Optional overrides:
            ``assigned_to_role``, ``wait_ms``.

    Raises:
        ValueError: If ``amendment_description`` is missing for
            ``contract.amend``.
    """
    if action == "contract.amend" and not kwargs.get("amendment_description"):
        raise ValueError(
            "Contract action 'contract.amend' requires 'amendment_description'"
        )

    risk_level = _CONTRACT_RISK.get(action, "high")
    reversibility = _CONTRACT_REVERSIBILITY.get(action, "partial")
    quorum = "simple_majority" if risk_level == "critical" else "single_approver"

    context: dict[str, Any] = {
        "machine_executable": _MACHINE_EXECUTABLE,
        "risk_level": risk_level,
        "fail_closed": _FAIL_CLOSED,
        "contract_id": contract_id,
        "contract_action": action,
        "reversibility": reversibility,
        "hitl_escalation": {
            "assigned_to_role": kwargs.get("assigned_to_role", "legal-approver"),
            "quorum_required": kwargs.get("quorum_required", quorum),
            "wait_ms": kwargs.get("wait_ms", 86_400_000),  # 24 h
        },
    }

    if kwargs.get("amendment_description"):
        context["amendment_description"] = kwargs["amendment_description"]

    return protect(agent=authorized_by, action=action, context=context)


def protect_contract_execution(
    contract_id: str,
    authorized_by: str,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``contract.execute``.

    Args:
        contract_id: The contract being executed.
        authorized_by: Authorising agent/human ID.
        **kwargs: Optional overrides forwarded to ``protect_contract_action``.
    """
    return protect_contract_action(
        "contract.execute",
        contract_id,
        authorized_by,
        **kwargs,
    )
