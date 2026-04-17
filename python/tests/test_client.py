"""Tests for the synchronous AtlaSentClient."""

import httpx
import pytest

from atlasent.client import AtlaSentClient
from atlasent.exceptions import AtlaSentDenied, AtlaSentError, RateLimitError
from atlasent.models import EvaluateResult, GateResult, VerifyResult


@pytest.fixture
def client():
    return AtlaSentClient(api_key="test_key", max_retries=0)


@pytest.fixture
def client_retry():
    return AtlaSentClient(api_key="test_key", max_retries=2, retry_backoff=0.01)


EVALUATE_PERMIT = {
    "permitted": True,
    "decision_id": "dec_100",
    "reason": "Action complies with policy",
    "audit_hash": "hash_abc",
    "timestamp": "2025-01-15T12:00:00Z",
}

EVALUATE_DENY = {
    "permitted": False,
    "decision_id": "dec_101",
    "reason": "Missing required context",
    "audit_hash": "hash_def",
    "timestamp": "2025-01-15T12:01:00Z",
}

VERIFY_OK = {
    "verified": True,
    "permit_hash": "permit_xyz",
    "timestamp": "2025-01-15T12:05:00Z",
}


def _mock_resp(mocker, status_code=200, json_data=None, headers=None):
    resp = mocker.Mock(spec=httpx.Response)
    resp.status_code = status_code
    resp.headers = headers or {}
    resp.text = ""
    if json_data is not None:
        resp.json.return_value = json_data
    return resp


# ── Init ──────────────────────────────────────────────────────────────


class TestInit:
    def test_defaults(self):
        c = AtlaSentClient(api_key="k")
        assert c._api_key == "k"
        assert c._anon_key == ""
        assert c._base_url == "https://api.atlasent.io"
        assert c._timeout == 10
        assert c._max_retries == 2

    def test_custom(self):
        c = AtlaSentClient(
            api_key="k",
            anon_key="anon",
            base_url="https://staging.atlasent.io/",
            timeout=30,
            max_retries=5,
        )
        assert c._anon_key == "anon"
        assert c._base_url == "https://staging.atlasent.io"
        assert c._timeout == 30

    def test_user_agent(self):
        c = AtlaSentClient(api_key="k")
        assert "atlasent-python/" in c._client.headers["user-agent"]


# ── Evaluate ──────────────────────────────────────────────────────────


class TestEvaluate:
    def test_permit(self, client, mocker):
        resp = _mock_resp(mocker, json_data=EVALUATE_PERMIT)
        mocker.patch.object(client._client, "post", return_value=resp)
        result = client.evaluate("read_data", "agent-1", {"study": "S001"})

        assert isinstance(result, EvaluateResult)
        assert result.decision is True
        assert result.permit_token == "dec_100"
        assert result.reason == "Action complies with policy"

    def test_deny_raises(self, client, mocker):
        resp = _mock_resp(mocker, json_data=EVALUATE_DENY)
        mocker.patch.object(client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentDenied) as exc_info:
            client.evaluate("write_data", "agent-1")

        err = exc_info.value
        assert err.decision == "False"
        assert err.permit_token == "dec_101"
        assert err.reason == "Missing required context"
        assert err.response_body == EVALUATE_DENY

    def test_payload_shape(self, client, mocker):
        resp = _mock_resp(mocker, json_data=EVALUATE_PERMIT)
        mock_post = mocker.patch.object(client._client, "post", return_value=resp)

        client.evaluate("action", "actor", {"k": "v"})

        call_kwargs = mock_post.call_args
        payload = call_kwargs[1]["json"]
        assert payload["action"] == "action"
        assert payload["agent"] == "actor"
        assert payload["context"] == {"k": "v"}
        assert payload["api_key"] == "test_key"

    def test_timeout_raises(self, client, mocker):
        mocker.patch.object(
            client._client, "post", side_effect=httpx.TimeoutException("timeout")
        )
        with pytest.raises(AtlaSentError, match="timed out"):
            client.evaluate("a", "b")

    def test_connection_error(self, client, mocker):
        mocker.patch.object(
            client._client, "post", side_effect=httpx.ConnectError("refused")
        )
        with pytest.raises(AtlaSentError, match="Failed to connect"):
            client.evaluate("a", "b")

    def test_401(self, client, mocker):
        mocker.patch.object(
            client._client, "post", return_value=_mock_resp(mocker, status_code=401)
        )
        with pytest.raises(AtlaSentError, match="Invalid API key") as exc_info:
            client.evaluate("a", "b")
        assert exc_info.value.status_code == 401

    def test_500(self, client, mocker):
        resp = _mock_resp(mocker, status_code=500)
        resp.text = "Internal Server Error"
        mocker.patch.object(client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError, match="API error 500"):
            client.evaluate("a", "b")


# ── Verify ────────────────────────────────────────────────────────────


