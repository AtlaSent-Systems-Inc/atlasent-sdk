"""Tests for atlasent.verticals.database_actions.

Covers:
- Valid migration in staging → protect() called, on_permit_evidence called
- Valid migration in production → protect() called with machine_executable=False
- Schema drop without backup_verified=True → ValueError
- Table delete without recovery_point_id → ValueError
- Denial → AtlaSentDeniedError raised, on_denial_evidence called
- Migration in production without rollback_plan → ValueError
"""

from __future__ import annotations

from unittest.mock import MagicMock, call, patch

import pytest

from atlasent.exceptions import AtlaSentDeniedError
from atlasent.verticals.database_actions import (
    DenialEvidence,
    PermitEvidence,
    protect_database_action,
    protect_database_migration,
    protect_database_schema_drop,
    protect_database_table_delete,
)


class TestDatabaseMigration:
    """Tests for database.migration.apply protect wrappers."""

    def test_migration_staging_calls_protect_machine_executable(self) -> None:
        """Migration in staging sets machine_executable=True and calls protect()."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.database_actions.protect",
            return_value=mock_permit,
        ) as mock_protect:
            result = protect_database_migration(
                database_id="db:staging-01",
                authorized_by="dba:alice",
                environment="staging",
                migration_id="m-2026-001",
                migration_checksum="sha256:abc123",
            )

        assert result is mock_permit
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "database.migration.apply"
        assert call_kwargs["agent"] == "dba:alice"
        assert call_kwargs["context"]["machine_executable"] is True
        assert call_kwargs["context"]["migration_id"] == "m-2026-001"
        assert call_kwargs["context"]["migration_checksum"] == "sha256:abc123"
        # No HITL escalation for staging
        assert "hitl_escalation" not in call_kwargs["context"]

    def test_migration_staging_on_permit_evidence_called(self) -> None:
        """Migration in staging calls on_permit_evidence on success."""
        mock_permit = MagicMock()
        mock_permit.permit_id = "permit_abc123"
        evidence_calls: list[PermitEvidence] = []

        with patch(
            "atlasent.verticals.database_actions.protect",
            return_value=mock_permit,
        ):
            protect_database_migration(
                database_id="db:staging-02",
                authorized_by="dba:bob",
                environment="staging",
                migration_id="m-2026-002",
                migration_checksum="sha256:def456",
                on_permit_evidence=evidence_calls.append,
            )

        assert len(evidence_calls) == 1
        ev = evidence_calls[0]
        assert ev.action == "database.migration.apply"
        assert ev.database_id == "db:staging-02"
        assert ev.authorized_by == "dba:bob"
        assert ev.timestamp  # non-empty ISO timestamp

    def test_migration_production_machine_executable_false(self) -> None:
        """Migration in production sets machine_executable=False with HITL escalation."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.database_actions.protect",
            return_value=mock_permit,
        ) as mock_protect:
            result = protect_database_migration(
                database_id="db:prod-main",
                authorized_by="dba:charlie",
                environment="production",
                migration_id="m-2026-003",
                migration_checksum="sha256:ghi789",
                rollback_plan="restore from snap-20260529",
            )

        assert result is mock_protect.return_value
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["context"]["machine_executable"] is False
        assert call_kwargs["context"]["risk_level"] == "high"
        # HITL escalation set for production
        hitl = call_kwargs["context"]["hitl_escalation"]
        assert hitl["assigned_to_role"] == "database-admin"
        assert hitl["quorum_required"] == "single_approver"
        # rollback_plan propagated
        assert call_kwargs["context"]["rollback_plan"] == "restore from snap-20260529"

    def test_migration_production_without_rollback_plan_raises(self) -> None:
        """Migration in production without rollback_plan raises ValueError."""
        with pytest.raises(ValueError, match="rollback_plan"):
            protect_database_migration(
                database_id="db:prod",
                authorized_by="dba:test",
                environment="production",
                migration_id="m-001",
                migration_checksum="sha256:abc",
                # rollback_plan deliberately omitted
            )

    def test_migration_missing_migration_id_raises(self) -> None:
        """Migration without migration_id raises ValueError."""
        with pytest.raises(ValueError, match="migration_id"):
            protect_database_action(
                action="database.migration.apply",
                database_id="db:test",
                authorized_by="dba:test",
                environment="staging",
                migration_checksum="sha256:abc",
                # migration_id deliberately omitted
            )

    def test_migration_missing_checksum_raises(self) -> None:
        """Migration without migration_checksum raises ValueError."""
        with pytest.raises(ValueError, match="migration_checksum"):
            protect_database_action(
                action="database.migration.apply",
                database_id="db:test",
                authorized_by="dba:test",
                environment="staging",
                migration_id="m-001",
                # migration_checksum deliberately omitted
            )

    def test_denial_raises_and_calls_on_denial_evidence(self) -> None:
        """AtlaSentDeniedError is re-raised and on_denial_evidence is called."""
        denied_exc = AtlaSentDeniedError(
            decision="deny",
            evaluation_id="eval_xyz",
            reason="policy denied database.migration.apply",
        )
        denial_calls: list[DenialEvidence] = []

        with patch(
            "atlasent.verticals.database_actions.protect",
            side_effect=denied_exc,
        ):
            with pytest.raises(AtlaSentDeniedError):
                protect_database_migration(
                    database_id="db:staging-03",
                    authorized_by="dba:dave",
                    environment="staging",
                    migration_id="m-2026-deny",
                    migration_checksum="sha256:deny",
                    on_denial_evidence=denial_calls.append,
                )

        assert len(denial_calls) == 1
        ev = denial_calls[0]
        assert ev.action == "database.migration.apply"
        assert ev.database_id == "db:staging-03"
        assert ev.authorized_by == "dba:dave"
        assert ev.denial_reason  # non-empty
        assert ev.evaluation_id == "eval_xyz"
        assert ev.timestamp


