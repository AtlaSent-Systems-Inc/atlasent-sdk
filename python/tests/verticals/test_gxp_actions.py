"""Tests for atlasent.verticals.gxp_actions.

Covers:
- trial.blinding.setup happy path → protect() called with correct context
- trial.blinding.setup missing required fields → ValueError
- trial.unblinding.execute happy path → HITL escalation set
- trial.unblinding.execute missing fields → ValueError
- trial.unblinding.emergency happy path → single_approver, wait_ms=0
- trial.unblinding.emergency missing fields → ValueError
- Denial → AtlaSentDeniedError re-raised + on_denial_evidence called
- Permit → on_permit_evidence called
- Convenience wrappers delegate to protect_trial_action correctly
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from atlasent.exceptions import AtlaSentDeniedError
from atlasent.verticals.gxp_actions import (
    TrialDenialEvidence,
    TrialPermitEvidence,
    protect_trial_action,
    protect_trial_blinding_setup,
    protect_trial_unblinding_emergency,
    protect_trial_unblinding_execute,
)


class TestTrialBlindingSetup:
    """Tests for trial.blinding.setup protect wrappers."""

    def test_blinding_setup_happy_path(self) -> None:
        """Blinding setup with all required fields calls protect() correctly."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.gxp_actions.protect",
            return_value=mock_permit,
        ) as mock_protect:
            result = protect_trial_blinding_setup(
                trial_id="TRIAL-001",
                authorized_by="admin:dr-smith",
                randomization_list_hash="sha256:abc123def456",
                blinding_administrator="blinding-admin:dr-jones",
            )

        assert result is mock_permit
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "trial.blinding.setup"
        assert call_kwargs["agent"] == "admin:dr-smith"
        ctx = call_kwargs["context"]
        assert ctx["machine_executable"] is False
        assert ctx["risk_level"] == "high"
        assert ctx["trial_id"] == "TRIAL-001"
        assert ctx["randomization_list_hash"] == "sha256:abc123def456"
        assert ctx["blinding_administrator"] == "blinding-admin:dr-jones"
        hitl = ctx["hitl_escalation"]
        assert hitl["assigned_to_role"] == "sponsor-blinding-administrator"
        assert hitl["quorum_required"] == "single_approver"
        assert hitl["wait_ms"] == 86_400_000

    def test_blinding_setup_on_permit_evidence_called(self) -> None:
        """Blinding setup success calls on_permit_evidence callback."""
        mock_permit = MagicMock()
        mock_permit.permit_token = "pt.v3.abc"
        evidence_calls: list[TrialPermitEvidence] = []

        with patch(
            "atlasent.verticals.gxp_actions.protect",
            return_value=mock_permit,
        ):
            protect_trial_blinding_setup(
                trial_id="TRIAL-002",
                authorized_by="admin:dr-chen",
                randomization_list_hash="sha256:xyz789",
                blinding_administrator="blinding-admin:dr-park",
                on_permit_evidence=evidence_calls.append,
            )

        assert len(evidence_calls) == 1
        ev = evidence_calls[0]
        assert ev.action == "trial.blinding.setup"
        assert ev.trial_id == "TRIAL-002"
        assert ev.authorized_by == "admin:dr-chen"
        assert ev.timestamp  # non-empty ISO timestamp

    def test_blinding_setup_missing_randomization_hash_raises(self) -> None:
        """Blinding setup without randomization_list_hash raises ValueError."""
        with pytest.raises(ValueError, match="randomization_list_hash"):
            protect_trial_action(
                "trial.blinding.setup",
                "TRIAL-003",
                "admin:test",
                blinding_administrator="blinding-admin:test",
                # randomization_list_hash deliberately omitted
            )

    def test_blinding_setup_missing_blinding_administrator_raises(self) -> None:
        """Blinding setup without blinding_administrator raises ValueError."""
        with pytest.raises(ValueError, match="blinding_administrator"):
            protect_trial_action(
                "trial.blinding.setup",
                "TRIAL-003",
                "admin:test",
                randomization_list_hash="sha256:abc",
                # blinding_administrator deliberately omitted
            )

    def test_blinding_setup_denial_calls_on_denial_evidence(self) -> None:
        """Denial re-raises AtlaSentDeniedError and calls on_denial_evidence."""
        denied_exc = AtlaSentDeniedError(
            decision="deny",
            evaluation_id="eval_blind_deny",
            reason="policy denied trial.blinding.setup",
        )
        denial_calls: list[TrialDenialEvidence] = []

        with patch(
            "atlasent.verticals.gxp_actions.protect",
            side_effect=denied_exc,
        ):
            with pytest.raises(AtlaSentDeniedError):
                protect_trial_blinding_setup(
                    trial_id="TRIAL-DENY",
                    authorized_by="admin:unauthorized",
                    randomization_list_hash="sha256:deny",
                    blinding_administrator="blinding-admin:na",
                    on_denial_evidence=denial_calls.append,
                )

        assert len(denial_calls) == 1
        ev = denial_calls[0]
        assert ev.action == "trial.blinding.setup"
        assert ev.trial_id == "TRIAL-DENY"
        assert ev.evaluation_id == "eval_blind_deny"
        assert ev.timestamp


