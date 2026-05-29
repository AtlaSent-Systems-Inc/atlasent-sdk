"""Customer data deletion protect wrappers — Phase 4 vertical.

GDPR/data-subject erasure requests. Always routes to a compliance
officer via HITL escalation with a 72-hour wait window.
"""

from __future__ import annotations

from typing import Any, Literal

from atlasent.authorize import protect
from atlasent.models import Permit

DataDeleteActionType = Literal["customer.data.delete"]

GdprLegalBasis = Literal[
    "erasure_request",
    "retention_expired",
    "consent_withdrawn",
    "controller_instruction",
]

_RISK_LEVEL = "critical"
_MACHINE_EXECUTABLE = False
_FAIL_CLOSED = True
_ASSIGNED_TO_ROLE = "compliance-officer"
_QUORUM = "simple_majority"
_WAIT_MS = 72 * 60 * 60 * 1000  # 72 h


def protect_customer_data_delete(
    data_subject_id: str,
    authorized_by: str,
    gdpr_basis: GdprLegalBasis,
    verified_by: str,
    **kwargs: Any,
) -> Permit:
    """Protect a customer data deletion request.

    Args:
        data_subject_id: Identifier of the data subject whose data will
            be deleted.
        authorized_by: Agent or human ID authorising the deletion.
        gdpr_basis: Legal basis for the deletion (one of
            ``GdprLegalBasis``).
        verified_by: Identity of the person who verified the request.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``).

    Raises:
        ValueError: If ``gdpr_basis`` is not a valid ``GdprLegalBasis``.
    """
    _valid_bases: tuple[str, ...] = (
        "erasure_request",
        "retention_expired",
        "consent_withdrawn",
        "controller_instruction",
    )
    if gdpr_basis not in _valid_bases:
        raise ValueError(
            f"Invalid gdpr_basis '{gdpr_basis}'. "
            f"Must be one of: {', '.join(_valid_bases)}"
        )

    context: dict[str, Any] = {
        "machine_executable": _MACHINE_EXECUTABLE,
        "risk_level": _RISK_LEVEL,
        "fail_closed": _FAIL_CLOSED,
        "data_subject_id": data_subject_id,
        "gdpr_basis": gdpr_basis,
        "verified_by": verified_by,
        "hitl_escalation": {
            "assigned_to_role": kwargs.get("assigned_to_role", _ASSIGNED_TO_ROLE),
            "quorum_required": kwargs.get("quorum_required", _QUORUM),
            "wait_ms": kwargs.get("wait_ms", _WAIT_MS),
        },
    }

    return protect(agent=authorized_by, action="customer.data.delete", context=context)