class TestDatabaseSchemaDrop:
    """Tests for database.schema.drop protect wrapper."""

    def test_schema_drop_happy_path(self) -> None:
        """Schema drop with all required fields calls protect() correctly."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.database_actions.protect",
            return_value=mock_permit,
        ) as mock_protect:
            result = protect_database_schema_drop(
                database_id="db:prod",
                authorized_by="dba:alice",
                environment="production",
                schema_name="legacy_schema",
                backup_verified=True,
                recovery_point_id="snap-20260529",
            )

        assert result is mock_permit
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "database.schema.drop"
        assert call_kwargs["context"]["machine_executable"] is False
        assert call_kwargs["context"]["risk_level"] == "critical"
        assert call_kwargs["context"]["deny_by_default"] is True
        hitl = call_kwargs["context"]["hitl_escalation"]
        assert hitl["assigned_to_role"] == "database-admin"
        assert hitl["quorum_required"] == "two_thirds"

    def test_schema_drop_without_backup_verified_raises(self) -> None:
        """Schema drop without backup_verified=True raises ValueError."""
        with pytest.raises(ValueError, match="backup_verified"):
            protect_database_schema_drop(
                database_id="db:prod",
                authorized_by="dba:test",
                environment="production",
                schema_name="public",
                backup_verified=False,  # type: ignore[arg-type]
                recovery_point_id="snap-001",
            )

    def test_schema_drop_without_backup_verified_false_raises(self) -> None:
        """Schema drop with backup_verified=False raises ValueError."""
        with pytest.raises(ValueError, match="backup_verified"):
            protect_database_action(
                action="database.schema.drop",
                database_id="db:prod",
                authorized_by="dba:test",
                environment="production",
                schema_name="public",
                # backup_verified omitted (falsy)
                recovery_point_id="snap-001",
            )

    def test_schema_drop_without_schema_name_raises(self) -> None:
        """Schema drop without schema_name raises ValueError."""
        with pytest.raises(ValueError, match="schema_name"):
            protect_database_action(
                action="database.schema.drop",
                database_id="db:prod",
                authorized_by="dba:test",
                environment="production",
                backup_verified=True,
                recovery_point_id="snap-001",
                # schema_name deliberately omitted
            )

    def test_schema_drop_without_recovery_point_id_raises(self) -> None:
        """Schema drop without recovery_point_id raises ValueError."""
        with pytest.raises(ValueError, match="recovery_point_id"):
            protect_database_schema_drop(
                database_id="db:prod",
                authorized_by="dba:test",
                environment="production",
                schema_name="public",
                backup_verified=True,
                recovery_point_id="",  # empty string is falsy
            )


class TestDatabaseTableDelete:
    """Tests for database.table.delete protect wrapper."""

    def test_table_delete_happy_path(self) -> None:
        """Table delete with all required fields calls protect() correctly."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.database_actions.protect",
            return_value=mock_permit,
        ) as mock_protect:
            result = protect_database_table_delete(
                database_id="db:prod",
                authorized_by="dba:bob",
                environment="production",
                table_name="deprecated_sessions",
                backup_verified=True,
                recovery_point_id="snap-20260529-sessions",
            )

        assert result is mock_permit
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "database.table.delete"
        assert call_kwargs["context"]["machine_executable"] is False
        assert call_kwargs["context"]["risk_level"] == "critical"
        assert call_kwargs["context"]["deny_by_default"] is True
        hitl = call_kwargs["context"]["hitl_escalation"]
        assert hitl["quorum_required"] == "two_thirds"
        assert call_kwargs["context"]["table_name"] == "deprecated_sessions"

    def test_table_delete_without_recovery_point_id_raises(self) -> None:
        """Table delete without recovery_point_id raises ValueError."""
        with pytest.raises(ValueError, match="recovery_point_id"):
            protect_database_table_delete(
                database_id="db:prod",
                authorized_by="dba:test",
                environment="production",
                table_name="users",
                backup_verified=True,
                recovery_point_id="",  # empty — falsy
            )

    def test_table_delete_without_table_name_raises(self) -> None:
        """Table delete without table_name raises ValueError."""
        with pytest.raises(ValueError, match="table_name"):
            protect_database_action(
                action="database.table.delete",
                database_id="db:prod",
                authorized_by="dba:test",
                environment="production",
                backup_verified=True,
                recovery_point_id="snap-001",
                # table_name deliberately omitted
            )

    def test_table_delete_without_backup_verified_raises(self) -> None:
        """Table delete without backup_verified=True raises ValueError."""
        with pytest.raises(ValueError, match="backup_verified"):
            protect_database_table_delete(
                database_id="db:prod",
                authorized_by="dba:test",
                environment="production",
                table_name="sessions",
                backup_verified=False,  # type: ignore[arg-type]
                recovery_point_id="snap-001",
            )

    def test_table_delete_denial_calls_on_denial_evidence(self) -> None:
        """AtlaSentDeniedError from table delete is re-raised and on_denial_evidence called."""
        denied_exc = AtlaSentDeniedError(
            decision="deny",
            evaluation_id="eval_table_deny",
            reason="policy denied database.table.delete",
        )
        denial_calls: list[DenialEvidence] = []

        with patch(
            "atlasent.verticals.database_actions.protect",
            side_effect=denied_exc,
        ):
            with pytest.raises(AtlaSentDeniedError):
                protect_database_table_delete(
                    database_id="db:prod",
                    authorized_by="dba:eve",
                    environment="production",
                    table_name="old_logs",
                    backup_verified=True,
                    recovery_point_id="snap-logs-001",
                    on_denial_evidence=denial_calls.append,
                )

        assert len(denial_calls) == 1
        ev = denial_calls[0]
        assert ev.action == "database.table.delete"
        assert ev.database_id == "db:prod"
        assert ev.evaluation_id == "eval_table_deny"
