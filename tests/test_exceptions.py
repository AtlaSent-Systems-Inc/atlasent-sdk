"""Tests for AtlaSent exceptions."""

from atlasent.exceptions import (
    AtlaSentError,
    ConfigurationError,
    PermissionDeniedError,
    RateLimitError,
)


class TestAtlaSentError:
    def test_message_and_status_code(self):
        err = AtlaSentError("something broke", status_code=500)
        assert err.message == "something broke"
        assert err.status_code == 500
        assert str(err) == "something broke"

    def test_default_status_code_is_none(self):
        err = AtlaSentError("oops")
        assert err.status_code is None

    def test_is_exception(self):
        assert issubclass(AtlaSentError, Exception)


class TestPermissionDeniedError:
    def test_attributes(self):
        err = PermissionDeniedError(
            reason="Missing patient_id",
            decision_id="dec_123",
            audit_hash="hash_456",
        )
        assert err.reason == "Missing patient_id"
        assert err.decision_id == "dec_123"
        assert err.audit_hash == "hash_456"
        assert "Permission denied" in str(err)

    def test_inherits_from_atlasent_error(self):
        assert issubclass(PermissionDeniedError, AtlaSentError)

    def test_default_audit_hash(self):
        err = PermissionDeniedError(reason="denied", decision_id="dec_1")
        assert err.audit_hash == ""


class TestConfigurationError:
    def test_message(self):
        err = ConfigurationError("No API key")
        assert err.message == "No API key"
        assert str(err) == "No API key"

    def test_inherits_from_atlasent_error(self):
        assert issubclass(ConfigurationError, AtlaSentError)


class TestRateLimitError:
    def test_with_retry_after(self):
        err = RateLimitError(retry_after=30.0)
        assert err.retry_after == 30.0
        assert err.status_code == 429
        assert "retry after 30.0s" in str(err)

    def test_without_retry_after(self):
        err = RateLimitError()
        assert err.retry_after is None
        assert err.status_code == 429
        assert "Rate limited" in str(err)

    def test_inherits_from_atlasent_error(self):
        assert issubclass(RateLimitError, AtlaSentError)
