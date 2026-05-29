"""Access certificate revocation protect wrappers — Phase 5 vertical.

Certificate revocations are high-risk, machine_executable=False, and
require a single security approver within 24 hours.
"""

from __future__ import annotations

from typing import Any, Literal

from atlasent.authorize import protect
from atlasent.models import Permit

AccessCertActionType = Literal["access.cert.revoke"]

_RISK_LEVEL = "high"
_MACHINE_EXECUTABLE = False
_ASSIGNED_TO_ROLE = "security-approver"
_QUORUM = "single_approver"
_WAIT_MS = 24 * 60 * 60 * 1000  # 24 h


def protect_access_cert_action(
    action: AccessCertActionType,
    cert_id: str,
    authorized_by: str,
    revocation_reason: str,
    **kwargs: Any,
) -> Permit:
    """Generic access certificate action protect wrapper.

    Args:
        action: Must be ``"access.cert.revoke"``.
        cert_id: Certificate ID to revoke.
        authorized_by: Agent or human ID authorising the revocation.
        revocation_reason: Human-readable reason for revocation.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``).
    """
    context: dict[str, Any] = {
        "machine_executable": _MACHINE_EXECUTABLE,
        "risk_level": _RISK_LEVEL,
        "cert_id": cert_id,
        "cert_action": action,
        "revocation_reason": revocation_reason,
        "hitl_escalation": {
            "assigned_to_role": kwargs.get("assigned_to_role", _ASSIGNED_TO_ROLE),
            "quorum_required": kwargs.get("quorum_required", _QUORUM),
            "wait_ms": kwargs.get("wait_ms", _WAIT_MS),
        },
    }

    return protect(agent=authorized_by, action=action, context=context)


def protect_access_cert_revoke(
    cert_id: str,
    authorized_by: str,
    revocation_reason: str,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``access.cert.revoke``.

    Args:
        cert_id: Certificate ID to revoke.
        authorized_by: Authorising agent/human ID.
        revocation_reason: Human-readable reason for revocation.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``).
    """
    return protect_access_cert_action(
        "access.cert.revoke",
        cert_id,
        authorized_by,
        revocation_reason,
        **kwargs,
    )
