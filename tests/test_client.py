"""Tests for AtlaSentClient."""

import pytest
import requests

from atlasent.client import AtlaSentClient
from atlasent.exceptions import AtlaSentError, ConfigurationError, RateLimitError
from atlasent.models import AuthorizationResult


@pytest.fixture
def client():
    return AtlaSentClient(api_key="test_key_123", max_retries=0)


@pytest.fixture
def client_with_retries():
    return AtlaSentClient(api_key="test_key_123", max_retries=2, retry_backoff=0.01)


def _mock_response(mocker, status_code=200, json_data=None, text="", headers=None):
    resp = mocker.Mock()
    resp.status_code = status_code
    resp.text = text
    resp.headers = headers or {}
    if json_data is not None:
        resp.json.return_value = json_data
    return resp


EVALUATE_OK = {
    "permitted": True,
    "decision_id": "dec_100",
    "reason": "Action complies with all policies",
    "audit_hash": "hash_abc",
    "timestamp": "2025-01-15T12:00:00Z",
}

EVALUATE_DENIED = {
    "permitted": False,
    "decision_id": "dec_101",
    "reason": "Missing required context: patient_id",
    "audit_hash": "hash_def",
    "timestamp": "2025-01-15T12:01:00Z",
}


class TestClientInit:
    def test_default_values(self):
        c = AtlaSentClient(api_key="key")
        assert c._api_key == "key"
        assert c._environment == "production"
        assert c._base_url == "https://api.atlasent.io"
        assert c._timeout == 10
        assert c._max_retries == 2
        assert c._retry_backoff == 0.5

    def test_custom_values(self):
        c = AtlaSentClient(
            api_key="key",
            environment="staging",
            base_url="https://staging.atlasent.io",
            timeout=30,
            max_retries=5,
            retry_backoff=1.0,
        )
        assert c._environment == "staging"
        assert c._base_url == "https://staging.atlasent.io"
        assert c._timeout == 30
        assert c._max_retries == 5
        assert c._retry_backoff == 1.0

    def test_trailing_slash_stripped(self):
        c = AtlaSentClient(api_key="key", base_url="https://api.atlasent.io/")
        assert c._base_url == "https://api.atlasent.io"

    def test_user_agent_header(self):
        c = AtlaSentClient(api_key="key")
        assert c._session.headers["User-Agent"] == "atlasent-python/0.1.0"


class TestEvaluate:
    def test_permitted_response(self, client, mocker):
        mock_response = _mock_response(mocker, json_data=EVALUATE_OK)
        mocker.patch.object(client._session, "post", return_value=mock_response)

        result = client.evaluate("test-agent", "read_data", {"study": "S001"})

        assert isinstance(result, AuthorizationResult)
        assert result.permitted is True
        assert result.decision_id == "dec_100"
        assert result.reason == "Action complies with all policies"
        assert result.audit_hash == "hash_abc"
        client._session.post.assert_called_once_with(
            "https://api.atlasent.io/v1-evaluate",
            json={
                "agent": "test-agent",
                "action": "read_data",
                "context": {"study": "S001"},
                "api_key": "test_key_123",
            },
            timeout=10,
        )

    def test_denied_response(self, client, mocker):
        mock_response = _mock_response(mocker, json_data=EVALUATE_DENIED)
        mocker.patch.object(client._session, "post", return_value=mock_response)

        result = client.evaluate("test-agent", "update_record")

        assert result.permitted is False
        assert not result

    def test_empty_context_defaults(self, client, mocker):
        mock_response = _mock_response(mocker, json_data=EVALUATE_OK)
        mocker.patch.object(client._session, "post", return_value=mock_response)

        client.evaluate("test-agent", "read_data")

        call_kwargs = client._session.post.call_args
        assert call_kwargs[1]["json"]["context"] == {}

    def test_timeout_raises_error(self, client, mocker):
        mocker.patch.object(
            client._session,
            "post",
            side_effect=requests.exceptions.Timeout("Connection timed out"),
        )

        with pytest.raises(AtlaSentError, match="timed out"):
            client.evaluate("test-agent", "read_data")

    def test_connection_error_raises_error(self, client, mocker):
        mocker.patch.object(
            client._session,
            "post",
            side_effect=requests.exceptions.ConnectionError("DNS failure"),
        )

        with pytest.raises(AtlaSentError, match="Failed to connect"):
            client.evaluate("test-agent", "read_data")

    def test_401_raises_error(self, client, mocker):
        mock_response = _mock_response(mocker, status_code=401)
        mocker.patch.object(client._session, "post", return_value=mock_response)

        with pytest.raises(AtlaSentError, match="Invalid API key") as exc_info:
            client.evaluate("test-agent", "read_data")
        assert exc_info.value.status_code == 401

    def test_403_raises_error(self, client, mocker):
        mock_response = _mock_response(mocker, status_code=403)
        mocker.patch.object(client._session, "post", return_value=mock_response)

        with pytest.raises(AtlaSentError, match="Access forbidden") as exc_info:
            client.evaluate("test-agent", "read_data")
        assert exc_info.value.status_code == 403

    def test_500_raises_error(self, client, mocker):
        mock_response = _mock_response(
            mocker, status_code=500, text="Internal Server Error"
        )
        mocker.patch.object(client._session, "post", return_value=mock_response)

        with pytest.raises(AtlaSentError, match="API error 500") as exc_info:
            client.evaluate("test-agent", "read_data")
        assert exc_info.value.status_code == 500

    def test_invalid_json_raises_error(self, client, mocker):
        mock_response = _mock_response(mocker)
        mock_response.json.side_effect = ValueError("No JSON")
        mocker.patch.object(client._session, "post", return_value=mock_response)

        with pytest.raises(AtlaSentError, match="Invalid JSON"):
            client.evaluate("test-agent", "read_data")


