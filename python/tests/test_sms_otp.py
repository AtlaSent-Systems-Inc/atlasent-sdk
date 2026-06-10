"""Tests for atlasent.sms_otp — SMS OTP step-up authentication."""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from atlasent.exceptions import AtlaSentError
from atlasent.sms_otp import SmsOtpClient

BASE_URL = "https://api.atlasent.io"
API_KEY = "ask_test_sms_otp"


def _fake_client() -> MagicMock:
    c = MagicMock()
    c.base_url = BASE_URL
    c.api_key = API_KEY
    return c


def _fake_response(body: Any) -> MagicMock:
    raw = json.dumps(body).encode() if body is not None else b""
    resp = MagicMock()
    resp.read.return_value = raw
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


@contextmanager
def _mock_urlopen(body: Any):
    resp = _fake_response(body)
    with patch(
        "atlasent.sms_otp.urllib_request.urlopen", return_value=resp
    ) as m:
        yield m


SEND_RESPONSE = {
    "otp_id": "otp_abc123",
    "expires_at": "2026-06-10T12:05:00Z",
}

VERIFY_RESPONSE_VALID = {"valid": True}
VERIFY_RESPONSE_INVALID = {"valid": False}


# ── Construction ───────────────────────────────────────────────────────────────


class TestConstruction:
    def test_stores_client_reference(self):
        c = _fake_client()
        otp = SmsOtpClient(c)
        assert otp._client is c


# ── send — path and method ─────────────────────────────────────────────────────


class TestSendPath:
    def test_hits_correct_endpoint(self):
        with _mock_urlopen(SEND_RESPONSE) as m:
            SmsOtpClient(_fake_client()).send(
                phone_e164="+15551234567", action_context="break_glass"
            )
        req = m.call_args[0][0]
        assert req.full_url == f"{BASE_URL}/v1-sms-otp/send"
        assert req.get_method() == "POST"

    def test_authorization_header(self):
        with _mock_urlopen(SEND_RESPONSE) as m:
            SmsOtpClient(_fake_client()).send(
                phone_e164="+15551234567", action_context="break_glass"
            )
        req = m.call_args[0][0]
        assert req.get_header("Authorization") == f"Bearer {API_KEY}"

    def test_content_type_header(self):
        with _mock_urlopen(SEND_RESPONSE) as m:
            SmsOtpClient(_fake_client()).send(
                phone_e164="+15551234567", action_context="break_glass"
            )
        req = m.call_args[0][0]
        assert req.get_header("Content-type") == "application/json"


# ── send — request body ────────────────────────────────────────────────────────


class TestSendBody:
    def test_sends_phone_e164(self):
        with _mock_urlopen(SEND_RESPONSE) as m:
            SmsOtpClient(_fake_client()).send(
                phone_e164="+15559876543", action_context="break_glass"
            )
        body = json.loads(m.call_args[0][0].data)
        assert body["phone_e164"] == "+15559876543"

    def test_sends_action_context_break_glass(self):
        with _mock_urlopen(SEND_RESPONSE) as m:
            SmsOtpClient(_fake_client()).send(
                phone_e164="+15551234567", action_context="break_glass"
            )
        body = json.loads(m.call_args[0][0].data)
        assert body["action_context"] == "break_glass"

    def test_sends_action_context_api_key_create(self):
        with _mock_urlopen(SEND_RESPONSE) as m:
            SmsOtpClient(_fake_client()).send(
                phone_e164="+15551234567", action_context="api_key_create"
            )
        body = json.loads(m.call_args[0][0].data)
        assert body["action_context"] == "api_key_create"

    def test_sends_action_context_governance_hold_approve(self):
        with _mock_urlopen(SEND_RESPONSE) as m:
            SmsOtpClient(_fake_client()).send(
                phone_e164="+15551234567", action_context="governance_hold_approve"
            )
        body = json.loads(m.call_args[0][0].data)
        assert body["action_context"] == "governance_hold_approve"


# ── send — response parsing ────────────────────────────────────────────────────


class TestSendResponse:
    def test_returns_otp_id(self):
        with _mock_urlopen(SEND_RESPONSE):
            result = SmsOtpClient(_fake_client()).send(
                phone_e164="+15551234567", action_context="break_glass"
            )
        assert result["otp_id"] == "otp_abc123"

    def test_returns_expires_at(self):
        with _mock_urlopen(SEND_RESPONSE):
            result = SmsOtpClient(_fake_client()).send(
                phone_e164="+15551234567", action_context="break_glass"
            )
        assert result["expires_at"] == "2026-06-10T12:05:00Z"


# ── verify — path and method ───────────────────────────────────────────────────


class TestVerifyPath:
    def test_hits_correct_endpoint(self):
        with _mock_urlopen(VERIFY_RESPONSE_VALID) as m:
            SmsOtpClient(_fake_client()).verify(otp_id="otp_abc123", code="123456")
        req = m.call_args[0][0]
        assert req.full_url == f"{BASE_URL}/v1-sms-otp/verify"
        assert req.get_method() == "POST"

    def test_authorization_header(self):
        with _mock_urlopen(VERIFY_RESPONSE_VALID) as m:
            SmsOtpClient(_fake_client()).verify(otp_id="otp_abc123", code="123456")
        req = m.call_args[0][0]
        assert req.get_header("Authorization") == f"Bearer {API_KEY}"


# ── verify — request body ──────────────────────────────────────────────────────


class TestVerifyBody:
    def test_sends_otp_id(self):
        with _mock_urlopen(VERIFY_RESPONSE_VALID) as m:
            SmsOtpClient(_fake_client()).verify(otp_id="otp_xyz789", code="000000")
        body = json.loads(m.call_args[0][0].data)
        assert body["otp_id"] == "otp_xyz789"

    def test_sends_code(self):
        with _mock_urlopen(VERIFY_RESPONSE_VALID) as m:
            SmsOtpClient(_fake_client()).verify(otp_id="otp_abc", code="654321")
        body = json.loads(m.call_args[0][0].data)
        assert body["code"] == "654321"


# ── verify — response parsing ──────────────────────────────────────────────────


class TestVerifyResponse:
    def test_returns_valid_true(self):
        with _mock_urlopen(VERIFY_RESPONSE_VALID):
            result = SmsOtpClient(_fake_client()).verify(
                otp_id="otp_abc123", code="123456"
            )
        assert result["valid"] is True

    def test_returns_valid_false(self):
        with _mock_urlopen(VERIFY_RESPONSE_INVALID):
            result = SmsOtpClient(_fake_client()).verify(
                otp_id="otp_abc123", code="000000"
            )
        assert result["valid"] is False


# ── error handling ─────────────────────────────────────────────────────────────


class TestErrorHandling:
    def test_send_network_error_raises_atlasent_error(self):
        with patch(
            "atlasent.sms_otp.urllib_request.urlopen",
            side_effect=OSError("timeout"),
        ):
            with pytest.raises(AtlaSentError, match="SMS OTP client request"):
                SmsOtpClient(_fake_client()).send(
                    phone_e164="+15551234567", action_context="break_glass"
                )

    def test_verify_network_error_raises_atlasent_error(self):
        with patch(
            "atlasent.sms_otp.urllib_request.urlopen",
            side_effect=OSError("connection refused"),
        ):
            with pytest.raises(AtlaSentError, match="SMS OTP client request"):
                SmsOtpClient(_fake_client()).verify(otp_id="otp_x", code="111")