class TestVerify:
    def test_valid(self, client, mocker):
        mocker.patch.object(
            client._client, "post", return_value=_mock_resp(mocker, json_data=VERIFY_OK)
        )
        result = client.verify("dec_100", "read_data", "agent-1")

        assert isinstance(result, VerifyResult)
        assert result.valid is True
        assert result.permit_hash == "permit_xyz"

    def test_payload_shape(self, client, mocker):
        resp = _mock_resp(mocker, json_data=VERIFY_OK)
        mock_post = mocker.patch.object(client._client, "post", return_value=resp)

        client.verify("dec_100", "read_data", "agent-1", {"k": "v"})

        payload = mock_post.call_args[1]["json"]
        assert payload["decision_id"] == "dec_100"
        assert payload["action"] == "read_data"
        assert payload["agent"] == "agent-1"
        assert payload["context"] == {"k": "v"}


# ── Gate ──────────────────────────────────────────────────────────────


class TestGate:
    def test_permit_and_verify(self, client, mocker):
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )
        result = client.gate("read_data", "agent-1", {"study": "S001"})

        assert isinstance(result, GateResult)
        assert result.evaluation.permit_token == "dec_100"
        assert result.verification.valid is True
        assert client._client.post.call_count == 2

    def test_deny_at_evaluate(self, client, mocker):
        mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_DENY),
        )
        with pytest.raises(AtlaSentDenied):
            client.gate("write_data", "agent-1")

        # verify should NOT have been called
        assert client._client.post.call_count == 1


# ── Retry ─────────────────────────────────────────────────────────────


class TestRetry:
    def test_retries_on_timeout(self, client_retry, mocker):
        ok = _mock_resp(mocker, json_data=EVALUATE_PERMIT)
        mocker.patch.object(
            client_retry._client,
            "post",
            side_effect=[httpx.TimeoutException("t"), ok],
        )
        result = client_retry.evaluate("a", "b")
        assert result.permit_token == "dec_100"
        assert client_retry._client.post.call_count == 2

    def test_retries_on_5xx(self, client_retry, mocker):
        err = _mock_resp(mocker, status_code=502)
        err.text = "Bad Gateway"
        ok = _mock_resp(mocker, json_data=EVALUATE_PERMIT)
        mocker.patch.object(client_retry._client, "post", side_effect=[err, ok])
        result = client_retry.evaluate("a", "b")
        assert result.permit_token == "dec_100"

    def test_exhausted(self, client_retry, mocker):
        mocker.patch.object(
            client_retry._client,
            "post",
            side_effect=httpx.TimeoutException("t"),
        )
        with pytest.raises(AtlaSentError, match="3 attempts"):
            client_retry.evaluate("a", "b")
        assert client_retry._client.post.call_count == 3

    def test_no_retry_on_4xx(self, client_retry, mocker):
        resp = _mock_resp(mocker, status_code=422)
        resp.text = "Unprocessable"
        mocker.patch.object(client_retry._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError, match="422"):
            client_retry.evaluate("a", "b")
        assert client_retry._client.post.call_count == 1


# ── Rate Limiting ─────────────────────────────────────────────────────


class TestRateLimit:
    def test_429(self, client, mocker):
        resp = _mock_resp(mocker, status_code=429, headers={"retry-after": "30"})
        mocker.patch.object(client._client, "post", return_value=resp)
        with pytest.raises(RateLimitError) as exc_info:
            client.evaluate("a", "b")
        assert exc_info.value.retry_after == 30.0

    def test_429_no_header(self, client, mocker):
        resp = _mock_resp(mocker, status_code=429)
        mocker.patch.object(client._client, "post", return_value=resp)
        with pytest.raises(RateLimitError) as exc_info:
            client.evaluate("a", "b")
        assert exc_info.value.retry_after is None


# ── Error codes (SDK-PY-002 / SDK-PY-003) ────────────────────────────