class TestVerifyPermit:
    def test_verified_response(self, client, mocker):
        verify_data = {
            "verified": True,
            "permit_hash": "permit_xyz",
            "timestamp": "2025-01-15T12:05:00Z",
        }
        mock_response = _mock_response(mocker, json_data=verify_data)
        mocker.patch.object(client._session, "post", return_value=mock_response)

        result = client.verify_permit("dec_100")

        assert result["verified"] is True
        assert result["permit_hash"] == "permit_xyz"
        client._session.post.assert_called_once_with(
            "https://api.atlasent.io/v1-verify-permit",
            json={
                "decision_id": "dec_100",
                "api_key": "test_key_123",
            },
            timeout=10,
        )

    def test_timeout_raises_error(self, client, mocker):
        mocker.patch.object(
            client._session,
            "post",
            side_effect=requests.exceptions.Timeout("Timed out"),
        )

        with pytest.raises(AtlaSentError, match="timed out"):
            client.verify_permit("dec_100")


class TestApiKeyResolution:
    def test_falls_back_to_env_var(self, mocker):
        mocker.patch.dict("os.environ", {"ATLASENT_API_KEY": "env_key"})
        c = AtlaSentClient()
        assert c.api_key == "env_key"

    def test_missing_key_raises_error(self, mocker):
        mocker.patch.dict("os.environ", {}, clear=True)
        c = AtlaSentClient()
        with pytest.raises(ConfigurationError, match="No API key"):
            _ = c.api_key


