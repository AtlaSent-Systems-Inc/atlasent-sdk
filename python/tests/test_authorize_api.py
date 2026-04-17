"""Tests for the public ``authorize()`` API surface.

Covers the top-level convenience function, the sync client method,
the async client method, and the ``AuthorizationResult`` dataclass.
"""

import httpx
import pytest

from atlasent import (
    AsyncAtlaSentClient,
    AtlaSentClient,
    AuthorizationResult,
    PermissionDeniedError,
    authorize,
    configure,
)
from atlasent.authorize import _reset_default_client
from atlasent.config import reset
from atlasent.exceptions import AtlaSentError, RateLimitError

EVALUATE_PERMIT = {
    "permitted": True,
    "decision_id": "dec_alpha",
    "reason": "Operator authorized under GxP policy",
    "audit_hash": "hash_alpha",
    "timestamp": "2025-01-15T10:00:00Z",
}

EVALUATE_DENY = {
    "permitted": False,
    "decision_id": "dec_beta",
    "reason": "Missing change_reason for critical field",
    "audit_hash": "hash_beta",
    "timestamp": "2025-01-15T10:01:00Z",
}

VERIFY_OK = {
    "verified": True,
    "permit_hash": "permit_alpha",
    "timestamp": "2025-01-15T10:00:01Z",
}


def _mock_resp(mocker, status_code=200, json_data=None, headers=None):
    resp = mocker.Mock(spec=httpx.Response)
    resp.status_code = status_code
    resp.headers = headers or {}
    resp.text = ""
    if json_data is not None:
        resp.json.return_value = json_data
    return resp


@pytest.fixture(autouse=True)
def _clean():
    reset()
    _reset_default_client()
    yield
    reset()
    _reset_default_client()


# ── AuthorizationResult dataclass ────────────────────────────────────


class TestAuthorizationResult:
    def test_defaults(self):
        r = AuthorizationResult(permitted=True)
        assert r.permitted is True
        assert r.agent == ""
        assert r.action == ""
        assert r.context == {}
        assert r.reason == ""
        assert r.permit_token == ""
        assert r.audit_hash == ""
        assert r.permit_hash == ""
        assert r.verified is False
        assert r.timestamp == ""
        assert r.raw == {}

    def test_bool_permitted(self):
        assert bool(AuthorizationResult(permitted=True)) is True
        assert bool(AuthorizationResult(permitted=False)) is False

    def test_if_permitted_idiom(self):
        r = AuthorizationResult(permitted=True)
        # Users should be able to use the .permitted attribute directly
        assert r.permitted

    def test_fields_populated(self):
        r = AuthorizationResult(
            permitted=True,
            agent="a",
            action="b",
            context={"k": "v"},
            reason="ok",
            permit_token="t",
            audit_hash="h",
            permit_hash="ph",
            verified=True,
            timestamp="2025-01-01T00:00:00Z",
            raw={"x": 1},
        )
        assert r.agent == "a"
        assert r.context == {"k": "v"}
        assert r.verified is True


# ── Sync client.authorize() ──────────────────────────────────────────


class TestClientAuthorize:
    @pytest.fixture
    def client(self):
        return AtlaSentClient(api_key="test_key", max_retries=0)

    def test_permit_with_verify(self, client, mocker):
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )
        result = client.authorize(
            agent="clinical-data-agent",
            action="modify_patient_record",
            context={"user": "dr_smith", "environment": "production"},
        )
        assert isinstance(result, AuthorizationResult)
        assert result.permitted is True
        assert result.agent == "clinical-data-agent"
        assert result.action == "modify_patient_record"
        assert result.context == {"user": "dr_smith", "environment": "production"}
        assert result.permit_token == "dec_alpha"
        assert result.audit_hash == "hash_alpha"
        assert result.permit_hash == "permit_alpha"
        assert result.verified is True
        assert result.reason == "Operator authorized under GxP policy"
        assert client._client.post.call_count == 2

    def test_permit_without_verify(self, client, mocker):
        mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_PERMIT),
        )
        result = client.authorize(agent="agent-1", action="read_data", verify=False)
        assert result.permitted is True
        assert result.verified is False
        assert result.permit_hash == ""
        assert client._client.post.call_count == 1

    def test_deny_does_not_raise_by_default(self, client, mocker):
        mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_DENY),
        )
        result = client.authorize(agent="agent-1", action="write_data")
        assert result.permitted is False
        assert result.reason == "Missing change_reason for critical field"
        assert result.permit_token == "dec_beta"
        assert result.verified is False
        assert result.raw == EVALUATE_DENY
        # verify step skipped on denial
        assert client._client.post.call_count == 1

    def test_deny_raises_when_requested(self, client, mocker):
        mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_DENY),
        )
        with pytest.raises(PermissionDeniedError) as exc_info:
            client.authorize(agent="a", action="b", raise_on_deny=True)
        assert exc_info.value.reason == "Missing change_reason for critical field"
        assert exc_info.value.permit_token == "dec_beta"

    def test_keyword_only(self, client):
        # Positional arguments must fail — enforce keyword contract
        with pytest.raises(TypeError):
            client.authorize("agent-1", "action")  # type: ignore[misc]

    def test_network_error_propagates(self, client, mocker):
        mocker.patch.object(
            client._client,
            "post",
            side_effect=httpx.ConnectError("refused"),
        )
        with pytest.raises(AtlaSentError, match="Failed to connect"):
            client.authorize(agent="a", action="b")

    def test_rate_limit_propagates(self, client, mocker):
        resp = _mock_resp(mocker, status_code=429, headers={"retry-after": "5"})
        mocker.patch.object(client._client, "post", return_value=resp)
        with pytest.raises(RateLimitError):
            client.authorize(agent="a", action="b")

    def test_none_context_is_ok(self, client, mocker):
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )
        result = client.authorize(agent="a", action="b", context=None)
        assert result.permitted is True
        assert result.context == {}

    def test_payload_shape_matches_api(self, client, mocker):
        mock_post = mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )
        client.authorize(
            agent="agent-X",
            action="act",
            context={"u": "v"},
        )
        evaluate_call = mock_post.call_args_list[0]
        verify_call = mock_post.call_args_list[1]

        assert evaluate_call[0][0].endswith("/v1-evaluate")
        assert evaluate_call[1]["json"]["action"] == "act"
        assert evaluate_call[1]["json"]["agent"] == "agent-X"
        assert evaluate_call[1]["json"]["context"] == {"u": "v"}

        assert verify_call[0][0].endswith("/v1-verify-permit")
        assert verify_call[1]["json"]["decision_id"] == "dec_alpha"