class TestErrorCodes:
    def test_401_has_invalid_api_key_code(self, client, mocker):
        mocker.patch.object(
            client._client, "post", return_value=_mock_resp(mocker, status_code=401)
        )
        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("a", "b")
        assert exc_info.value.code == "invalid_api_key"
        assert exc_info.value.status_code == 401

    def test_403_has_forbidden_code(self, client, mocker):
        mocker.patch.object(
            client._client, "post", return_value=_mock_resp(mocker, status_code=403)
        )
        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("a", "b")
        assert exc_info.value.code == "forbidden"

    def test_500_has_server_error_code(self, client, mocker):
        resp = _mock_resp(mocker, status_code=500)
        resp.text = "boom"
        mocker.patch.object(client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("a", "b")
        assert exc_info.value.code == "server_error"

    def test_422_has_bad_request_code(self, client, mocker):
        resp = _mock_resp(mocker, status_code=422)
        resp.text = "bad field"
        mocker.patch.object(client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("a", "b")
        assert exc_info.value.code == "bad_request"

    def test_timeout_has_timeout_code(self, client, mocker):
        mocker.patch.object(
            client._client, "post", side_effect=httpx.TimeoutException("t")
        )
        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("a", "b")
        assert exc_info.value.code == "timeout"

    def test_connection_error_has_network_code(self, client, mocker):
        mocker.patch.object(
            client._client, "post", side_effect=httpx.ConnectError("refused")
        )
        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("a", "b")
        assert exc_info.value.code == "network"

    def test_malformed_evaluate_body_is_bad_response(self, client, mocker):
        # Valid JSON, but missing `permitted` and `decision_id`.
        resp = _mock_resp(mocker, json_data={"foo": "bar"})
        mocker.patch.object(client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("a", "b")
        assert exc_info.value.code == "bad_response"
        assert exc_info.value.response_body == {"foo": "bar"}
        assert "permitted" in exc_info.value.message

    def test_malformed_verify_body_is_bad_response(self, client, mocker):
        resp = _mock_resp(mocker, json_data={"outcome": "ok"})
        mocker.patch.object(client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError) as exc_info:
            client.verify("dec_100")
        assert exc_info.value.code == "bad_response"
        assert "verified" in exc_info.value.message

    def test_invalid_json_is_bad_response(self, client, mocker):
        resp = _mock_resp(mocker, status_code=200)
        resp.json.side_effect = ValueError("not json")
        mocker.patch.object(client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("a", "b")
        assert exc_info.value.code == "bad_response"


# ── Resource Management ───────────────────────────────────────────────


class TestLifecycle:
    def test_close(self, client, mocker):
        mock_close = mocker.patch.object(client._client, "close")
        client.close()
        mock_close.assert_called_once()

    def test_context_manager(self, mocker):
        with AtlaSentClient(api_key="k", max_retries=0) as c:
            mock_close = mocker.patch.object(c._client, "close")
        mock_close.assert_called_once()


# ── Edge Cases ────────────────────────────────────────────────────────


class TestEdgeCases:
    def test_malformed_json_response(self, client, mocker):
        """Server returns 200 but invalid JSON."""
        resp = mocker.Mock(spec=httpx.Response)
        resp.status_code = 200
        resp.json.side_effect = ValueError("No JSON")
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentError, match="Invalid JSON"):
            client.evaluate("a", "b")

    def test_partial_evaluate_response(self, client, mocker):
        """Server returns 200 but missing required fields."""
        resp = _mock_resp(mocker, json_data={"permitted": True})
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(Exception):
            # Pydantic validation fails on missing decision_id
            client.evaluate("a", "b")

    def test_none_context_treated_as_empty(self, client, mocker):
        resp = _mock_resp(mocker, json_data=EVALUATE_PERMIT)
        mock_post = mocker.patch.object(client._client, "post", return_value=resp)

        client.evaluate("action", "actor", None)

        payload = mock_post.call_args[1]["json"]
        assert payload["context"] == {}

    def test_empty_context_dict(self, client, mocker):
        resp = _mock_resp(mocker, json_data=EVALUATE_PERMIT)
        mock_post = mocker.patch.object(client._client, "post", return_value=resp)

        client.evaluate("action", "actor", {})

        payload = mock_post.call_args[1]["json"]
        assert payload["context"] == {}

    def test_gate_does_not_call_verify_on_deny(self, client, mocker):
        """gate() should stop after evaluate if denied."""
        resp = _mock_resp(mocker, json_data=EVALUATE_DENY)
        mock_post = mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentDenied):
            client.gate("a", "b")

        assert mock_post.call_count == 1

    def test_denied_response_body_preserved(self, client, mocker):
        """AtlaSentDenied should carry the full response body."""
        deny_data = {
            "permitted": False,
            "decision_id": "dec_999",
            "reason": "policy violation",
            "audit_hash": "h",
            "timestamp": "t",
            "extra_field": "preserved",
        }
        resp = _mock_resp(mocker, json_data=deny_data)
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentDenied) as exc_info:
            client.evaluate("a", "b")

        assert exc_info.value.response_body["extra_field"] == "preserved"

    def test_large_error_body_truncated(self, client, mocker):
        resp = _mock_resp(mocker, status_code=400)
        resp.text = "x" * 1000
        mocker.patch.object(client._client, "post", return_value=resp)

        with pytest.raises(AtlaSentError) as exc_info:
            client.evaluate("a", "b")

        assert len(exc_info.value.message) < 600

    def test_verify_with_minimal_params(self, client, mocker):
        """verify() works with just permit_token."""
        resp = _mock_resp(mocker, json_data=VERIFY_OK)
        mock_post = mocker.patch.object(client._client, "post", return_value=resp)

        result = client.verify("dec_100")

        assert result.valid is True
        payload = mock_post.call_args[1]["json"]
        assert payload["decision_id"] == "dec_100"
        assert payload["action"] == ""
        assert payload["agent"] == ""
