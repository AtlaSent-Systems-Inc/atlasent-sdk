"""Tests for AtlaSentClient."""

import pytest
import requests

from atlasent.client import AtlaSentClient
from atlasent.exceptions import AtlaSentError, ConfigurationError
from atlasent.models import AuthorizationResult


@pytest.fixture
def client():
    return AtlaSentClient(api_key="test_key_123")


class TestClientInit:
    def test_default_values(self):
        c = AtlaSentClient(api_key="key")
        assert c._api_key == "key"
        assert c._environment == "production"
        assert c._base_url == "https://api.atlasent.io"

    def test_custom_values(self):
        c = AtlaSentClient(
            api_key="key",
            environment="staging",
            base_url="https://staging.atlasent.io",
        )
        assert c._environment == "staging"
        assert c._base_url == "https://staging.atlasent.io"

    def test_trailing_slash_stripped(self):
        c = AtlaSentClient(api_key="key", base_url="https://api.atlasent.io/")
        assert c._base_url == "https://api.atlasent.io"

    def test_user_agent_header(self):
        c = AtlaSentClient(api_key="key")
        assert c._session.headers["User-Agent"] == "atlasent-python/0.1.0"


class TestEvaluate:
    def test_permitted_response(self, client, mocker):
        mock_response = mocker.Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "permitted": True,
            "decision_id": "dec_100",
            "reason": "Action complies with all policies",
            "audit_hash": "hash_abc",
            "timestamp": "2025-01-15T12:00:00Z",
        }
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
        mock_response = mocker.Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "permitted": False,
            "decision_id": "dec_101",
            "reason": "Missing required context: patient_id",
            "audit_hash": "hash_def",
            "timestamp": "2025-01-15T12:01:00Z",
        }
        mocker.patch.object(client._session, "post", return_value=mock_response)

        result = client.evaluate("test-agent", "update_record")

        assert result.permitted is False
        assert not result

    def test_empty_context_defaults(self, client, mocker):
        mock_response = mocker.Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "permitted": True,
            "decision_id": "dec_102",
            "reason": "OK",
            "audit_hash": "hash_ghi",
            "timestamp": "2025-01-15T12:02:00Z",
        }
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
        mock_response = mocker.Mock()
        mock_response.status_code = 401
        mocker.patch.object(client._session, "post", return_value=mock_response)

        with pytest.raises(AtlaSentError, match="Invalid API key"):
            client.evaluate("test-agent", "read_data")

    def test_403_raises_error(self, client, mocker):
        mock_response = mocker.Mock()
        mock_response.status_code = 403
        mocker.patch.object(client._session, "post", return_value=mock_response)

        with pytest.raises(AtlaSentError, match="Access forbidden"):
            client.evaluate("test-agent", "read_data")

    def test_500_raises_error(self, client, mocker):
        mock_response = mocker.Mock()
        mock_response.status_code = 500
        mock_response.text = "Internal Server Error"
        mocker.patch.object(client._session, "post", return_value=mock_response)

        with pytest.raises(AtlaSentError, match="API error 500"):
            client.evaluate("test-agent", "read_data")

    def test_invalid_json_raises_error(self, client, mocker):
        mock_response = mocker.Mock()
        mock_response.status_code = 200
        mock_response.json.side_effect = ValueError("No JSON")
        mocker.patch.object(client._session, "post", return_value=mock_response)

        with pytest.raises(AtlaSentError, match="Invalid JSON"):
            client.evaluate("test-agent", "read_data")


class TestVerifyPermit:
    def test_verified_response(self, client, mocker):
        mock_response = mocker.Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "verified": True,
            "permit_hash": "permit_xyz",
            "timestamp": "2025-01-15T12:05:00Z",
        }
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
