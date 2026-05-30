"""Tests for atlasent.verticals.deploy_gate.

Covers:
- protect_deploy calls protect with action="production.deploy" and correct context
- protect_production_deploy sets environment="production"
- notify_slack_webhook set + protect raises → Slack POST attempted, exception re-raised
- notify_slack_webhook set + Slack POST fails → original exception still raised
- notify_slack_webhook unset → no Slack call on deny
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from atlasent.verticals.deploy_gate import (
    protect_deploy,
    protect_production_deploy,
)


class TestProtectDeploy:
    """Tests for protect_deploy."""

    def test_calls_protect_with_correct_action(self) -> None:
        """protect_deploy calls protect() with action='production.deploy'."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=mock_permit,
        ) as mock_protect:
            result = protect_deploy(actor="github:alice")

        assert result is mock_permit
        call_kwargs = mock_protect.call_args.kwargs
        assert call_kwargs["action"] == "production.deploy"
        assert call_kwargs["agent"] == "github:alice"

    def test_context_machine_executable_false(self) -> None:
        """protect_deploy sets machine_executable=False in context."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=mock_permit,
        ) as mock_protect:
            protect_deploy(actor="github:bob")

        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["machine_executable"] is False

    def test_context_risk_level_critical(self) -> None:
        """protect_deploy sets risk_level='critical' in context."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(actor="github:alice")

        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["risk_level"] == "critical"

    def test_context_fail_closed_true(self) -> None:
        """protect_deploy sets fail_closed=True in context."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(actor="github:alice")

        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["fail_closed"] is True

    def test_context_default_environment_production(self) -> None:
        """protect_deploy defaults environment to 'production'."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(actor="github:alice")

        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["environment"] == "production"

    def test_context_custom_environment(self) -> None:
        """protect_deploy forwards custom environment to context."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(actor="github:alice", environment="staging")

        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["environment"] == "staging"

    def test_context_hitl_escalation(self) -> None:
        """protect_deploy sets hitl_escalation with deploy-approver role and 600_000ms wait."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(actor="github:alice")

        ctx = mock_protect.call_args.kwargs["context"]
        hitl = ctx["hitl_escalation"]
        assert hitl["assigned_to_role"] == "deploy-approver"
        assert hitl["wait_ms"] == 600_000

    def test_context_target_id_included_when_provided(self) -> None:
        """protect_deploy includes target_id in context when provided."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(actor="github:alice", target_id="my-service")

        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["target_id"] == "my-service"

    def test_context_target_id_absent_when_not_provided(self) -> None:
        """protect_deploy omits target_id from context when not provided."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(actor="github:alice")

        ctx = mock_protect.call_args.kwargs["context"]
        assert "target_id" not in ctx

    def test_context_repository_included_when_provided(self) -> None:
        """protect_deploy includes repository in context when provided."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(actor="github:alice", repository="myorg/myservice")

        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["repository"] == "myorg/myservice"

    def test_context_repository_absent_when_not_provided(self) -> None:
        """protect_deploy omits repository from context when not provided."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(actor="github:alice")

        ctx = mock_protect.call_args.kwargs["context"]
        assert "repository" not in ctx

    def test_context_sha_included_when_provided(self) -> None:
        """protect_deploy includes sha in context when provided."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(actor="github:alice", sha="abc123def456")

        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["sha"] == "abc123def456"

    def test_context_sha_absent_when_not_provided(self) -> None:
        """protect_deploy omits sha from context when not provided."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(actor="github:alice")

        ctx = mock_protect.call_args.kwargs["context"]
        assert "sha" not in ctx

    def test_all_optional_context_fields(self) -> None:
        """protect_deploy includes all optional fields when all are provided."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(
                actor="github:alice",
                target_id="payment-service",
                environment="production",
                repository="myorg/payment-service",
                sha="deadbeef1234",
            )

        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["target_id"] == "payment-service"
        assert ctx["environment"] == "production"
        assert ctx["repository"] == "myorg/payment-service"
        assert ctx["sha"] == "deadbeef1234"

    def test_kwargs_forwarded_to_context(self) -> None:
        """Extra **kwargs are merged into the context dict verbatim."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(
                actor="github:alice",
                change_ticket="CHG-1234",
                build_url="https://ci.example.com/build/42",
            )

        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["change_ticket"] == "CHG-1234"
        assert ctx["build_url"] == "https://ci.example.com/build/42"

    def test_kwargs_do_not_override_fixed_fields(self) -> None:
        """Caller-supplied kwargs cannot override machine_executable or risk_level."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_deploy(
                actor="github:alice",
                machine_executable=True,  # attempt to override; should be shadowed
                risk_level="low",
            )

        ctx = mock_protect.call_args.kwargs["context"]
        # Fixed fields set after **kwargs spread — they win
        assert ctx["machine_executable"] is False
        assert ctx["risk_level"] == "critical"


class TestProtectProductionDeploy:
    """Tests for protect_production_deploy convenience wrapper."""

    def test_sets_environment_production(self) -> None:
        """protect_production_deploy always sets environment='production'."""
        mock_permit = MagicMock()
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=mock_permit,
        ) as mock_protect:
            result = protect_production_deploy(actor="github:alice")

        assert result is mock_permit
        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["environment"] == "production"

    def test_forwards_kwargs_to_protect_deploy(self) -> None:
        """protect_production_deploy forwards kwargs such as target_id and sha."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_production_deploy(
                actor="github:bob",
                target_id="api-gateway",
                sha="cafebabe",
            )

        ctx = mock_protect.call_args.kwargs["context"]
        assert ctx["target_id"] == "api-gateway"
        assert ctx["sha"] == "cafebabe"
        assert ctx["environment"] == "production"

    def test_calls_protect_with_correct_action(self) -> None:
        """protect_production_deploy calls protect() with action='production.deploy'."""
        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=MagicMock(),
        ) as mock_protect:
            protect_production_deploy(actor="github:charlie")

        assert mock_protect.call_args.kwargs["action"] == "production.deploy"
        assert mock_protect.call_args.kwargs["agent"] == "github:charlie"


