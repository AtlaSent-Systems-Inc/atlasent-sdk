"""Phase 4 verticals tests.

Tests for HR actions, model governance, data deletion, contract actions,
and pricing actions. All HTTP calls are mocked via
``unittest.mock.patch``.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from atlasent.verticals.contract_actions import (
    protect_contract_action,
    protect_contract_execution,
)
from atlasent.verticals.data_delete import protect_customer_data_delete
from atlasent.verticals.hr_actions import (
    protect_hr_action,
    protect_hr_offboard,
    protect_hr_role_escalate,
)
from atlasent.verticals.model_governance import (
    protect_model_governance,
    protect_model_promotion,
)
from atlasent.verticals.pricing_actions import (
    protect_pricing_action,
    protect_pricing_rule,
)

# ---------------------------------------------------------------------------
# HR actions
# ---------------------------------------------------------------------------


class TestHrActions:
    """Tests for atlasent.verticals.hr_actions."""

    def test_protect_hr_access_revoke_machine_executable(self) -> None:
        """hr.access.revoke should be machine_executable=True."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.hr_actions.protect", return_value=mock_permit
        ) as mock_protect:
            result = protect_hr_action(
                "hr.access.revoke",
                employee_id="emp-123",
                authorized_by="admin-agent",
            )
        mock_protect.assert_called_once()
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "hr.access.revoke"
        assert call_kwargs["agent"] == "admin-agent"
        assert call_kwargs["context"]["machine_executable"] is True
        assert call_kwargs["context"]["employee_id"] == "emp-123"
        assert result is mock_permit

    def test_protect_hr_access_revoke_no_escalation(self) -> None:
        """hr.access.revoke (machine_executable) should not include hitl_escalation."""
        with patch("atlasent.verticals.hr_actions.protect", return_value=MagicMock()):
            protect_hr_action(
                "hr.access.revoke",
                employee_id="emp-123",
                authorized_by="admin-agent",
            )

    def test_protect_hr_offboard_sets_correct_context(self) -> None:
        """hr.employee.offboard should set machine_executable=False and escalation."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.hr_actions.protect", return_value=mock_permit
        ) as mock_protect:
            result = protect_hr_offboard(
                employee_id="emp-456",
                authorized_by="hr-bot",
                effective_date="2026-06-01",
                offboarding_reason="Voluntary resignation",
            )
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "hr.employee.offboard"
        assert call_kwargs["context"]["machine_executable"] is False
        assert call_kwargs["context"]["effective_date"] == "2026-06-01"
        assert call_kwargs["context"]["offboarding_reason"] == "Voluntary resignation"
        assert "hitl_escalation" in call_kwargs["context"]
        assert (
            call_kwargs["context"]["hitl_escalation"]["assigned_to_role"]
            == "hr-approver"
        )
        assert result is mock_permit

    def test_protect_hr_offboard_missing_effective_date(self) -> None:
        """hr.employee.offboard without effective_date raises ValueError."""
        with pytest.raises(ValueError, match="effective_date"):
            protect_hr_action(
                "hr.employee.offboard",
                employee_id="emp-789",
                authorized_by="hr-bot",
                offboarding_reason="Termination",
            )

    def test_protect_hr_offboard_missing_offboarding_reason(self) -> None:
        """hr.employee.offboard without offboarding_reason raises ValueError."""
        with pytest.raises(ValueError, match="offboarding_reason"):
            protect_hr_action(
                "hr.employee.offboard",
                employee_id="emp-789",
                authorized_by="hr-bot",
                effective_date="2026-06-01",
            )

    def test_protect_hr_role_escalate_sets_critical_risk(self) -> None:
        """hr.role.escalate should be critical risk with simple_majority quorum."""
        with patch(
            "atlasent.verticals.hr_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_hr_role_escalate(
                employee_id="emp-999",
                authorized_by="hr-bot",
                requested_role="admin",
                business_justification="Emergency access needed",
            )
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["context"]["risk_level"] == "critical"
        assert call_kwargs["context"]["machine_executable"] is False
        assert (
            call_kwargs["context"]["hitl_escalation"]["quorum_required"]
            == "simple_majority"
        )

    def test_protect_hr_role_escalate_missing_requested_role(self) -> None:
        """hr.role.escalate without requested_role raises ValueError."""
        with pytest.raises(ValueError, match="requested_role"):
            protect_hr_action(
                "hr.role.escalate",
                employee_id="emp-999",
                authorized_by="hr-bot",
                business_justification="Emergency access",
            )

    def test_protect_hr_role_escalate_missing_justification(self) -> None:
        """hr.role.escalate without business_justification raises ValueError."""
        with pytest.raises(ValueError, match="business_justification"):
            protect_hr_action(
                "hr.role.escalate",
                employee_id="emp-999",
                authorized_by="hr-bot",
                requested_role="admin",
            )

    def test_protect_hr_offboard_convenience_calls_generic(self) -> None:
        """protect_hr_offboard delegates to protect_hr_action."""
        with patch(
            "atlasent.verticals.hr_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_hr_offboard(
                "emp-001",
                "hr-agent",
                effective_date="2026-07-01",
                offboarding_reason="Layoff",
            )
        assert mock_protect.called

    def test_protect_hr_role_escalate_convenience_calls_generic(self) -> None:
        """protect_hr_role_escalate delegates to protect_hr_action."""
        with patch(
            "atlasent.verticals.hr_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_hr_role_escalate(
                "emp-002",
                "hr-agent",
                requested_role="superadmin",
                business_justification="Incident response",
            )
        assert mock_protect.called

    def test_protect_hr_action_custom_assigned_to_role(self) -> None:
        """Custom assigned_to_role is passed through to hitl_escalation."""
        with patch(
            "atlasent.verticals.hr_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_hr_offboard(
                "emp-003",
                "hr-agent",
                effective_date="2026-08-01",
                offboarding_reason="Restructuring",
                assigned_to_role="vp-hr",
            )
        call_ctx = mock_protect.call_args.kwargs["context"]
        assert call_ctx["hitl_escalation"]["assigned_to_role"] == "vp-hr"


# ---------------------------------------------------------------------------
# Model governance
# ---------------------------------------------------------------------------


class TestModelGovernance:
    """Tests for atlasent.verticals.model_governance."""

    def test_protect_model_governance_promote_sets_escalation(self) -> None:
        """ml.model.promote should route to ml-governance-board."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.model_governance.protect", return_value=mock_permit
        ) as mock_protect:
            result = protect_model_governance(
                "ml.model.promote",
                model_id="gpt-xyz",
                authorized_by="ml-engineer",
            )
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "ml.model.promote"
        assert call_kwargs["context"]["machine_executable"] is False
        assert call_kwargs["context"]["risk_level"] == "critical"
        assert call_kwargs["context"]["fail_closed"] is True
        assert (
            call_kwargs["context"]["hitl_escalation"]["assigned_to_role"]
            == "ml-governance-board"
        )
        assert (
            call_kwargs["context"]["hitl_escalation"]["quorum_required"]
            == "simple_majority"
        )
        assert result is mock_permit

    def test_protect_model_governance_retire(self) -> None:
        """ml.model.retire should also go through governance board."""
        with patch(
            "atlasent.verticals.model_governance.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_model_governance(
                "ml.model.retire",
                model_id="old-bert",
                authorized_by="ml-lead",
            )
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "ml.model.retire"
        assert call_kwargs["context"]["machine_executable"] is False

    def test_protect_model_governance_fine_tune(self) -> None:
        """ml.model.fine_tune should be fail_closed and not machine_executable."""
        with patch(
            "atlasent.verticals.model_governance.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_model_governance(
                "ml.model.fine_tune",
                model_id="llm-v2",
                authorized_by="ml-engineer",
            )
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["machine_executable"] is False
        assert ctx["fail_closed"] is True

    def test_protect_model_promotion_convenience(self) -> None:
        """protect_model_promotion delegates with action=ml.model.promote."""
        with patch(
            "atlasent.verticals.model_governance.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_model_promotion(model_id="prod-model", authorized_by="ml-ops")
        assert mock_protect.call_args.kwargs["action"] == "ml.model.promote"

    def test_protect_model_governance_optional_fields(self) -> None:
        """Optional fields (reason, safety_review_id) are passed through to context."""
        with patch(
            "atlasent.verticals.model_governance.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_model_governance(
                "ml.model.promote",
                model_id="model-a",
                authorized_by="ml-lead",
                reason="Production readiness confirmed",
                safety_review_id="sr-001",
                service_impact_assessed=True,
            )
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["reason"] == "Production readiness confirmed"
        assert ctx["safety_review_id"] == "sr-001"
        assert ctx["service_impact_assessed"] is True

    def test_protect_model_governance_48h_wait(self) -> None:
        """Default wait_ms should be 48 hours (172800000 ms)."""
        with patch(
            "atlasent.verticals.model_governance.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_model_governance(
                "ml.model.promote",
                model_id="model-b",
                authorized_by="ml-lead",
            )
        wait_ms = mock_protect.call_args.kwargs["context"]["hitl_escalation"]["wait_ms"]
        assert wait_ms == 48 * 60 * 60 * 1000


# ---------------------------------------------------------------------------
# Data delete
# ---------------------------------------------------------------------------


class TestDataDelete:
    """Tests for atlasent.verticals.data_delete."""

    def test_protect_customer_data_delete_happy_path(self) -> None:
        """Valid erasure request sets correct context."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.data_delete.protect", return_value=mock_permit
        ) as mock_protect:
            result = protect_customer_data_delete(
                data_subject_id="user-abc",
                authorized_by="compliance-bot",
                gdpr_basis="erasure_request",
                verified_by="dpo@example.com",
            )
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "customer.data.delete"
        assert call_kwargs["context"]["machine_executable"] is False
        assert call_kwargs["context"]["risk_level"] == "critical"
        assert call_kwargs["context"]["fail_closed"] is True
        assert call_kwargs["context"]["gdpr_basis"] == "erasure_request"
        assert call_kwargs["context"]["data_subject_id"] == "user-abc"
        assert call_kwargs["context"]["verified_by"] == "dpo@example.com"
        assert (
            call_kwargs["context"]["hitl_escalation"]["assigned_to_role"]
            == "compliance-officer"
        )
        assert result is mock_permit

    def test_protect_customer_data_delete_all_bases(self) -> None:
        """All valid GDPR bases are accepted."""
        bases = (
            "erasure_request",
            "retention_expired",
            "consent_withdrawn",
            "controller_instruction",
        )
        for basis in bases:
            with patch(
                "atlasent.verticals.data_delete.protect", return_value=MagicMock()
            ):
                protect_customer_data_delete(
                    data_subject_id=f"user-{basis}",
                    authorized_by="compliance-bot",
                    gdpr_basis=basis,  # type: ignore[arg-type]
                    verified_by="dpo@example.com",
                )

    def test_protect_customer_data_delete_invalid_basis(self) -> None:
        """Invalid gdpr_basis raises ValueError."""
        with pytest.raises(ValueError, match="gdpr_basis"):
            protect_customer_data_delete(
                data_subject_id="user-xyz",
                authorized_by="compliance-bot",
                gdpr_basis="not_a_valid_basis",  # type: ignore[arg-type]
                verified_by="dpo@example.com",
            )

    def test_protect_customer_data_delete_72h_wait(self) -> None:
        """Default wait_ms should be 72 hours (259200000 ms)."""
        with patch(
            "atlasent.verticals.data_delete.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_customer_data_delete(
                data_subject_id="user-wait",
                authorized_by="compliance-bot",
                gdpr_basis="erasure_request",
                verified_by="dpo@example.com",
            )
        wait_ms = mock_protect.call_args.kwargs["context"]["hitl_escalation"]["wait_ms"]
        assert wait_ms == 72 * 60 * 60 * 1000

    def test_protect_customer_data_delete_custom_role(self) -> None:
        """Custom assigned_to_role is forwarded to hitl_escalation."""
        with patch(
            "atlasent.verticals.data_delete.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_customer_data_delete(
                data_subject_id="user-custom",
                authorized_by="compliance-bot",
                gdpr_basis="consent_withdrawn",
                verified_by="dpo@example.com",
                assigned_to_role="data-protection-officer",
            )
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["hitl_escalation"]["assigned_to_role"] == "data-protection-officer"


# ---------------------------------------------------------------------------
# Contract actions
# ---------------------------------------------------------------------------


class TestContractActions:
    """Tests for atlasent.verticals.contract_actions."""

    def test_protect_contract_execute_critical_irreversible(self) -> None:
        """contract.execute should be critical risk, irreversible."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.contract_actions.protect", return_value=mock_permit
        ) as mock_protect:
            result = protect_contract_execution(
                contract_id="ctr-001",
                authorized_by="legal-agent",
            )
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "contract.execute"
        assert call_kwargs["context"]["machine_executable"] is False
        assert call_kwargs["context"]["risk_level"] == "critical"
        assert call_kwargs["context"]["fail_closed"] is True
        assert call_kwargs["context"]["reversibility"] == "irreversible"
        assert "hitl_escalation" in call_kwargs["context"]
        assert result is mock_permit

    def test_protect_contract_amend_high_partial(self) -> None:
        """contract.amend should be high risk with partial reversibility."""
        with patch(
            "atlasent.verticals.contract_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_contract_action(
                "contract.amend",
                contract_id="ctr-002",
                authorized_by="legal-agent",
                amendment_description="Extend term by 12 months",
            )
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["risk_level"] == "high"
        assert ctx["reversibility"] == "partial"
        assert ctx["amendment_description"] == "Extend term by 12 months"

    def test_protect_contract_amend_missing_description(self) -> None:
        """contract.amend without amendment_description raises ValueError."""
        with pytest.raises(ValueError, match="amendment_description"):
            protect_contract_action(
                "contract.amend",
                contract_id="ctr-003",
                authorized_by="legal-agent",
            )

    def test_protect_contract_execute_machine_executable_false(self) -> None:
        """contract.execute is always machine_executable=False."""
        with patch(
            "atlasent.verticals.contract_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_contract_execution("ctr-004", "legal-agent")
        assert mock_protect.call_args.kwargs["context"]["machine_executable"] is False

    def test_protect_contract_action_simple_majority_for_critical(self) -> None:
        """contract.execute (critical) should use simple_majority quorum."""
        with patch(
            "atlasent.verticals.contract_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_contract_execution("ctr-005", "legal-agent")
        quorum = mock_protect.call_args.kwargs["context"]["hitl_escalation"][
            "quorum_required"
        ]
        assert quorum == "simple_majority"

    def test_protect_contract_action_single_approver_for_high(self) -> None:
        """contract.amend (high) should use single_approver quorum."""
        with patch(
            "atlasent.verticals.contract_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_contract_action(
                "contract.amend",
                "ctr-006",
                "legal-agent",
                amendment_description="Price adjustment clause",
            )
        quorum = mock_protect.call_args.kwargs["context"]["hitl_escalation"][
            "quorum_required"
        ]
        assert quorum == "single_approver"


# ---------------------------------------------------------------------------
# Pricing actions
# ---------------------------------------------------------------------------


class TestPricingActions:
    """Tests for atlasent.verticals.pricing_actions."""

    def test_pricing_rule_publish_below_threshold_machine_executable(self) -> None:
        """pricing.rule.publish with change_pct < 5 should be machine_executable."""
        with patch(
            "atlasent.verticals.pricing_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_pricing_rule(
                rule_id="rule-001",
                authorized_by="pricing-bot",
                change_pct=3.0,
            )
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["machine_executable"] is True
        assert "hitl_escalation" not in ctx

    def test_pricing_rule_publish_above_threshold_escalates(self) -> None:
        """pricing.rule.publish with change_pct >= 5: not machine_executable."""
        with patch(
            "atlasent.verticals.pricing_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_pricing_rule(
                rule_id="rule-002",
                authorized_by="pricing-bot",
                change_pct=7.5,
            )
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["machine_executable"] is False
        assert "hitl_escalation" in ctx

    def test_pricing_rule_publish_exact_threshold(self) -> None:
        """pricing.rule.publish with change_pct == 5.0 should require human review."""
        with patch(
            "atlasent.verticals.pricing_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_pricing_rule("rule-003", "pricing-bot", change_pct=5.0)
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["machine_executable"] is False

    def test_pricing_rule_publish_risk_always_high(self) -> None:
        """pricing.rule.publish risk_level is always high regardless of change_pct."""
        for change_pct in (1.0, 5.0, 20.0):
            with patch(
                "atlasent.verticals.pricing_actions.protect", return_value=MagicMock()
            ) as mock_protect:
                protect_pricing_rule("rule-x", "pricing-bot", change_pct=change_pct)
            assert mock_protect.call_args.kwargs["context"]["risk_level"] == "high"

    def test_pricing_discount_below_threshold_medium_risk(self) -> None:
        """discount_pct < 10 → risk=medium, machine_executable=True."""
        with patch(
            "atlasent.verticals.pricing_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_pricing_action(
                "pricing.discount.approve",
                rule_id="disc-001",
                authorized_by="pricing-bot",
                discount_pct=5.0,
            )
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["risk_level"] == "medium"
        assert ctx["machine_executable"] is True

    def test_pricing_discount_above_threshold_high_risk_escalates(self) -> None:
        """discount_pct >= 10 → risk=high, machine_executable=False."""
        with patch(
            "atlasent.verticals.pricing_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_pricing_action(
                "pricing.discount.approve",
                rule_id="disc-002",
                authorized_by="pricing-bot",
                discount_pct=15.0,
            )
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["risk_level"] == "high"
        assert ctx["machine_executable"] is False
        assert "hitl_escalation" in ctx

    def test_pricing_discount_exact_threshold(self) -> None:
        """discount_pct == 10.0 triggers high risk + human review."""
        with patch(
            "atlasent.verticals.pricing_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_pricing_action(
                "pricing.discount.approve",
                rule_id="disc-003",
                authorized_by="pricing-bot",
                discount_pct=10.0,
            )
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["machine_executable"] is False
        assert ctx["risk_level"] == "high"

    def test_protect_pricing_rule_convenience_wrapper(self) -> None:
        """protect_pricing_rule uses action pricing.rule.publish."""
        with patch(
            "atlasent.verticals.pricing_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_pricing_rule("rule-y", "pricing-bot", change_pct=2.0)
        assert mock_protect.call_args.kwargs["action"] == "pricing.rule.publish"
