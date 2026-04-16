"""Tests for the top-level authorize() convenience function."""

import pytest

import atlasent
from atlasent import authorize, configure
from atlasent.client import AtlaSentClient
from atlasent.config import reset
from atlasent.exceptions import ConfigurationError
from atlasent.models import AuthorizationResult


@pytest.fixture(autouse=True)
def _clean_config():
    """Reset global config before each test."""
    reset()
    yield
    reset()


class TestAuthorizeWithClient:
    def test_uses_provided_client(self, mocker):
        client = AtlaSentClient(api_key="explicit_key")
        mock_response = mocker.Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "permitted": True,
            "decision_id": "dec_200",
            "reason": "OK",
            "audit_hash": "hash_200",
            "timestamp": "2025-01-15T14:00:00Z",
        }
        mocker.patch.object(client._session, "post", return_value=mock_response)

        result = authorize("my-agent", "read_data", client=client)

        assert result.permitted is True
        assert result.decision_id == "dec_200"


class TestAuthorizeWithGlobalConfig:
    def test_uses_global_api_key(self, mocker):
        configure(api_key="global_key")

        mock_post = mocker.patch("atlasent.client.requests.Session.post")
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = {
            "permitted": True,
            "decision_id": "dec_201",
            "reason": "OK",
            "audit_hash": "hash_201",
            "timestamp": "2025-01-15T14:01:00Z",
        }

        result = authorize("my-agent", "read_data")

        assert result.permitted is True
        call_kwargs = mock_post.call_args
        assert call_kwargs[1]["json"]["api_key"] == "global_key"

    def test_uses_env_var_fallback(self, mocker):
        mocker.patch.dict("os.environ", {"ATLASENT_API_KEY": "env_key"})

        mock_post = mocker.patch("atlasent.client.requests.Session.post")
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = {
            "permitted": True,
            "decision_id": "dec_202",
            "reason": "OK",
            "audit_hash": "hash_202",
            "timestamp": "2025-01-15T14:02:00Z",
        }

        result = authorize("my-agent", "read_data")

        assert result.permitted is True
        call_kwargs = mock_post.call_args
        assert call_kwargs[1]["json"]["api_key"] == "env_key"

    def test_no_key_raises_configuration_error(self, mocker):
        mocker.patch.dict("os.environ", {}, clear=True)

        with pytest.raises(ConfigurationError, match="No API key"):
            authorize("my-agent", "read_data")


class TestAuthorizeContext:
    def test_context_passed_through(self, mocker):
        configure(api_key="key")

        mock_post = mocker.patch("atlasent.client.requests.Session.post")
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = {
            "permitted": True,
            "decision_id": "dec_203",
            "reason": "OK",
            "audit_hash": "hash_203",
            "timestamp": "2025-01-15T14:03:00Z",
        }

        authorize(
            "my-agent",
            "update_record",
            context={"patient_id": "PT-001", "study": "TRIAL-42"},
        )

        call_kwargs = mock_post.call_args
        assert call_kwargs[1]["json"]["context"] == {
            "patient_id": "PT-001",
            "study": "TRIAL-42",
        }
