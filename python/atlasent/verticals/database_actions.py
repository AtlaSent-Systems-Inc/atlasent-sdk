"""Database action protect wrappers — Phase 6 vertical.

Covers migration apply (high risk) and destructive schema/table
operations (critical risk). Destructive actions are always
machine_executable=False and deny_by_default=True; migration in
production is machine_executable=False and escalates to a database-admin
with single_approver quorum; migration in staging/development uses the
direct protect() path.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Union

from atlasent.authorize import protect
from atlasent.exceptions import AtlaSentDeniedError
from atlasent.models import Permit

DatabaseMigrationActionType = Literal["database.migration.apply"]
DatabaseDestructiveActionType = Literal[
    "database.schema.drop",
    "database.table.delete",
]
DatabaseActionType = Union[DatabaseMigrationActionType, DatabaseDestructiveActionType]


@dataclass
class PermitEvidence:
    """Evidence emitted when a database action is permitted."""

    action: DatabaseActionType
    database_id: str
    authorized_by: str
    permit_token: str
    timestamp: str
    context: dict[str, Any] = field(default_factory=dict)


@dataclass
class DenialEvidence:
    """Evidence emitted when a database action is denied."""

    action: DatabaseActionType
    database_id: str
    authorized_by: str
    denial_reason: str
    timestamp: str
    evaluation_id: str | None = None
    context: dict[str, Any] = field(default_factory=dict)


_DESTRUCTIVE_ACTIONS: frozenset[str] = frozenset(
    {"database.schema.drop", "database.table.delete"}
)


def protect_database_action(
    *,
    action: DatabaseActionType,
    database_id: str,
    authorized_by: str,
    environment: Literal["production", "staging", "development"],
    on_permit_evidence: Callable[[PermitEvidence], None] | None = None,
    on_denial_evidence: Callable[[DenialEvidence], None] | None = None,
    **kwargs: Any,
) -> Permit:
    """Generic database action protect wrapper.

    Args:
        action: One of the ``DatabaseActionType`` literals.
        database_id: The target database identifier.
        authorized_by: Agent or human ID authorising the action.
        environment: Deployment environment for the action.
        on_permit_evidence: Optional callback called with :class:`PermitEvidence`
            when the gate permits the action.
        on_denial_evidence: Optional callback called with :class:`DenialEvidence`
            when :class:`atlasent.AtlaSentDeniedError` is raised.
        **kwargs: Action-specific fields:
            - ``database.migration.apply``: ``migration_id`` (required),
              ``migration_checksum`` (required), ``rollback_plan`` (required
              in production).
            - ``database.schema.drop``: ``schema_name`` (required),
              ``backup_verified`` (must be True), ``recovery_point_id``
              (required).
            - ``database.table.delete``: ``table_name`` (required),
              ``backup_verified`` (must be True), ``recovery_point_id``
              (required).

    Raises:
        ValueError: If required action-specific fields are missing or invalid.
        atlasent.AtlaSentDeniedError: If the policy engine denies the action.
    """
    from datetime import datetime, timezone

    is_destructive = action in _DESTRUCTIVE_ACTIONS

    # ── Validation ────────────────────────────────────────────────────────────

    if action == "database.migration.apply":
        if not kwargs.get("migration_id"):
            raise ValueError(
                "Database action 'database.migration.apply' requires 'migration_id'"
            )
        if not kwargs.get("migration_checksum"):
            raise ValueError(
                "Database action 'database.migration.apply' requires 'migration_checksum'"
            )
        if environment == "production" and not kwargs.get("rollback_plan"):
            raise ValueError(
                "Database action 'database.migration.apply' in production requires 'rollback_plan'"
            )

    if action == "database.schema.drop":
        if not kwargs.get("schema_name"):
            raise ValueError(
                "Database action 'database.schema.drop' requires 'schema_name'"
            )
        if not kwargs.get("backup_verified"):
            raise ValueError(
                "Database action 'database.schema.drop' requires 'backup_verified: True'"
            )
        if not kwargs.get("recovery_point_id"):
            raise ValueError(
                "Database action 'database.schema.drop' requires 'recovery_point_id'"
            )

    if action == "database.table.delete":
        if not kwargs.get("table_name"):
            raise ValueError(
                "Database action 'database.table.delete' requires 'table_name'"
            )
        if not kwargs.get("backup_verified"):
            raise ValueError(
                "Database action 'database.table.delete' requires 'backup_verified: True'"
            )
        if not kwargs.get("recovery_point_id"):
            raise ValueError(
                "Database action 'database.table.delete' requires 'recovery_point_id'"
            )

    # ── Determine risk profile ────────────────────────────────────────────────

    risk_level = "critical" if is_destructive else "high"
    machine_executable = (
        action == "database.migration.apply" and environment != "production"
    )

    # ── Build context ─────────────────────────────────────────────────────────

    context: dict[str, Any] = {
        "machine_executable": machine_executable,
        "risk_level": risk_level,
        "database_id": database_id,
        "database_action": action,
        "environment": environment,
    }

    if is_destructive:
        context["deny_by_default"] = True

    # Migration fields
    if kwargs.get("migration_id"):
        context["migration_id"] = kwargs["migration_id"]
    if kwargs.get("migration_checksum"):
        context["migration_checksum"] = kwargs["migration_checksum"]
    if kwargs.get("rollback_plan"):
        context["rollback_plan"] = kwargs["rollback_plan"]

    # Destructive fields
    if kwargs.get("schema_name"):
        context["schema_name"] = kwargs["schema_name"]
    if kwargs.get("table_name"):
        context["table_name"] = kwargs["table_name"]
    if kwargs.get("backup_verified"):
        context["backup_verified"] = kwargs["backup_verified"]
    if kwargs.get("recovery_point_id"):
        context["recovery_point_id"] = kwargs["recovery_point_id"]

    if not machine_executable:
        quorum = "two_thirds" if is_destructive else "single_approver"
        default_wait_ms = 24 * 60 * 60 * 1000 if is_destructive else 4 * 60 * 60 * 1000
        context["hitl_escalation"] = {
            "assigned_to_role": kwargs.get("assigned_to_role", "database-admin"),
            "quorum_required": quorum,
            "wait_ms": kwargs.get("wait_ms", default_wait_ms),
        }

    # ── Gate call with evidence callbacks ────────────────────────────────────

    try:
        result = protect(agent=authorized_by, action=action, context=context)
        if on_permit_evidence is not None:
            on_permit_evidence(
                PermitEvidence(
                    action=action,
                    database_id=database_id,
                    authorized_by=authorized_by,
                    permit_token=getattr(result, "permit_id", "") or "",
                    timestamp=datetime.now(tz=timezone.utc).isoformat(),
                    context=context,
                )
            )
        return result
    except AtlaSentDeniedError as exc:
        if on_denial_evidence is not None:
            on_denial_evidence(
                DenialEvidence(
                    action=action,
                    database_id=database_id,
                    authorized_by=authorized_by,
                    denial_reason=exc.reason or "denied",
                    evaluation_id=getattr(exc, "evaluation_id", None),
                    timestamp=datetime.now(tz=timezone.utc).isoformat(),
                    context=context,
                )
            )
        raise


def protect_database_migration(
    *,
    database_id: str,
    authorized_by: str,
    environment: Literal["production", "staging", "development"],
    migration_id: str,
    migration_checksum: str,
    rollback_plan: str | None = None,
    on_permit_evidence: Callable[[PermitEvidence], None] | None = None,
    on_denial_evidence: Callable[[DenialEvidence], None] | None = None,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``database.migration.apply``.

    Args:
        database_id: Target database identifier.
        authorized_by: Authorising agent/human ID.
        environment: Deployment environment.
        migration_id: Unique migration identifier.
        migration_checksum: Integrity checksum of the migration script.
        rollback_plan: Required when ``environment == "production"``.
        on_permit_evidence: Optional permit evidence callback.
        on_denial_evidence: Optional denial evidence callback.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``).

    Raises:
        ValueError: If required fields are missing.
    """
    return protect_database_action(
        action="database.migration.apply",
        database_id=database_id,
        authorized_by=authorized_by,
        environment=environment,
        migration_id=migration_id,
        migration_checksum=migration_checksum,
        **({"rollback_plan": rollback_plan} if rollback_plan is not None else {}),
        on_permit_evidence=on_permit_evidence,
        on_denial_evidence=on_denial_evidence,
        **kwargs,
    )


