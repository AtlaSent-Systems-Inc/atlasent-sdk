"""Tests for AtlaSent exceptions."""

from atlasent.exceptions import (
    AtlaSentDenied,
    AtlaSentError,
    ConfigurationError,
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
        assert err.response_body is None

    def test_response_body(self):
        err = AtlaSentError("err", response_body={"error": "bad"})
        assert err.response_body == {"error": "bad"}

    def test_is_exception(self):
        assert issubclass(AtlaSentError, Exception)


class TestAtlaSentDenied:
    def test_attributes(self):
        err = AtlaSentDenied(
            "deny",
            permit_token="dec_123",
            reason="Missing patient_id",
            response_body={"permitted": False},
        )
        assert err.decision == "deny"
        assert err.permit_token == "dec_123"
        assert err.reason == "Missing patient_id"
        assert "Action denied" in str(err)
        assert "Missing patient_id" in str(err)
        assert err.response_body == {"permitted": False}

    def test_inherits_from_atlasent_error(self):
        assert issubclass(AtlaSentDenied, AtlaSentError)

    def test_defaults(self):
        err = AtlaSentDenied("deny")
        assert err.permit_token == ""
        assert err.reason == ""


class TestConfigurationError:
    def test_message(self):
        err = ConfigurationError("No API key")
        assert err.message == "No API key"

    def test_inherits_from_atlasent_error(self):
        assert issubclass(ConfigurationError, AtlaSentError)


class TestRateLimitError:
    def test_with_retry_after(self):
        err = RateLimitError(retry_after=30.0)
        assert err.retry_after == 30.0
        assert err.status_code == 429
        assert err.code == "rate_limited"
        assert "retry after 30.0s" in str(err)

    def test_without_retry_after(self):
        err = RateLimitError()
        assert err.retry_after is None
        assert err.code == "rate_limited"

    def test_inherits_from_atlasent_error(self):
        assert issubclass(RateLimitError, AtlaSentError)


class TestAtlaSentErrorCode:
    def test_default_code_is_none(self):
        err = AtlaSentError("oops")
        assert err.code is None

    def test_code_passthrough(self):
        err = AtlaSentError("bad", code="invalid_api_key", status_code=401)
        assert err.code == "invalid_api_key"
        assert err.status_code == 401
