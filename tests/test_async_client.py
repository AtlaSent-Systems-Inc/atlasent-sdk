"""Tests for AsyncAtlaSentClient."""

import httpx
import pytest

from atlasent.async_client import AsyncAtlaSentClient
from atlasent.exceptions import AtlaSentDenied, AtlaSentError, RateLimitError
from atlasent.models import EvaluateResult, GateResult, VerifyResult

EVALUATE_PERMIT = {
    "permitted": True,
    "decision_id": "dec_100",
    "reason": "OK",
    "audit_hash": "hash_abc",
    "timestamp": "2025-01-15T12:00:00Z",
}

EVALUATE_DENY = {
    "permitted": False,
    "decision_id": "dec_101",
    "reason": "Denied",
    "audit_hash": "hash_def",
    "timestamp": "2025-01-15T12:01:00Z",
}

VERIFY_OK = {
    "verified": True,
    "permit_hash": "permit_xyz",
    "timestamp": "2025-01-15T12:05:00Z",
}


@pytest.fixture
def async_client():
    return AsyncAtlaSentClient(api_key="test_key", max_retries=0)


@pytest.fixture
def async_client_retry():
    return AsyncAtlaSentClient(api_key="test_key", max_retries=2, retry_backoff=0.01)


def _mock_resp(mocker, status_code=200, json_data=None, headers=None):
    resp = mocker.Mock(spec=httpx.Response)
    resp.status_code = status_code
    resp.headers = headers or {}
    resp.text = ""
    if json_data is not None:
        resp.json.return_value = json_data
    return resp


class TestAsyncEvaluate:
    @pytest.mark.asyncio
    async def test_permit(self, async_client, mocker):
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_PERMIT),
        )
        result = await async_client.evaluate("read_data", "agent-1")
        assert isinstance(result, EvaluateResult)
        assert result.decision is True
        assert result.permit_token == "dec_100"

    @pytest.mark.asyncio
    async def test_deny_raises(self, async_client, mocker):
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_DENY),
        )
        with pytest.raises(AtlaSentDenied) as exc_info:
            await async_client.evaluate("write_data", "agent-1")
        assert exc_info.value.reason == "Denied"

    @pytest.mark.asyncio
    async def test_timeout(self, async_client, mocker):
        mocker.patch.object(
            async_client._client,
            "post",
            side_effect=httpx.TimeoutException("t"),
        )
        with pytest.raises(AtlaSentError, match="timed out"):
            await async_client.evaluate("a", "b")

    @pytest.mark.asyncio
    async def test_connection_error(self, async_client, mocker):
        mocker.patch.object(
            async_client._client,
            "post",
            side_effect=httpx.ConnectError("refused"),
        )
        with pytest.raises(AtlaSentError, match="Failed to connect"):
            await async_client.evaluate("a", "b")


class TestAsyncVerify:
    @pytest.mark.asyncio
    async def test_valid(self, async_client, mocker):
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=VERIFY_OK),
        )
        result = await async_client.verify("dec_100")
        assert isinstance(result, VerifyResult)
        assert result.valid is True


class TestAsyncGate:
    @pytest.mark.asyncio
    async def test_permit_and_verify(self, async_client, mocker):
        mocker.patch.object(
            async_client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )
        result = await async_client.gate("read_data", "agent-1")
        assert isinstance(result, GateResult)
        assert result.evaluation.permit_token == "dec_100"
        assert result.verification.valid is True

    @pytest.mark.asyncio
    async def test_deny_at_evaluate(self, async_client, mocker):
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_DENY),
        )
        with pytest.raises(AtlaSentDenied):
            await async_client.gate("write_data", "agent-1")
        assert async_client._client.post.call_count == 1


class TestAsyncRetry:
    @pytest.mark.asyncio
    async def test_retries_on_timeout(self, async_client_retry, mocker):
        ok = _mock_resp(mocker, json_data=EVALUATE_PERMIT)
        mocker.patch.object(
            async_client_retry._client,
            "post",
            side_effect=[httpx.TimeoutException("t"), ok],
        )
        result = await async_client_retry.evaluate("a", "b")
        assert result.permit_token == "dec_100"

    @pytest.mark.asyncio
    async def test_retries_on_5xx(self, async_client_retry, mocker):
        err = _mock_resp(mocker, status_code=502)
        err.text = "Bad Gateway"
        ok = _mock_resp(mocker, json_data=EVALUATE_PERMIT)
        mocker.patch.object(async_client_retry._client, "post", side_effect=[err, ok])
        result = await async_client_retry.evaluate("a", "b")
        assert result.permit_token == "dec_100"

    @pytest.mark.asyncio
    async def test_exhausted(self, async_client_retry, mocker):
        mocker.patch.object(
            async_client_retry._client,
            "post",
            side_effect=httpx.TimeoutException("t"),
        )
        with pytest.raises(AtlaSentError, match="3 attempts"):
            await async_client_retry.evaluate("a", "b")


class TestAsyncRateLimit:
    @pytest.mark.asyncio
    async def test_429(self, async_client, mocker):
        resp = _mock_resp(mocker, status_code=429, headers={"retry-after": "5"})
        mocker.patch.object(async_client._client, "post", return_value=resp)
        with pytest.raises(RateLimitError) as exc_info:
            await async_client.evaluate("a", "b")
        assert exc_info.value.retry_after == 5.0


class TestAsyncLifecycle:
    @pytest.mark.asyncio
    async def test_context_manager(self, mocker):
        async with AsyncAtlaSentClient(api_key="k", max_retries=0) as c:
            mock_close = mocker.patch.object(c._client, "aclose")
        mock_close.assert_called_once()

    @pytest.mark.asyncio
    async def test_close(self, async_client, mocker):
        mock_close = mocker.patch.object(async_client._client, "aclose")
        await async_client.close()
        mock_close.assert_called_once()
