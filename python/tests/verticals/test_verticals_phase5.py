"""Phase 5 verticals tests.

Tests for security actions, access certificate revocation, and financial
period-close certification. All HTTP calls are mocked via
``unittest.mock.patch``.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from atlasent.verticals.access_cert import (
    protect_access_cert_action,
    protect_access_cert_revoke,
)
from atlasent.verticals.financial_close import (
    protect_financial_close_action,
    protect_period_close_certify,
)
from atlasent.verticals.security_actions import (
    protect_security_access_quarantine,
    protect_security_action,
    protect_security_incident_escalate,
)

# ---------------------------------------------------------------------------
# Security actions
# ---------------------------------------------------------------------------


class TestSecurityActions:
    """Tests for atlasent.verticals.security_actions."""

    def test_protect_security_incident_escalate_happy_path(self) -> None:
        """security.incident.escalate sets correct critical context."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.security_actions.protect", return_value=mock_permit
        ) as mock_protect:
            result = protect_security_incident_escalate(
                incident_id="inc-001",
                severity="critical",
                authorized_by="soc-agent",
            )
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "security.incident.escalate"
        assert call_kwargs["agent"] == "soc-agent"
        assert call_kwargs["context"]["machine_executable"] is False
        assert call_kwargs["context"]["risk_level"] == "critical"
        assert call_kwargs["context"]["fail_closed"] is True
        assert call_kwargs["context"]["incident_id"] == "inc-001"
        assert call_kwargs["context"]["severity"] == "critical"
        assert (
            call_kwargs["context"]["hitl_escalation"]["assigned_to_role"]
            == "security-approver"
        )
        assert (
            call_kwargs["context"]["hitl_escalation"]["quorum_required"]
            == "simple_majority"
        )
        assert result is mock_permit

    def test_protect_security_incident_escalate_1h_wait(self) -> None:
        """Default wait_ms for security incidents is 1 hour (3600000 ms)."""
        with patch(
            "atlasent.verticals.security_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_security_incident_escalate(
                incident_id="inc-002",
                severity="high",
                authorized_by="soc-agent",
            )
        wait_ms = mock_protect.call_args.kwargs["context"]["hitl_escalation"]["wait_ms"]
        assert wait_ms == 60 * 60 * 1000

    def test_protect_security_incident_missing_incident_id(self) -> None:
        """security.incident.escalate without incident_id raises ValueError."""
        with pytest.raises(ValueError, match="incident_id"):
            protect_security_action(
                "security.incident.escalate",
                actor_id="some-actor",
                authorized_by="soc-agent",
                severity="high",
            )

    def test_protect_security_incident_missing_severity(self) -> None:
        """security.incident.escalate without severity raises ValueError."""
        with pytest.raises(ValueError, match="severity"):
            protect_security_action(
                "security.incident.escalate",
                actor_id="some-actor",
                authorized_by="soc-agent",
                incident_id="inc-003",
            )

    def test_protect_security_incident_invalid_severity(self) -> None:
        """Invalid severity value raises ValueError."""
        with pytest.raises(ValueError, match="severity"):
            protect_security_action(
                "security.incident.escalate",
                actor_id="some-actor",
                authorized_by="soc-agent",
                incident_id="inc-004",
                severity="extreme",  # not a valid value
            )

    def test_protect_security_incident_all_valid_severities(self) -> None:
        """All valid severity values are accepted."""
        for sev in ("low", "medium", "high", "critical"):
            with patch(
                "atlasent.verticals.security_actions.protect", return_value=MagicMock()
            ):
                protect_security_incident_escalate(
                    incident_id=f"inc-{sev}",
                    severity=sev,  # type: ignore[arg-type]
                    authorized_by="soc-agent",
                )

    def test_protect_security_access_quarantine_happy_path(self) -> None:
        """security.access.quarantine sets correct context."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.security_actions.protect", return_value=mock_permit
        ) as mock_protect:
            result = protect_security_access_quarantine(
                target_id="user-suspect",
                quarantine_reason="Anomalous data exfiltration detected",
                authorized_by="soc-agent",
            )
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "security.access.quarantine"
        assert call_kwargs["context"]["machine_executable"] is False
        assert call_kwargs["context"]["target_id"] == "user-suspect"
        assert (
            call_kwargs["context"]["quarantine_reason"]
            == "Anomalous data exfiltration detected"
        )
        assert result is mock_permit

    def test_protect_security_quarantine_missing_target_id(self) -> None:
        """security.access.quarantine without target_id raises ValueError."""
        with pytest.raises(ValueError, match="target_id"):
            protect_security_action(
                "security.access.quarantine",
                actor_id="some-actor",
                authorized_by="soc-agent",
                quarantine_reason="Suspicious activity",
            )

    def test_protect_security_quarantine_missing_reason(self) -> None:
        """security.access.quarantine without quarantine_reason raises ValueError."""
        with pytest.raises(ValueError, match="quarantine_reason"):
            protect_security_action(
                "security.access.quarantine",
                actor_id="some-actor",
                authorized_by="soc-agent",
                target_id="target-001",
            )

    def test_protect_security_action_generic_incident(self) -> None:
        """protect_security_action routes security.incident.escalate correctly."""
        with patch(
            "atlasent.verticals.security_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_security_action(
                "security.incident.escalate",
                actor_id="inc-999",
                authorized_by="soc-agent",
                incident_id="inc-999",
                severity="medium",
            )
        assert mock_protect.call_args.kwargs["action"] == "security.incident.escalate"

    def test_protect_security_action_custom_role(self) -> None:
        """Custom assigned_to_role overrides the default."""
        with patch(
            "atlasent.verticals.security_actions.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_security_incident_escalate(
                incident_id="inc-custom",
                severity="low",
                authorized_by="soc-agent",
                assigned_to_role="ciso",
            )
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["hitl_escalation"]["assigned_to_role"] == "ciso"


# ---------------------------------------------------------------------------
# Access cert
# ---------------------------------------------------------------------------


class TestAccessCert:
    """Tests for atlasent.verticals.access_cert."""

    def test_protect_access_cert_revoke_happy_path(self) -> None:
        """access.cert.revoke sets correct context."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.access_cert.protect", return_value=mock_permit
        ) as mock_protect:
            result = protect_access_cert_revoke(
                cert_id="cert-abc",
                authorized_by="security-bot",
                revocation_reason="Certificate compromise",
            )
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "access.cert.revoke"
        assert call_kwargs["agent"] == "security-bot"
        assert call_kwargs["context"]["machine_executable"] is False
        assert call_kwargs["context"]["risk_level"] == "high"
        assert call_kwargs["context"]["cert_id"] == "cert-abc"
        assert call_kwargs["context"]["revocation_reason"] == "Certificate compromise"
        assert (
            call_kwargs["context"]["hitl_escalation"]["assigned_to_role"]
            == "security-approver"
        )
        assert (
            call_kwargs["context"]["hitl_escalation"]["quorum_required"]
            == "single_approver"
        )
        assert result is mock_permit

    def test_protect_access_cert_revoke_24h_wait(self) -> None:
        """Default wait_ms for cert revocation is 24 hours (86400000 ms)."""
        with patch(
            "atlasent.verticals.access_cert.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_access_cert_revoke(
                cert_id="cert-wait",
                authorized_by="security-bot",
                revocation_reason="Expired",
            )
        wait_ms = mock_protect.call_args.kwargs["context"]["hitl_escalation"]["wait_ms"]
        assert wait_ms == 24 * 60 * 60 * 1000

    def test_protect_access_cert_action_generic(self) -> None:
        """protect_access_cert_action with action=access.cert.revoke works."""
        with patch(
            "atlasent.verticals.access_cert.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_access_cert_action(
                "access.cert.revoke",
                cert_id="cert-xyz",
                authorized_by="security-bot",
                revocation_reason="Policy violation",
            )
        assert mock_protect.call_args.kwargs["action"] == "access.cert.revoke"

    def test_protect_access_cert_machine_executable_false(self) -> None:
        """access.cert.revoke should always be machine_executable=False."""
        with patch(
            "atlasent.verticals.access_cert.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_access_cert_revoke("cert-me", "security-bot", "Routine rotation")
        assert mock_protect.call_args.kwargs["context"]["machine_executable"] is False

    def test_protect_access_cert_custom_role(self) -> None:
        """Custom assigned_to_role overrides security-approver default."""
        with patch(
            "atlasent.verticals.access_cert.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_access_cert_revoke(
                cert_id="cert-custom",
                authorized_by="security-bot",
                revocation_reason="Compromised",
                assigned_to_role="ciso",
            )
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["hitl_escalation"]["assigned_to_role"] == "ciso"

    def test_protect_access_cert_convenience_delegates(self) -> None:
        """protect_access_cert_revoke delegates to protect_access_cert_action."""
        with patch(
            "atlasent.verticals.access_cert.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_access_cert_revoke("cert-delegate", "security-bot", "Expired key")
        assert mock_protect.called


# ---------------------------------------------------------------------------
# Financial close
# ---------------------------------------------------------------------------


class TestFinancialClose:
    """Tests for atlasent.verticals.financial_close."""

    def test_protect_period_close_certify_happy_path(self) -> None:
        """period.close.certify sets correct critical context."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.financial_close.protect", return_value=mock_permit
        ) as mock_protect:
            result = protect_period_close_certify(
                period_id="2026-Q1",
                authorized_by="cfo-agent",
                certified_by="cfo@example.com",
                financial_controller="controller@example.com",
            )
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "period.close.certify"
        assert call_kwargs["agent"] == "cfo-agent"
        assert call_kwargs["context"]["machine_executable"] is False
        assert call_kwargs["context"]["risk_level"] == "critical"
        assert call_kwargs["context"]["fail_closed"] is True
        assert call_kwargs["context"]["period_id"] == "2026-Q1"
        assert call_kwargs["context"]["certified_by"] == "cfo@example.com"
        assert (
            call_kwargs["context"]["financial_controller"] == "controller@example.com"
        )
        assert (
            call_kwargs["context"]["hitl_escalation"]["assigned_to_role"]
            == "financial-controller"
        )
        assert (
            call_kwargs["context"]["hitl_escalation"]["quorum_required"]
            == "simple_majority"
        )
        assert result is mock_permit

    def test_protect_period_close_certify_48h_wait(self) -> None:
        """Default wait_ms for period close is 48 hours (172800000 ms)."""
        with patch(
            "atlasent.verticals.financial_close.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_period_close_certify(
                period_id="2026-Q2",
                authorized_by="cfo-agent",
                certified_by="cfo@example.com",
                financial_controller="controller@example.com",
            )
        wait_ms = mock_protect.call_args.kwargs["context"]["hitl_escalation"]["wait_ms"]
        assert wait_ms == 48 * 60 * 60 * 1000

    def test_protect_financial_close_action_generic(self) -> None:
        """protect_financial_close_action with action=period.close.certify works."""
        with patch(
            "atlasent.verticals.financial_close.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_financial_close_action(
                "period.close.certify",
                period_id="2026-Q3",
                authorized_by="cfo-agent",
                certified_by="cfo@example.com",
                financial_controller="controller@example.com",
            )
        assert mock_protect.call_args.kwargs["action"] == "period.close.certify"

    def test_protect_financial_close_machine_executable_false(self) -> None:
        """period.close.certify should always be machine_executable=False."""
        with patch(
            "atlasent.verticals.financial_close.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_period_close_certify(
                "2026-Q4",
                "cfo-agent",
                "cfo@example.com",
                "controller@example.com",
            )
        assert mock_protect.call_args.kwargs["context"]["machine_executable"] is False

    def test_protect_financial_close_custom_role(self) -> None:
        """Custom assigned_to_role overrides financial-controller default."""
        with patch(
            "atlasent.verticals.financial_close.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_period_close_certify(
                "2027-Q1",
                "cfo-agent",
                "cfo@example.com",
                "controller@example.com",
                assigned_to_role="audit-committee",
            )
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["hitl_escalation"]["assigned_to_role"] == "audit-committee"

    def test_protect_financial_close_convenience_delegates(self) -> None:
        """protect_period_close_certify delegates to protect_financial_close_action."""
        with patch(
            "atlasent.verticals.financial_close.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_period_close_certify(
                "2027-Q2",
                "cfo-agent",
                "cfo@example.com",
                "controller@example.com",
            )
        assert mock_protect.called

    def test_protect_financial_close_fail_closed(self) -> None:
        """period.close.certify should always have fail_closed=True."""
        with patch(
            "atlasent.verticals.financial_close.protect", return_value=MagicMock()
        ) as mock_protect:
            protect_period_close_certify(
                "2027-Q3",
                "cfo-agent",
                "cfo@example.com",
                "controller@example.com",
            )
        assert mock_protect.call_args.kwargs["context"]["fail_closed"] is True
