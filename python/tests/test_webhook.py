"""Tests for atlasent.webhook — verify_webhook() and assert_webhook()."""

from __future__ import annotations

import hashlib
import hmac

import pytest

from atlasent.webhook import (
    WebhookVerificationError,
    assert_webhook,
    verify_webhook,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SECRET = "whsec_test_secret_webhook_1234"


def _make_signature(body: bytes | str, secret: str = SECRET) -> str:
    """Produce a valid ``sha256=<hex>`` signature for *body* using *secret*."""
    if isinstance(body, str):
        body = body.encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


# ---------------------------------------------------------------------------
# verify_webhook
# ---------------------------------------------------------------------------


class TestVerifyWebhook:
    def test_valid_signature_bytes_payload(self) -> None:
        body = b'{"event":"action.approved"}'
        sig = _make_signature(body)
        assert verify_webhook(body, sig, SECRET) is True

    def test_valid_signature_str_payload(self) -> None:
        body = '{"event":"action.blocked"}'
        sig = _make_signature(body.encode("utf-8"))
        assert verify_webhook(body, sig, SECRET) is True

    def test_wrong_secret_returns_false(self) -> None:
        body = b"hello world"
        sig = _make_signature(body, secret="correct_secret")
        assert verify_webhook(body, sig, "wrong_secret") is False

    def test_tampered_payload_returns_false(self) -> None:
        original = b'{"amount": 100}'
        tampered = b'{"amount": 999}'
        sig = _make_signature(original)
        assert verify_webhook(tampered, sig, SECRET) is False

    def test_malformed_signature_no_prefix_returns_false(self) -> None:
        body = b"payload"
        # hex digest without the required "sha256=" prefix
        bare_hex = hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
        assert verify_webhook(body, bare_hex, SECRET) is False

    def test_empty_signature_returns_false(self) -> None:
        body = b"payload"
        assert verify_webhook(body, "", SECRET) is False

    def test_malformed_signature_wrong_prefix_returns_false(self) -> None:
        body = b"payload"
        sig = _make_signature(body).replace("sha256=", "sha1=")
        assert verify_webhook(body, sig, SECRET) is False

    def test_truncated_signature_returns_false(self) -> None:
        body = b"payload"
        sig = _make_signature(body)
        # lop off the last 8 characters so the hex digest is wrong length
        assert verify_webhook(body, sig[:-8], SECRET) is False

    def test_empty_body_valid_signature(self) -> None:
        body = b""
        sig = _make_signature(body)
        assert verify_webhook(body, sig, SECRET) is True

    def test_never_raises_on_bad_inputs(self) -> None:
        # Passing non-string signature should return False, not raise.
        assert verify_webhook(b"body", "not-sha256-at-all", SECRET) is False

    def test_unicode_payload_str(self) -> None:
        body = '{"message": "héllo"}'
        sig = _make_signature(body.encode("utf-8"))
        assert verify_webhook(body, sig, SECRET) is True


# ---------------------------------------------------------------------------
# assert_webhook
# ---------------------------------------------------------------------------


class TestAssertWebhook:
    def test_valid_signature_does_not_raise(self) -> None:
        body = b'{"event":"test"}'
        sig = _make_signature(body)
        # Should not raise.
        assert_webhook(body, sig, SECRET)

    def test_invalid_signature_raises_webhook_verification_error(self) -> None:
        body = b"payload"
        sig = _make_signature(body, secret="correct")
        with pytest.raises(WebhookVerificationError):
            assert_webhook(body, sig, "wrong")

    def test_tampered_payload_raises(self) -> None:
        original = b'{"amount": 100}'
        tampered = b'{"amount": 9999}'
        sig = _make_signature(original)
        with pytest.raises(WebhookVerificationError):
            assert_webhook(tampered, sig, SECRET)

    def test_missing_signature_raises(self) -> None:
        with pytest.raises(WebhookVerificationError):
            assert_webhook(b"body", "", SECRET)

    def test_error_message_is_descriptive(self) -> None:
        with pytest.raises(WebhookVerificationError, match="signature"):
            assert_webhook(b"body", "sha256=bad", SECRET)


# ---------------------------------------------------------------------------
# Package-level re-export
# ---------------------------------------------------------------------------


class TestPackageExport:
    def test_importable_from_atlasent_package(self) -> None:
        from atlasent import (  # noqa: F401  (import check)
            WebhookVerificationError,
            assert_webhook,
            verify_webhook,
        )

    def test_verify_webhook_roundtrip_via_package(self) -> None:
        from atlasent import verify_webhook as vw

        body = b"roundtrip"
        sig = _make_signature(body)
        assert vw(body, sig, SECRET) is True