class TestRetryLogic:
    def test_retries_on_timeout(self, client_with_retries, mocker):
        mock_response = _mock_response(mocker, json_data=EVALUATE_OK)
        mocker.patch.object(
            client_with_retries._session,
            "post",
            side_effect=[
                requests.exceptions.Timeout("timeout"),
                mock_response,
            ],
        )

        result = client_with_retries.evaluate("agent", "action")

        assert result.permitted is True
        assert client_with_retries._session.post.call_count == 2

    def test_retries_on_connection_error(self, client_with_retries, mocker):
        mock_response = _mock_response(mocker, json_data=EVALUATE_OK)
        mocker.patch.object(
            client_with_retries._session,
            "post",
            side_effect=[
                requests.exceptions.ConnectionError("refused"),
                mock_response,
            ],
        )

        result = client_with_retries.evaluate("agent", "action")

        assert result.permitted is True
        assert client_with_retries._session.post.call_count == 2

    def test_retries_on_5xx(self, client_with_retries, mocker):
        error_resp = _mock_response(mocker, status_code=502, text="Bad Gateway")
        ok_resp = _mock_response(mocker, json_data=EVALUATE_OK)
        mocker.patch.object(
            client_with_retries._session,
            "post",
            side_effect=[error_resp, ok_resp],
        )

        result = client_with_retries.evaluate("agent", "action")

        assert result.permitted is True
        assert client_with_retries._session.post.call_count == 2

    def test_exhausted_retries_raises(self, client_with_retries, mocker):
        mocker.patch.object(
            client_with_retries._session,
            "post",
            side_effect=requests.exceptions.Timeout("timeout"),
        )

        with pytest.raises(AtlaSentError, match="timed out after 3 attempts"):
            client_with_retries.evaluate("agent", "action")

        assert client_with_retries._session.post.call_count == 3

    def test_no_retry_on_4xx(self, client_with_retries, mocker):
        mock_response = _mock_response(mocker, status_code=422, text="Unprocessable")
        mocker.patch.object(
            client_with_retries._session,
            "post",
            return_value=mock_response,
        )

        with pytest.raises(AtlaSentError, match="API error 422"):
            client_with_retries.evaluate("agent", "action")

        assert client_with_retries._session.post.call_count == 1

    def test_backoff_called_between_retries(self, client_with_retries, mocker):
        mock_response = _mock_response(mocker, json_data=EVALUATE_OK)
        mocker.patch.object(
            client_with_retries._session,
            "post",
            side_effect=[
                requests.exceptions.Timeout("timeout"),
                mock_response,
            ],
        )
        mock_sleep = mocker.patch("atlasent.client.time.sleep")

        client_with_retries.evaluate("agent", "action")

        mock_sleep.assert_called_once()
        delay = mock_sleep.call_args[0][0]
        assert delay == pytest.approx(0.01)  # retry_backoff * 2^0


class TestRateLimiting:
    def test_429_raises_rate_limit_error(self, client, mocker):
        mock_response = _mock_response(
            mocker, status_code=429, headers={"Retry-After": "30"}
        )
        mocker.patch.object(client._session, "post", return_value=mock_response)

        with pytest.raises(RateLimitError) as exc_info:
            client.evaluate("agent", "action")

        assert exc_info.value.retry_after == 30.0
        assert exc_info.value.status_code == 429

    def test_429_without_retry_after(self, client, mocker):
        mock_response = _mock_response(mocker, status_code=429, headers={})
        mocker.patch.object(client._session, "post", return_value=mock_response)

        with pytest.raises(RateLimitError) as exc_info:
            client.evaluate("agent", "action")

        assert exc_info.value.retry_after is None

    def test_429_not_retried(self, client_with_retries, mocker):
        """429 should raise immediately, not be retried."""
        mock_response = _mock_response(
            mocker, status_code=429, headers={"Retry-After": "5"}
        )
        mocker.patch.object(
            client_with_retries._session, "post", return_value=mock_response
        )

        with pytest.raises(RateLimitError):
            client_with_retries.evaluate("agent", "action")

        assert client_with_retries._session.post.call_count == 1


class TestResourceManagement:
    def test_close(self, client, mocker):
        mock_close = mocker.patch.object(client._session, "close")
        client.close()
        mock_close.assert_called_once()

    def test_context_manager(self, mocker):
        with AtlaSentClient(api_key="key", max_retries=0) as client:
            mock_close = mocker.patch.object(client._session, "close")
        mock_close.assert_called_once()

    def test_context_manager_closes_on_exception(self, mocker):
        try:
            with AtlaSentClient(api_key="key", max_retries=0) as client:
                mock_close = mocker.patch.object(client._session, "close")
                raise ValueError("test error")
        except ValueError:
            pass
        mock_close.assert_called_once()


class TestResponseTextTruncation:
    def test_large_error_response_truncated(self, client, mocker):
        long_text = "x" * 1000
        mock_response = _mock_response(mocker, status_code=400, text=long_text)
        mocker.patch.object(client._session, "post", return_value=mock_response)

        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("agent", "action")

        assert len(exc_info.value.message) < 600
