"""require_permit — richer execution-gate wrapper built on protect().

Usage::

    from atlasent import require_permit, ProtectedAction

    action = ProtectedAction(
        action_type="db.table.delete",
        actor_id="data-pipeline",
        resource_id="users",
        environment="production",
        context={"reason": "GDPR erasure request #4821"},
    )

    result = await require_permit(
        action,
        lambda: db.from_("users").delete().eq("id", user_id).execute(),
    )
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal, TypeVar

from .authorize import protect

T = TypeVar("T")

Environment = Literal["development", "staging", "production"]


class CanonicalProtectedActionType(str, Enum):
    """Catalog of built-in protected action types.

    Mirrors ``CanonicalProtectedActionType`` in the OpenAPI spec and the
    TypeScript SDK. Use these constants as ``action_type`` values in
    :class:`ProtectedAction` instead of bare strings::

        action = ProtectedAction(
            action_type=CanonicalProtectedActionType.DATABASE_TABLE_DELETE,
            actor_id="agent:data-pipeline",
            resource_id="prod-db.users",
            environment="production",
            context={"reason": "GDPR erasure"},
        )
    """

    PRODUCTION_DEPLOY = "production.deploy"
    HR_EMPLOYEE_OFFBOARD = "hr.employee.offboard"
    HR_ACCESS_REVOKE = "hr.access.revoke"
    HR_ROLE_ESCALATE = "hr.role.escalate"
    ML_MODEL_PROMOTE = "ml.model.promote"
    ML_MODEL_RETIRE = "ml.model.retire"
    ML_MODEL_FINE_TUNE = "ml.model.fine_tune"
    CUSTOMER_DATA_DELETE = "customer.data.delete"
    CONTRACT_EXECUTE = "contract.execute"
    CONTRACT_AMEND = "contract.amend"
    PRICING_RULE_PUBLISH = "pricing.rule.publish"
    PRICING_DISCOUNT_APPROVE = "pricing.discount.approve"
    SECURITY_INCIDENT_ESCALATE = "security.incident.escalate"
    SECURITY_ACCESS_QUARANTINE = "security.access.quarantine"
    ACCESS_CERT_REVOKE = "access.cert.revoke"
    PERIOD_CLOSE_CERTIFY = "period.close.certify"
    DATABASE_MIGRATION_APPLY = "database.migration.apply"
    DATABASE_SCHEMA_DROP = "database.schema.drop"
    DATABASE_TABLE_DELETE = "database.table.delete"


@dataclass(frozen=True)
class ProtectedAction:
    """Richer descriptor for a protected operation.

    Adds ``resource_id`` and ``environment`` to the base agent/action shape
    so every call site carries full audit context.
    """

    action_type: str
    actor_id: str
    resource_id: str
    environment: Environment
    context: dict[str, Any] = field(default_factory=dict)


async def require_permit(
    action: ProtectedAction,
    execute: Callable[[], Awaitable[T]],
) -> T:
    """Evaluate + verify a permit before invoking *execute*.

    Fail-closed: if :func:`protect` raises for any reason — deny, transport
    error, invalid permit — *execute* is never called.

    :param action: Full descriptor for the guarded operation.
    :param execute: Async callable containing the dangerous operation.
    :returns: Whatever *execute* returns on success.
    :raises AtlaSentDeniedError: When the permit is denied or invalid.
    :raises AtlaSentError: On transport or configuration failure.
    """
    await protect(
        agent=action.actor_id,
        action=action.action_type,
        context={
            "resource_id": action.resource_id,
            "environment": action.environment,
            **action.context,
        },
    )
    return await execute()


_DESTRUCTIVE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"rm\s+-rf", re.IGNORECASE),
    re.compile(r"DROP\s+TABLE", re.IGNORECASE),
    re.compile(r"DROP\s+DATABASE", re.IGNORECASE),
    re.compile(r"DELETE\s+FROM", re.IGNORECASE),
    re.compile(r"TRUNCATE\s+TABLE", re.IGNORECASE),
    re.compile(r"railway\s+volume\s+delete", re.IGNORECASE),
    re.compile(r"kubectl\s+delete", re.IGNORECASE),
    re.compile(r"terraform\s+destroy", re.IGNORECASE),
)


def classify_command(command: str) -> str | None:
    """Return ``"destructive.command"`` if *command* matches a known destructive
    pattern, otherwise ``None``.

    Use the result as ``action_type`` when building a :class:`ProtectedAction`
    for shell / SQL commands::

        action_type = classify_command(cmd)
        if action_type:
            await require_permit(ProtectedAction(action_type=action_type, ...), ...)

    :param command: Raw shell or SQL string to classify.
    :returns: ``"destructive.command"`` or ``None``.
    """
    return (
        "destructive.command"
        if any(p.search(command) for p in _DESTRUCTIVE_PATTERNS)
        else None
    )
