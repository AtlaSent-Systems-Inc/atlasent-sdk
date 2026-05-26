"""Tests for atlasent.billing."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from atlasent.billing import (
    AccessStatus,
    AdminOverrideRequest,
    AdminOverrideResponse,
    AllowedAction,
    BillingClient,
    BillingEntitlement,
    DenyReason,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_NOW = "2026-05-07T09:00:00Z"
_GRACE_UNTIL = "2026-05-14T09:00:00Z"


def make_entitlement(**overrides: Any) -> BillingEntitlement:
    base: dict[str, Any] = {
        "org_id": "org_01",
        "access_status": "active",
        "effective_status": "active",
        "allowed_actions": [a.value for a in AllowedAction],
        "computed_at": _NOW,
    }
    base.update(overrides)
    return BillingEntitlement.model_validate(base)


def make_http_mock(response_body: dict[str, Any], status_code: int = 200) -> Any:
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = status_code
    mock_response.json.return_value = response_body
    mock_response.raise_for_status.return_value = None

    mock_http = MagicMock()
    mock_http.get.return_value = mock_response
    mock_http.post.return_value = mock_response

    mock_client = MagicMock()
    mock_client._client = mock_http
    mock_client._base_url = "https://api.example.com"
    return mock_client


# ---------------------------------------------------------------------------
# BillingEntitlement.has_action
# ---------------------------------------------------------------------------


class TestHasAction:
    def test_returns_true_for_present_action(self) -> None:
        ent = make_entitlement(allowed_actions=["govern", "evaluate"])
        assert ent.has_action("govern") is True

    def test_returns_false_for_missing_action(self) -> None:
        ent = make_entitlement(allowed_actions=["govern"])
        assert ent.has_action("seat_add") is False

    def test_accepts_enum_value(self) -> None:
        ent = make_entitlement(allowed_actions=["audit"])
        assert ent.has_action(AllowedAction.audit) is True

    def test_returns_false_for_unknown_string(self) -> None:
        ent = make_entitlement(allowed_actions=["govern"])
        assert ent.has_action("nonexistent_action") is False

    def test_empty_allowed_actions_returns_false(self) -> None:
        ent = make_entitlement(allowed_actions=[])
        assert ent.has_action("govern") is False


# ---------------------------------------------------------------------------
# BillingEntitlement.is_active / is_blocked
# ---------------------------------------------------------------------------


class TestStatusHelpers:
    def test_is_active_true_when_active(self) -> None:
        ent = make_entitlement(access_status="active")
        assert ent.is_active() is True

    def test_is_active_false_when_grace(self) -> None:
        ent = make_entitlement(access_status="grace", effective_status="grace")
        assert ent.is_active() is False

    def test_is_active_false_when_suspended(self) -> None:
        ent = make_entitlement(access_status="suspended", effective_status="suspended")
        assert ent.is_active() is False

    def test_is_blocked_true_when_suspended(self) -> None:
        ent = make_entitlement(access_status="suspended", effective_status="suspended")
        assert ent.is_blocked() is True

    def test_is_blocked_false_when_grace(self) -> None:
        ent = make_entitlement(access_status="grace", effective_status="grace")
        assert ent.is_blocked() is False

    def test_is_blocked_false_when_restricted(self) -> None:
        ent = make_entitlement(
            access_status="restricted", effective_status="restricted"
        )
        assert ent.is_blocked() is False


# ---------------------------------------------------------------------------
# BillingEntitlement._coerce_allowed_actions (unknown-string tolerance)
# ---------------------------------------------------------------------------


class TestCoerceAllowedActions:
    def test_valid_strings_coerced(self) -> None:
        ent = make_entitlement(allowed_actions=["govern", "evaluate"])
        assert AllowedAction.govern in ent.allowed_actions
        assert AllowedAction.evaluate in ent.allowed_actions

    def test_unknown_strings_silently_dropped(self) -> None:
        ent = make_entitlement(allowed_actions=["govern", "future_capability_v3"])
        assert len(ent.allowed_actions) == 1
        assert ent.allowed_actions[0] == AllowedAction.govern

    def test_all_unknown_yields_empty(self) -> None:
        ent = make_entitlement(allowed_actions=["unknown_a", "unknown_b"])
        assert ent.allowed_actions == []

    def test_enum_instances_pass_through(self) -> None:
        ent = make_entitlement(
            allowed_actions=[AllowedAction.audit, AllowedAction.billing_manage]
        )
        assert AllowedAction.audit in ent.allowed_actions
        assert AllowedAction.billing_manage in ent.allowed_actions

    def test_mixed_valid_and_unknown(self) -> None:
        ent = make_entitlement(allowed_actions=["govern", "FUTURE_ACTION", "audit"])
        assert len(ent.allowed_actions) == 2
        assert AllowedAction.govern in ent.allowed_actions
        assert AllowedAction.audit in ent.allowed_actions


# ---------------------------------------------------------------------------
# BillingEntitlement model — field shapes
# ---------------------------------------------------------------------------


class TestBillingEntitlementModel:
    def test_round_trips_full_grace_response(self) -> None:
        data = {
            "org_id": "org_02",
            "access_status": "grace",
            "effective_status": "grace",
            "allowed_actions": ["govern", "evaluate", "audit", "billing_manage"],
            "deny_reason": "billing_grace_period",
            "warning": "Your grace period expires in 7 days.",
            "grace_until": _GRACE_UNTIL,
            "billing_mode": "invoice",
            "plan": "enterprise",
            "invoice_status": "overdue",
            "manual_override": False,
            "computed_at": _NOW,
        }
        ent = BillingEntitlement.model_validate(data)
        assert ent.access_status == AccessStatus.grace
        assert ent.deny_reason == DenyReason.billing_grace_period
        assert ent.grace_until is not None
        assert ent.grace_until.year == 2026

    def test_suspended_has_no_govern(self) -> None:
        ent = make_entitlement(
            access_status="suspended",
            effective_status="suspended",
            allowed_actions=["billing_manage", "audit_export_legal"],
        )
        assert ent.has_action("govern") is False
        assert ent.has_action("billing_manage") is True

    def test_manual_override_fields_optional(self) -> None:
        ent = make_entitlement()
        assert ent.manual_override is False
        assert ent.manual_override_status is None
        assert ent.manual_override_reason is None

    def test_extra_fields_ignored(self) -> None:
        data = {
            "org_id": "org_03",
            "access_status": "active",
            "effective_status": "active",
            "allowed_actions": [],
            "computed_at": _NOW,
            "future_field": True,
        }
        ent = BillingEntitlement.model_validate(data)
        assert ent.org_id == "org_03"


# ---------------------------------------------------------------------------
# AdminOverrideRequest validation
# ---------------------------------------------------------------------------


class TestAdminOverrideRequest:
    def test_minimal_valid_request(self) -> None:
        req = AdminOverrideRequest(org_id="org_01", reason="Support ticket #999")
        assert req.org_id == "org_01"
        assert req.status is None
        assert req.expires_at is None

    def test_full_request_serialises(self) -> None:
        req = AdminOverrideRequest(
            org_id="org_01",
            status="grace",
            reason="Contract extension",
            expires_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        )
        payload = req.model_dump(mode="json", exclude_none=True)
        assert payload["status"] == "grace"
        assert "expires_at" in payload

    def test_invalid_status_raises(self) -> None:
        with pytest.raises(Exception):
            AdminOverrideRequest(org_id="org_01", status="unknown_status")  # type: ignore[arg-type]

    def test_clear_override_omits_status(self) -> None:
        req = AdminOverrideRequest(org_id="org_01", reason="Clearing override")
        payload = req.model_dump(mode="json", exclude_none=True)
        assert "status" not in payload


# ---------------------------------------------------------------------------
# BillingClient — mocked httpx responses
# ---------------------------------------------------------------------------


class TestBillingClient:
    def _entitlement_payload(self, status: str = "active") -> dict[str, Any]:
        return {
            "org_id": "org_01",
            "access_status": status,
            "effective_status": status,
            "allowed_actions": ["govern", "evaluate"],
            "computed_at": _NOW,
        }

    def test_get_entitlement_returns_model(self) -> None:
        mock_client = make_http_mock(self._entitlement_payload())
        billing = BillingClient(mock_client)
        ent = billing.get_entitlement()
        assert isinstance(ent, BillingEntitlement)
        assert ent.org_id == "org_01"
        assert ent.access_status == AccessStatus.active

    def test_get_entitlement_passes_org_id_param(self) -> None:
        mock_client = make_http_mock(self._entitlement_payload())
        billing = BillingClient(mock_client)
        billing.get_entitlement(org_id="org_99")
        call_kwargs = mock_client._client.get.call_args
        assert call_kwargs.kwargs["params"]["org_id"] == "org_99"

    def test_get_entitlement_no_param_when_none(self) -> None:
        mock_client = make_http_mock(self._entitlement_payload())
        billing = BillingClient(mock_client)
        billing.get_entitlement()
        call_kwargs = mock_client._client.get.call_args
        assert call_kwargs.kwargs["params"] == {}

    def test_set_override_returns_response_model(self) -> None:
        payload = {
            "org_id": "org_01",
            "new_status": "grace",
            "override_active": True,
            "override_status": "grace",
            "override_reason": "Contract extension",
        }
        mock_client = make_http_mock(payload)
        billing = BillingClient(mock_client)
        req = AdminOverrideRequest(
            org_id="org_01", status="grace", reason="Contract extension"
        )
        resp = billing.set_override(req)
        assert isinstance(resp, AdminOverrideResponse)
        assert resp.override_active is True
        assert resp.new_status == "grace"

    def test_clear_override_posts_without_status(self) -> None:
        payload = {"org_id": "org_01", "new_status": "active", "override_active": False}
        mock_client = make_http_mock(payload)
        billing = BillingClient(mock_client)
        billing.clear_override("org_01", reason="Ticket resolved")
        assert mock_client._client.post.called
        posted = mock_client._client.post.call_args.kwargs["json"]
        assert "status" not in posted
        assert posted["reason"] == "Ticket resolved"

    def test_http_error_propagates(self) -> None:
        mock_response = MagicMock(spec=httpx.Response)
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "403", request=MagicMock(), response=MagicMock()
        )
        mock_http = MagicMock()
        mock_http.get.return_value = mock_response
        mock_client = MagicMock()
        mock_client._client = mock_http
        mock_client._base_url = "https://api.example.com"
        billing = BillingClient(mock_client)
        with pytest.raises(httpx.HTTPStatusError):
            billing.get_entitlement()
