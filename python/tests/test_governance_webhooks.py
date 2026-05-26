"""Tests for atlasent.governance_webhooks."""

from __future__ import annotations

import hashlib
import hmac
import json

from atlasent.governance_webhooks import (
    WebhookDelivery,
    WebhookPayload,
    WebhookSubscription,
    verify_webhook_signature,
)

# ---------------------------------------------------------------------------
# verify_webhook_signature
# ---------------------------------------------------------------------------

SECRET = "whsec_test_secret_1234"


def _make_signature(body: bytes, secret: str = SECRET) -> str:
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


class TestVerifyWebhookSignature:
    def test_valid_signature_bytes_payload(self) -> None:
        body = b'{"event_type": "enforcement.blocked"}'
        sig = _make_signature(body)
        assert verify_webhook_signature(body, sig, SECRET) is True

    def test_valid_signature_str_payload(self) -> None:
        body = '{"event_type": "policy.violation"}'
        sig = _make_signature(body.encode())
        assert verify_webhook_signature(body, sig, SECRET) is True

    def test_rejects_wrong_secret(self) -> None:
        body = b"hello"
        sig = _make_signature(body, secret="correct_secret")
        assert verify_webhook_signature(body, sig, "wrong_secret") is False

    def test_rejects_tampered_body(self) -> None:
        original = b'{"amount": 100}'
        tampered = b'{"amount": 999}'
        sig = _make_signature(original)
        assert verify_webhook_signature(tampered, sig, SECRET) is False

    def test_rejects_missing_prefix(self) -> None:
        body = b"payload"
        digest = hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
        # No "sha256=" prefix
        assert verify_webhook_signature(body, digest, SECRET) is False

    def test_rejects_empty_signature(self) -> None:
        body = b"payload"
        assert verify_webhook_signature(body, "", SECRET) is False

    def test_valid_with_json_payload(self) -> None:
        payload = json.dumps({"org_id": "org_01", "event_type": "hitl.decision"})
        body = payload.encode()
        sig = _make_signature(body)
        assert verify_webhook_signature(body, sig, SECRET) is True

    def test_empty_body_valid_signature(self) -> None:
        body = b""
        sig = _make_signature(body)
        assert verify_webhook_signature(body, sig, SECRET) is True


# ---------------------------------------------------------------------------
# WebhookSubscription model
# ---------------------------------------------------------------------------


class TestWebhookSubscription:
    def test_round_trips_from_dict(self) -> None:
        data = {
            "id": "wh_01",
            "org_id": "org_01",
            "url": "https://example.com/hook",
            "events": ["enforcement.blocked"],
            "enabled": True,
            "created_at": "2026-05-07T00:00:00Z",
        }
        sub = WebhookSubscription.model_validate(data)
        assert sub.id == "wh_01"
        assert sub.events == ["enforcement.blocked"]
        assert sub.description is None

    def test_optional_description(self) -> None:
        sub = WebhookSubscription.model_validate(
            {
                "id": "wh_02",
                "org_id": "org_01",
                "url": "https://example.com/hook",
                "events": [],
                "description": "My webhook",
            }
        )
        assert sub.description == "My webhook"

    def test_extra_fields_allowed(self) -> None:
        sub = WebhookSubscription.model_validate(
            {
                "id": "wh_03",
                "org_id": "org_01",
                "url": "https://example.com/hook",
                "events": [],
                "future_field": "value",
            }
        )
        assert sub.id == "wh_03"


# ---------------------------------------------------------------------------
# WebhookDelivery model
# ---------------------------------------------------------------------------


class TestWebhookDelivery:
    def test_parses_delivered(self) -> None:
        data = {
            "id": "del_01",
            "subscription_id": "wh_01",
            "event_type": "enforcement.blocked",
            "payload": {"action": "deploy"},
            "status": "delivered",
            "response_status": 200,
            "attempt_count": 1,
            "created_at": "2026-05-07T00:00:00Z",
        }
        d = WebhookDelivery.model_validate(data)
        assert d.status == "delivered"
        assert d.response_status == 200

    def test_parses_failed(self) -> None:
        data = {
            "id": "del_02",
            "subscription_id": "wh_01",
            "event_type": "enforcement.error",
            "payload": {},
            "status": "failed",
            "attempt_count": 5,
        }
        d = WebhookDelivery.model_validate(data)
        assert d.status == "failed"
        assert d.response_status is None


# ---------------------------------------------------------------------------
# WebhookPayload model
# ---------------------------------------------------------------------------


class TestWebhookPayload:
    def test_parses_enforcement_event(self) -> None:
        data = {
            "id": "evt_01",
            "org_id": "org_01",
            "event_type": "enforcement.blocked",
            "source_id": "eval_01",
            "data": {
                "action": "production.deploy",
                "actor": "github:alice",
                "deny_reason": "outside deployment window",
            },
            "created_at": "2026-05-07T00:00:00Z",
        }
        evt = WebhookPayload.model_validate(data)
        assert evt.event_type == "enforcement.blocked"
        assert isinstance(evt.data, dict)
        assert evt.data["actor"] == "github:alice"

    def test_source_id_optional(self) -> None:
        evt = WebhookPayload.model_validate(
            {
                "id": "evt_02",
                "org_id": "org_01",
                "event_type": "policy.violation",
                "data": {},
            }
        )
        assert evt.source_id is None