def protect_database_schema_drop(
    *,
    database_id: str,
    authorized_by: str,
    environment: Literal["production", "staging", "development"],
    schema_name: str,
    backup_verified: bool,
    recovery_point_id: str,
    on_permit_evidence: Callable[[PermitEvidence], None] | None = None,
    on_denial_evidence: Callable[[DenialEvidence], None] | None = None,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``database.schema.drop``.

    Args:
        database_id: Target database identifier.
        authorized_by: Authorising agent/human ID.
        environment: Deployment environment.
        schema_name: Name of the schema to drop.
        backup_verified: Must be ``True`` — confirms a backup exists.
        recovery_point_id: Identifier for the recovery point to roll back to.
        on_permit_evidence: Optional permit evidence callback.
        on_denial_evidence: Optional denial evidence callback.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``).

    Raises:
        ValueError: If ``backup_verified`` is not ``True`` or required fields
            are missing.
    """
    return protect_database_action(
        action="database.schema.drop",
        database_id=database_id,
        authorized_by=authorized_by,
        environment=environment,
        schema_name=schema_name,
        backup_verified=backup_verified,
        recovery_point_id=recovery_point_id,
        on_permit_evidence=on_permit_evidence,
        on_denial_evidence=on_denial_evidence,
        **kwargs,
    )


def protect_database_table_delete(
    *,
    database_id: str,
    authorized_by: str,
    environment: Literal["production", "staging", "development"],
    table_name: str,
    backup_verified: bool,
    recovery_point_id: str,
    on_permit_evidence: Callable[[PermitEvidence], None] | None = None,
    on_denial_evidence: Callable[[DenialEvidence], None] | None = None,
    **kwargs: Any,
) -> Permit:
    """Convenience wrapper for ``database.table.delete``.

    Args:
        database_id: Target database identifier.
        authorized_by: Authorising agent/human ID.
        environment: Deployment environment.
        table_name: Name of the table to delete.
        backup_verified: Must be ``True`` — confirms a backup exists.
        recovery_point_id: Identifier for the recovery point to roll back to.
        on_permit_evidence: Optional permit evidence callback.
        on_denial_evidence: Optional denial evidence callback.
        **kwargs: Optional overrides (``assigned_to_role``, ``wait_ms``).

    Raises:
        ValueError: If ``backup_verified`` is not ``True`` or required fields
            are missing.
    """
    return protect_database_action(
        action="database.table.delete",
        database_id=database_id,
        authorized_by=authorized_by,
        environment=environment,
        table_name=table_name,
        backup_verified=backup_verified,
        recovery_point_id=recovery_point_id,
        on_permit_evidence=on_permit_evidence,
        on_denial_evidence=on_denial_evidence,
        **kwargs,
    )