class TestTrialUnblindingExecute:
    """Tests for trial.unblinding.execute protect wrappers."""

    def test_unblinding_execute_happy_path(self) -> None:
        """Standard unblinding calls protect() with HITL majority quorum."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.gxp_actions.protect",
            return_value=mock_permit,
        ) as mock_protect:
            result = protect_trial_unblinding_execute(
                trial_id="TRIAL-004",
                authorized_by="authority:dr-patel",
                unblinding_authority="unblinding-auth:dr-patel",
                unblinding_reason="interim analysis per protocol §7.4",
                data_integrity_check="dq-run-20260708-001",
            )

        assert result is mock_permit
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "trial.unblinding.execute"
        ctx = call_kwargs["context"]
        assert ctx["machine_executable"] is False
        assert ctx["risk_level"] == "critical"
        assert ctx["unblinding_authority"] == "unblinding-auth:dr-patel"
        assert ctx["unblinding_reason"] == "interim analysis per protocol §7.4"
        assert ctx["data_integrity_check"] == "dq-run-20260708-001"
        hitl = ctx["hitl_escalation"]
        assert hitl["assigned_to_role"] == "sponsor-unblinding-authority"
        assert hitl["quorum_required"] == "simple_majority"
        assert hitl["wait_ms"] == 3_600_000

    def test_unblinding_execute_missing_authority_raises(self) -> None:
        """Unblinding execute without unblinding_authority raises ValueError."""
        with pytest.raises(ValueError, match="unblinding_authority"):
            protect_trial_action(
                "trial.unblinding.execute",
                "TRIAL-005",
                "authority:test",
                unblinding_reason="reason",
                data_integrity_check="dq-001",
            )

    def test_unblinding_execute_missing_reason_raises(self) -> None:
        """Unblinding execute without unblinding_reason raises ValueError."""
        with pytest.raises(ValueError, match="unblinding_reason"):
            protect_trial_action(
                "trial.unblinding.execute",
                "TRIAL-005",
                "authority:test",
                unblinding_authority="auth:test",
                data_integrity_check="dq-001",
            )

    def test_unblinding_execute_missing_data_integrity_check_raises(self) -> None:
        """Unblinding execute without data_integrity_check raises ValueError."""
        with pytest.raises(ValueError, match="data_integrity_check"):
            protect_trial_action(
                "trial.unblinding.execute",
                "TRIAL-005",
                "authority:test",
                unblinding_authority="auth:test",
                unblinding_reason="reason",
                # data_integrity_check deliberately omitted
            )

    def test_unblinding_execute_custom_assigned_role(self) -> None:
        """Custom assigned_to_role overrides the default."""
        with patch(
            "atlasent.verticals.gxp_actions.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_trial_unblinding_execute(
                trial_id="TRIAL-006",
                authorized_by="authority:dr-kim",
                unblinding_authority="auth:dr-kim",
                unblinding_reason="regulatory request",
                data_integrity_check="dq-006",
                assigned_to_role="data-safety-monitoring-board",
            )

        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["hitl_escalation"]["assigned_to_role"] == (
            "data-safety-monitoring-board"
        )


class TestTrialUnblindingEmergency:
    """Tests for trial.unblinding.emergency protect wrappers."""

    def test_emergency_unblinding_happy_path(self) -> None:
        """Emergency unblinding uses single_approver with wait_ms=0."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.gxp_actions.protect",
            return_value=mock_permit,
        ) as mock_protect:
            result = protect_trial_unblinding_emergency(
                trial_id="TRIAL-007",
                authorized_by="physician:dr-nguyen",
                patient_id="pat:PT-2026-007",
                treating_physician_id="physician:dr-nguyen",
                emergency_reason="severe adverse event requiring immediate treatment",
            )

        assert result is mock_permit
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "trial.unblinding.emergency"
        ctx = call_kwargs["context"]
        assert ctx["machine_executable"] is False
        assert ctx["risk_level"] == "critical"
        assert ctx["patient_id"] == "pat:PT-2026-007"
        assert ctx["treating_physician_id"] == "physician:dr-nguyen"
        assert ctx["emergency_reason"] == (
            "severe adverse event requiring immediate treatment"
        )
        hitl = ctx["hitl_escalation"]
        assert hitl["assigned_to_role"] == "treating-physician"
        assert hitl["quorum_required"] == "single_approver"
        # Emergency path: no wait
        assert hitl["wait_ms"] == 0

    def test_emergency_unblinding_missing_patient_id_raises(self) -> None:
        """Emergency unblinding without patient_id raises ValueError."""
        with pytest.raises(ValueError, match="patient_id"):
            protect_trial_action(
                "trial.unblinding.emergency",
                "TRIAL-008",
                "physician:test",
                treating_physician_id="physician:test",
                emergency_reason="reason",
            )

    def test_emergency_unblinding_missing_physician_id_raises(self) -> None:
        """Emergency unblinding without treating_physician_id raises ValueError."""
        with pytest.raises(ValueError, match="treating_physician_id"):
            protect_trial_action(
                "trial.unblinding.emergency",
                "TRIAL-008",
                "physician:test",
                patient_id="pat:PT-001",
                emergency_reason="reason",
            )

    def test_emergency_unblinding_missing_reason_raises(self) -> None:
        """Emergency unblinding without emergency_reason raises ValueError."""
        with pytest.raises(ValueError, match="emergency_reason"):
            protect_trial_action(
                "trial.unblinding.emergency",
                "TRIAL-008",
                "physician:test",
                patient_id="pat:PT-001",
                treating_physician_id="physician:test",
            )

    def test_emergency_unblinding_denial_reraises(self) -> None:
        """Emergency unblinding denial re-raises without evidence callback."""
        denied_exc = AtlaSentDeniedError(
            decision="deny",
            evaluation_id="eval_emrg_deny",
            reason="denied",
        )
        with patch(
            "atlasent.verticals.gxp_actions.protect",
            side_effect=denied_exc,
        ):
            with pytest.raises(AtlaSentDeniedError):
                protect_trial_unblinding_emergency(
                    trial_id="TRIAL-009",
                    authorized_by="physician:sub-inv",
                    patient_id="pat:PT-002",
                    treating_physician_id="physician:sub-inv",
                    emergency_reason="reason",
                    # no on_denial_evidence — should still re-raise
                )

    def test_emergency_unblinding_on_permit_evidence(self) -> None:
        """Emergency unblinding permit calls on_permit_evidence."""
        mock_permit = MagicMock()
        mock_permit.permit_token = "pt.v3.emrg"
        evidence_calls: list[TrialPermitEvidence] = []

        with patch(
            "atlasent.verticals.gxp_actions.protect",
            return_value=mock_permit,
        ):
            protect_trial_unblinding_emergency(
                trial_id="TRIAL-010",
                authorized_by="physician:dr-santos",
                patient_id="pat:PT-010",
                treating_physician_id="physician:dr-santos",
                emergency_reason="anaphylaxis requiring treatment decision",
                on_permit_evidence=evidence_calls.append,
            )

        assert len(evidence_calls) == 1
        ev = evidence_calls[0]
        assert ev.action == "trial.unblinding.emergency"
        assert ev.trial_id == "TRIAL-010"
        assert ev.timestamp


class TestTrialActionPublicInterface:
    """Tests that the public interface exports are consistent."""

    def test_trial_action_type_literals(self) -> None:
        """All three slugs are valid TrialActionType literals at runtime."""
        from atlasent.verticals.gxp_actions import TrialActionType

        # Runtime check: the type is a string union — just verify the module
        # exports the type without errors (TYPE_CHECKING guard is not enforced).
        assert TrialActionType is not None

    def test_protect_trial_action_generic_dispatches_by_action(self) -> None:
        """protect_trial_action dispatches field validation by action slug."""
        # Should raise for blinding setup missing hash
        with pytest.raises(ValueError, match="randomization_list_hash"):
            protect_trial_action(
                "trial.blinding.setup",
                "TRIAL-GEN",
                "admin:test",
                blinding_administrator="admin:test",
            )

        # Should raise for emergency missing patient
        with pytest.raises(ValueError, match="patient_id"):
            protect_trial_action(
                "trial.unblinding.emergency",
                "TRIAL-GEN",
                "physician:test",
                treating_physician_id="physician:test",
                emergency_reason="reason",
            )