# ── Top-level authorize() function ───────────────────────────────────


class TestTopLevelAuthorize:
    def test_uses_global_config(self, mocker):
        configure(api_key="global_key")
        mock_post = mocker.patch("atlasent.client.httpx.Client.post")
        mock_post.side_effect = [
            _mock_resp(mocker, json_data=EVALUATE_PERMIT),
            _mock_resp(mocker, json_data=VERIFY_OK),
        ]
        result = authorize(
            agent="clinical-data-agent",
            action="modify_patient_record",
            context={"user": "dr_smith", "environment": "production"},
        )
        assert result.permitted is True
        assert result.verified is True
        assert result.agent == "clinical-data-agent"

    def test_deny_returns_not_permitted(self, mocker):
        configure(api_key="k")
        mock_post = mocker.patch("atlasent.client.httpx.Client.post")
        mock_post.return_value = _mock_resp(mocker, json_data=EVALUATE_DENY)
        result = authorize(agent="a", action="b")
        assert result.permitted is False
        assert result.reason == "Missing change_reason for critical field"

    def test_deny_raises_when_requested(self, mocker):
        configure(api_key="k")
        mock_post = mocker.patch("atlasent.client.httpx.Client.post")
        mock_post.return_value = _mock_resp(mocker, json_data=EVALUATE_DENY)
        with pytest.raises(PermissionDeniedError):
            authorize(agent="a", action="b", raise_on_deny=True)

    def test_missing_api_key_raises(self, mocker):
        mocker.patch.dict("os.environ", {}, clear=True)
        from atlasent.exceptions import ConfigurationError

        with pytest.raises(ConfigurationError, match="No API key"):
            authorize(agent="a", action="b")

    def test_reuses_singleton_client(self, mocker):
        configure(api_key="k")
        mock_post = mocker.patch("atlasent.client.httpx.Client.post")
        mock_post.side_effect = [
            _mock_resp(mocker, json_data=EVALUATE_PERMIT),
            _mock_resp(mocker, json_data=VERIFY_OK),
            _mock_resp(mocker, json_data=EVALUATE_PERMIT),
            _mock_resp(mocker, json_data=VERIFY_OK),
        ]
        r1 = authorize(agent="a", action="b")
        r2 = authorize(agent="a", action="c")
        assert r1.permitted and r2.permitted
        assert mock_post.call_count == 4

    def test_if_result_permitted_idiom(self, mocker):
        """Exercise the documented quickstart idiom end-to-end."""
        configure(api_key="k")
        mock_post = mocker.patch("atlasent.client.httpx.Client.post")
        mock_post.side_effect = [
            _mock_resp(mocker, json_data=EVALUATE_PERMIT),
            _mock_resp(mocker, json_data=VERIFY_OK),
        ]
        result = authorize(
            agent="clinical-data-agent",
            action="modify_patient_record",
            context={"user": "dr_smith", "environment": "production"},
        )
        executed = False
        if result.permitted:
            executed = True
        assert executed is True


# ── Async client.authorize() ─────────────────────────────────────────


class TestAsyncClientAuthorize:
    @pytest.mark.asyncio
    async def test_permit_with_verify(self, mocker):
        client = AsyncAtlaSentClient(api_key="k", max_retries=0)
        try:
            mocker.patch.object(
                client._client,
                "post",
                mocker.AsyncMock(
                    side_effect=[
                        _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                        _mock_resp(mocker, json_data=VERIFY_OK),
                    ]
                ),
            )
            result = await client.authorize(agent="agent-async", action="read")
            assert result.permitted is True
            assert result.verified is True
            assert result.permit_hash == "permit_alpha"
        finally:
            await client.close()

    @pytest.mark.asyncio
    async def test_deny_returns_not_permitted(self, mocker):
        client = AsyncAtlaSentClient(api_key="k", max_retries=0)
        try:
            deny_resp = _mock_resp(mocker, json_data=EVALUATE_DENY)
            mocker.patch.object(
                client._client,
                "post",
                mocker.AsyncMock(return_value=deny_resp),
            )
            result = await client.authorize(agent="a", action="b")
            assert result.permitted is False
            assert result.permit_token == "dec_beta"
        finally:
            await client.close()

    @pytest.mark.asyncio
    async def test_deny_raises_when_requested(self, mocker):
        client = AsyncAtlaSentClient(api_key="k", max_retries=0)
        try:
            deny_resp = _mock_resp(mocker, json_data=EVALUATE_DENY)
            mocker.patch.object(
                client._client,
                "post",
                mocker.AsyncMock(return_value=deny_resp),
            )
            with pytest.raises(PermissionDeniedError):
                await client.authorize(agent="a", action="b", raise_on_deny=True)
        finally:
            await client.close()
