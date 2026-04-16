"""Tests for AsyncAtlaSentClient."""

import pytest

pytest.importorskip("httpx")
pytest.importorskip("pytest_asyncio")

import httpx

from atlasent.async_client import AsyncAtlaSentClient
from atlasent.exceptions import AtlaSentError, ConfigurationError, RateLimitError
from atlasent.models import AuthorizationResult

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
    "reason": "Missing context",
    "audit_hash": "hash_def",
    "timestamp": "2025-01-15T12:01:00Z",
}


@pytest.fixture
def async_client():
    return AsyncAtlaSentClient(api_key="test_key_123", max_retries=0)


@pytest.fixture
def async_client_with_retries():
    return AsyncAtlaSentClient(
        api_key="test_key_123", max_retries=2, retry_backoff=0.01
    )


def _mock_httpx_response(mocker, status_code=200, json_data=None, headers=None):
    resp = mocker.Mock(spec=httpx.Response)
    resp.status_code = status_code
    resp.headers = headers or {}
    resp.text = ""
    if json_data is not None:
        resp.json.return_value = json_data
    return resp


class TestAsyncEvaluate:
    @pytest.mark.asyncio
    async def test_permitted_response(self, async_client, mocker):
        mock_response = _mock_httpx_response(mocker, json_data=EVALUATE_OK)
        mocker.patch.object(async_client._client, "post", return_value=mock_response)

        result = await async_client.evaluate(
            "test-agent", "read_data", {"study": "S001"}
        )

        assert isinstance(result, AuthorizationResult)
        assert result.permitted is True
        assert result.decision_id == "dec_100"

    @pytest.mark.asyncio
    async def test_denied_response(self, async_client, mocker):
        mock_response = _mock_httpx_response(mocker, json_data=EVALUATE_DENIED)
        mocker.patch.object(async_client._client, "post", return_value=mock_response)

        result = await async_client.evaluate("test-agent", "update_record")

        assert result.permitted is False
        assert not result

    @pytest.mark.asyncio
    async def test_timeout_raises_error(self, async_client, mocker):
        mocker.patch.object(
            async_client._client,
            "post",
            side_effect=httpx.TimeoutException("timed out"),
        )

        with pytest.raises(AtlaSentError, match="timed out"):
            await async_client.evaluate("test-agent", "read_data")

    @pytest.mark.asyncio
    async def test_connection_error_raises_error(self, async_client, mocker):
        mocker.patch.object(
            async_client._client,
            "post",
            side_effect=httpx.ConnectError("refused"),
        )

        with pytest.raises(AtlaSentError, match="Failed to connect"):
            await async_client.evaluate("test-agent", "read_data")

    @pytest.mark.asyncio
    async def test_401_raises_error(self, async_client, mocker):
        mock_response = _mock_httpx_response(mocker, status_code=401)
        mocker.patch.object(async_client._client, "post", return_value=mock_response)

        with pytest.raises(AtlaSentError, match="Invalid API key"):
            await async_client.evaluate("test-agent", "read_data")


class TestAsyncVerifyPermit:
    @pytest.mark.asyncio
    async def test_verified_response(self, async_client, mocker):
        verify_data = {
            "verified": True,
            "permit_hash": "permit_xyz",
            "timestamp": "2025-01-15T12:05:00Z",
        }
        mock_response = _mock_httpx_response(mocker, json_data=verify_data)
        mocker.patch.object(async_client._client, "post", return_value=mock_response)

        result = await async_client.verify_permit("dec_100")

        assert result["verified"] is True
        assert result["permit_hash"] == "permit_xyz"


class TestAsyncRetryLogic:
    @pytest.mark.asyncio
    async def test_retries_on_timeout(self, async_client_with_retries, mocker):
        mock_response = _mock_httpx_response(mocker, json_data=EVALUATE_OK)
        mocker.patch.object(
            async_client_with_retries._client,
            "post",
            side_effect=[
                httpx.TimeoutException("timeout"),
                mock_response,
            ],
        )

        result = await async_client_with_retries.evaluate("agent", "action")

        assert result.permitted is True
        assert async_client_with_retries._client.post.call_count == 2

    @pytest.mark.asyncio
    async def test_retries_on_5xx(self, async_client_with_retries, mocker):
        error_resp = _mock_httpx_response(mocker, status_code=502)
        error_resp.text = "Bad Gateway"
        ok_resp = _mock_httpx_response(mocker, json_data=EVALUATE_OK)
        mocker.patch.object(
            async_client_with_retries._client,
            "post",
            side_effect=[error_resp, ok_resp],
        )

        result = await async_client_with_retries.evaluate("agent", "action")

        assert result.permitted is True

    @pytest.mark.asyncio
    async def test_exhausted_retries_raises(self, async_client_with_retries, mocker):
        mocker.patch.object(
            async_client_with_retries._client,
            "post",
            side_effect=httpx.TimeoutException("timeout"),
        )

        with pytest.raises(AtlaSentError, match="timed out after 3 attempts"):
            await async_client_with_retries.evaluate("agent", "action")


class TestAsyncRateLimiting:
    @pytest.mark.asyncio
    async def test_429_raises_rate_limit_error(self, async_client, mocker):
        mock_response = _mock_httpx_response(
            mocker, status_code=429, headers={"retry-after": "30"}
        )
        mocker.patch.object(async_client._client, "post", return_value=mock_response)

        with pytest.raises(RateLimitError) as exc_info:
            await async_client.evaluate("agent", "action")

        assert exc_info.value.retry_after == 30.0


class TestAsyncResourceManagement:
    @pytest.mark.asyncio
    async def test_async_context_manager(self, mocker):
        async with AsyncAtlaSentClient(api_key="key", max_retries=0) as client:
            mock_close = mocker.patch.object(client._client, "aclose")

        mock_close.assert_called_once()

    @pytest.mark.asyncio
    async def test_close(self, async_client, mocker):
        mock_close = mocker.patch.object(async_client._client, "aclose")
        await async_client.close()
        mock_close.assert_called_once()


class TestAsyncApiKeyResolution:
    def test_falls_back_to_env_var(self, mocker):
        mocker.patch.dict("os.environ", {"ATLASENT_API_KEY": "env_key"})
        c = AsyncAtlaSentClient()
        assert c.api_key == "env_key"

    def test_missing_key_raises_error(self, mocker):
        mocker.patch.dict("os.environ", {}, clear=True)
        c = AsyncAtlaSentClient()
        with pytest.raises(ConfigurationError, match="No API key"):
            _ = c.api_key
