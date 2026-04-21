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


class TestAsyncInit:
    def test_authorization_header(self):
        c = AsyncAtlaSentClient(api_key="ask_live_xyz")
        assert c._client.headers["authorization"] == "Bearer ask_live_xyz"

    def test_accept_header(self):
        c = AsyncAtlaSentClient(api_key="k")
        assert c._client.headers["accept"] == "application/json"

    def test_user_agent_header(self):
        c = AsyncAtlaSentClient(api_key="k")
        assert "atlasent-python/" in c._client.headers["user-agent"]


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


class TestAsyncErrorCodes:
    @pytest.mark.asyncio
    async def test_401_has_invalid_api_key_code(self, async_client, mocker):
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, status_code=401),
        )
        with pytest.raises(AtlaSentError) as exc_info:
            await async_client.evaluate("a", "b")
        assert exc_info.value.code == "invalid_api_key"

    @pytest.mark.asyncio
    async def test_timeout_has_timeout_code(self, async_client, mocker):
        mocker.patch.object(
            async_client._client, "post", side_effect=httpx.TimeoutException("t")
        )
        with pytest.raises(AtlaSentError) as exc_info:
            await async_client.evaluate("a", "b")
        assert exc_info.value.code == "timeout"

    @pytest.mark.asyncio
    async def test_connection_error_has_network_code(self, async_client, mocker):
        mocker.patch.object(
            async_client._client, "post", side_effect=httpx.ConnectError("refused")
        )
        with pytest.raises(AtlaSentError) as exc_info:
            await async_client.evaluate("a", "b")
        assert exc_info.value.code == "network"

    @pytest.mark.asyncio
    async def test_malformed_evaluate_body_is_bad_response(self, async_client, mocker):
        resp = _mock_resp(mocker, json_data={"foo": "bar"})
        mocker.patch.object(async_client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError) as exc_info:
            await async_client.evaluate("a", "b")
        assert exc_info.value.code == "bad_response"

    @pytest.mark.asyncio
    async def test_malformed_verify_body_is_bad_response(self, async_client, mocker):
        resp = _mock_resp(mocker, json_data={"outcome": "ok"})
        mocker.patch.object(async_client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError) as exc_info:
            await async_client.verify("dec_100")
        assert exc_info.value.code == "bad_response"


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


class TestAsyncCache:
    @pytest.mark.asyncio
    async def test_cache_hit_short_circuits_request(self, mocker):
        from atlasent.cache import TTLCache

        cache = TTLCache(ttl=60.0)
        client = AsyncAtlaSentClient(api_key="k", max_retries=0, cache=cache)
        post = mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_PERMIT),
        )
        first = await client.evaluate("read_data", "agent-1")
        second = await client.evaluate("read_data", "agent-1")
        assert first == second
        # Second call must come from the cache, not the network.
        assert post.call_count == 1


class TestAsyncRetryExhaustion:
    @pytest.mark.asyncio
    async def test_connect_error_retries_then_succeeds(
        self, async_client_retry, mocker
    ):
        ok = _mock_resp(mocker, json_data=EVALUATE_PERMIT)
        mocker.patch.object(
            async_client_retry._client,
            "post",
            side_effect=[httpx.ConnectError("refused"), ok],
        )
        result = await async_client_retry.evaluate("a", "b")
        assert result.permit_token == "dec_100"

    @pytest.mark.asyncio
    async def test_5xx_exhausted_raises_server_error(self, async_client_retry, mocker):
        err = _mock_resp(mocker, status_code=503)
        err.text = "Service Unavailable"
        mocker.patch.object(
            async_client_retry._client,
            "post",
            return_value=err,
        )
        with pytest.raises(AtlaSentError) as exc_info:
            await async_client_retry.evaluate("a", "b")
        assert exc_info.value.code == "server_error"
        assert exc_info.value.status_code == 503

    @pytest.mark.asyncio
    async def test_generic_httpx_error_maps_to_network_code(self, async_client, mocker):
        # httpx raises various HTTPError subclasses (ProtocolError,
        # ReadError, etc.) that aren't Timeout/ConnectError. They should
        # all surface as code="network".
        mocker.patch.object(
            async_client._client,
            "post",
            side_effect=httpx.ReadError("connection reset"),
        )
        with pytest.raises(AtlaSentError) as exc_info:
            await async_client.evaluate("a", "b")
        assert exc_info.value.code == "network"


class TestAsyncHttpStatusCodes:
    @pytest.mark.asyncio
    async def test_403_has_forbidden_code(self, async_client, mocker):
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, status_code=403),
        )
        with pytest.raises(AtlaSentError) as exc_info:
            await async_client.evaluate("a", "b")
        assert exc_info.value.code == "forbidden"
        assert exc_info.value.status_code == 403

    @pytest.mark.asyncio
    async def test_422_has_bad_request_code(self, async_client, mocker):
        resp = _mock_resp(mocker, status_code=422)
        resp.text = "validation failed"
        mocker.patch.object(async_client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError) as exc_info:
            await async_client.evaluate("a", "b")
        assert exc_info.value.code == "bad_request"
        assert exc_info.value.status_code == 422

    @pytest.mark.asyncio
    async def test_403_surfaces_server_message_from_json(self, async_client, mocker):
        resp = _mock_resp(mocker, status_code=403)
        resp.json.return_value = {"message": "key lacks phi:read scope"}
        mocker.patch.object(async_client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError) as exc_info:
            await async_client.evaluate("a", "b")
        assert "key lacks phi:read scope" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_200_with_invalid_json_is_bad_response(self, async_client, mocker):
        resp = _mock_resp(mocker, status_code=200)
        resp.json.side_effect = ValueError("not json")
        resp.text = "plaintext, not JSON"
        mocker.patch.object(async_client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError) as exc_info:
            await async_client.evaluate("a", "b")
        assert exc_info.value.code == "bad_response"


class TestAsyncRetryAfter:
    @pytest.mark.asyncio
    async def test_429_with_non_numeric_retry_after_falls_back_to_none(
        self, async_client, mocker
    ):
        resp = _mock_resp(
            mocker, status_code=429, headers={"retry-after": "not-a-number"}
        )
        mocker.patch.object(async_client._client, "post", return_value=resp)
        with pytest.raises(RateLimitError) as exc_info:
            await async_client.evaluate("a", "b")
        assert exc_info.value.retry_after is None

    @pytest.mark.asyncio
    async def test_429_without_retry_after_header(self, async_client, mocker):
        resp = _mock_resp(mocker, status_code=429)
        mocker.patch.object(async_client._client, "post", return_value=resp)
        with pytest.raises(RateLimitError) as exc_info:
            await async_client.evaluate("a", "b")
        assert exc_info.value.retry_after is None