class TestNotifySlackWebhook:
    """Tests for Slack notification behaviour on denial."""

    def test_slack_post_attempted_when_protect_raises(self) -> None:
        """When notify_slack_webhook is set and protect raises, Slack POST is attempted."""
        exc = RuntimeError("policy denied")

        with patch(
            "atlasent.verticals.deploy_gate.protect",
            side_effect=exc,
        ):
            with patch(
                "atlasent.verticals.deploy_gate.urllib.request.urlopen",
            ) as mock_urlopen:
                with pytest.raises(RuntimeError, match="policy denied"):
                    protect_deploy(
                        actor="github:alice",
                        environment="production",
                        notify_slack_webhook="https://hooks.slack.com/test",
                    )

        mock_urlopen.assert_called_once()

    def test_original_exception_reraised_after_slack_notify(self) -> None:
        """The original exception is re-raised even when Slack notification succeeds."""
        exc = RuntimeError("deployment denied")

        with patch(
            "atlasent.verticals.deploy_gate.protect",
            side_effect=exc,
        ):
            with patch("atlasent.verticals.deploy_gate.urllib.request.urlopen"):
                with pytest.raises(RuntimeError, match="deployment denied"):
                    protect_deploy(
                        actor="github:alice",
                        notify_slack_webhook="https://hooks.slack.com/test",
                    )

    def test_original_exception_reraised_when_slack_post_fails(self) -> None:
        """Original exception is re-raised even if the Slack POST itself raises."""
        exc = RuntimeError("policy denied")

        with patch(
            "atlasent.verticals.deploy_gate.protect",
            side_effect=exc,
        ):
            with patch(
                "atlasent.verticals.deploy_gate.urllib.request.urlopen",
                side_effect=OSError("network unreachable"),
            ):
                # The original RuntimeError must propagate; the OSError is swallowed.
                with pytest.raises(RuntimeError, match="policy denied"):
                    protect_deploy(
                        actor="github:alice",
                        notify_slack_webhook="https://hooks.slack.com/test",
                    )

    def test_no_slack_call_when_webhook_not_set_on_deny(self) -> None:
        """No Slack call is made when notify_slack_webhook is not provided."""
        exc = RuntimeError("policy denied")

        with patch(
            "atlasent.verticals.deploy_gate.protect",
            side_effect=exc,
        ):
            with patch(
                "atlasent.verticals.deploy_gate.urllib.request.urlopen",
            ) as mock_urlopen:
                with pytest.raises(RuntimeError):
                    protect_deploy(
                        actor="github:alice",
                        # notify_slack_webhook deliberately omitted
                    )

        mock_urlopen.assert_not_called()

    def test_no_slack_call_on_successful_permit(self) -> None:
        """No Slack call is made when protect() succeeds (permit returned)."""
        mock_permit = MagicMock()

        with patch(
            "atlasent.verticals.deploy_gate.protect",
            return_value=mock_permit,
        ):
            with patch(
                "atlasent.verticals.deploy_gate.urllib.request.urlopen",
            ) as mock_urlopen:
                result = protect_deploy(
                    actor="github:alice",
                    notify_slack_webhook="https://hooks.slack.com/test",
                )

        assert result is mock_permit
        mock_urlopen.assert_not_called()
