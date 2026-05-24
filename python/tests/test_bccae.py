"""Tests for atlasent.bccae — BCCAEClient."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import pytest

from atlasent.bccae import BCCAEClient, generate_bccae_nonce
from atlasent.exceptions import AtlaSentError

# ── helpers ───────────────────────────────────────────────────────────────────


def _mock_response(body: object, status: int = 200) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.json.return_value = body
    resp.is_success = 200 <= status < 300
    return resp


def _client(base_url: str = "https://api.atlasent.io") -> BCCAEClient:
    return BCCAEClient(api_key="bk_test_abc", base_url=base_url)


def _minimal_evaluate_kwargs() -> dict:
    return {
        "actor_id": "agent-1",
        "actor_type": "AGENT",
        "actor_trust_level": "L2",
        "action_id": "production.deploy",
        "execution_intent": "deploy commit abc123",
        "caller_nonce": generate_bccae_nonce(),
        "resource_ref": "service/api",
        "resource_type": "SERVICE",
        "resource_classification": "CONFIDENTIAL",
        "deployment_env": "PROD",
        "deployment_region": "us-east-1",
        "security_posture": "STANDARD",
    }


_EVALUATE_RESPONSE = {
    "evaluation_id": "eval_abc",
    "envelope_hash": "deadbeef01",
    "permit_token": "bce.v1.abc.sig",
    "permit_id": "permit_xyz",
    "expires_at": "2026-05-24T02:00:00Z",
    "outcome": "PERMIT",
}

_EVIDENCE_RESPONSE = {
    "evidence_id": "ev_1",
    "org_id": "org_1",
    "event_type": "EVALUATION_COMPLETE",
    "evaluation_id": "eval_abc",
    "actor_id": "agent-1",
    "action_id": "production.deploy",
    "outcome": "PERMIT",
    "detail": {},
    "record_hash": "abc123",
    "sequence": 1,
    "recorded_at": "2026-05-24T01:00:00Z",
    "chain_integrity": {"hash_intact": True},
}


# ── generate_bccae_nonce ──────────────────────────────────────────────────────


class TestGenerateBccaeNonce:
    def test_returns_64_chars(self) -> None:
        assert len(generate_bccae_nonce()) == 64

    def test_returns_only_hex_chars(self) -> None:
        nonce = generate_bccae_nonce()
        assert all(c in "0123456789abcdef" for c in nonce)

    def test_generates_unique_values(self) -> None:
        assert generate_bccae_nonce() != generate_bccae_nonce()


# ── BCCAEClient constructor ───────────────────────────────────────────────────


class TestBCCAEClientConstructor:
    def test_constructs_with_valid_api_key(self) -> None:
        client = BCCAEClient(api_key="bk_test")
        client.close()

    def test_raises_on_empty_api_key(self) -> None:
        with pytest.raises(ValueError, match="api_key"):
            BCCAEClient(api_key="")

    def test_raises_on_non_string_api_key(self) -> None:
        with pytest.raises(ValueError, match="api_key"):
            BCCAEClient(api_key=None)  # type: ignore[arg-type]

    def test_rejects_non_local_http_url(self) -> None:
        with pytest.raises(ValueError, match="https"):
            BCCAEClient(api_key="bk_test", base_url="http://remote.example.com")

    def test_rejects_ftp_url(self) -> None:
        with pytest.raises(ValueError, match="https"):
            BCCAEClient(api_key="bk_test", base_url="ftp://files.example.com")

    def test_allows_https_url(self) -> None:
        client = BCCAEClient(api_key="bk_test", base_url="https://api.atlasent.io")
        client.close()

    def test_allows_http_localhost(self) -> None:
        client = BCCAEClient(api_key="bk_test", base_url="http://localhost:3000")
        client.close()

    def test_allows_http_127_0_0_1(self) -> None:
        client = BCCAEClient(api_key="bk_test", base_url="http://127.0.0.1:9000")
        client.close()

    def test_context_manager(self) -> None:
        with BCCAEClient(api_key="bk_test") as client:
            assert client is not None


# ── evaluate ──────────────────────────────────────────────────────────────────


class TestEvaluate:
    def test_posts_to_evaluations_endpoint(self) -> None:
        client = _client()
        mock_resp = _mock_response(_EVALUATE_RESPONSE, 201)
        with patch.object(client._client, "post", return_value=mock_resp) as mock_post:
            result = client.evaluate(**_minimal_evaluate_kwargs())
        mock_post.assert_called_once()
        url_arg = mock_post.call_args[0][0]
        assert url_arg.endswith("/v1/bccae/evaluations")
        assert result["evaluation_id"] == "eval_abc"
        assert result["permit_token"] == "bce.v1.abc.sig"

    def test_passes_required_fields(self) -> None:
        client = _client()
        mock_resp = _mock_response(_EVALUATE_RESPONSE, 201)
        with patch.object(client._client, "post", return_value=mock_resp) as mock_post:
            client.evaluate(**_minimal_evaluate_kwargs())
        body = mock_post.call_args[1]["json"]
        assert body["actor_id"] == "agent-1"
        assert body["action_id"] == "production.deploy"

    def test_includes_optional_fields_when_provided(self) -> None:
        client = _client()
        mock_resp = _mock_response(_EVALUATE_RESPONSE, 201)
        kwargs = _minimal_evaluate_kwargs()
        kwargs["actor_claims"] = {"role": "deployer"}
        kwargs["organization_version"] = 42
        kwargs["request_source"] = "API"
        kwargs["request_chain_id"] = "chain-1"
        kwargs["parent_eval_id"] = "parent-1"
        kwargs["external_signals"] = [{"type": "scan"}]
        kwargs["dependencies"] = [{"id": "dep-1"}]
        kwargs["policy_version_set"] = [{"policy": "v1"}]
        with patch.object(client._client, "post", return_value=mock_resp) as mock_post:
            client.evaluate(**kwargs)
        body = mock_post.call_args[1]["json"]
        assert body["actor_claims"] == {"role": "deployer"}
        assert body["organization_version"] == 42
        assert body["request_source"] == "API"
        assert body["request_chain_id"] == "chain-1"
        assert body["parent_eval_id"] == "parent-1"
        assert body["external_signals"] == [{"type": "scan"}]

    def test_omits_none_optional_fields(self) -> None:
        client = _client()
        mock_resp = _mock_response(_EVALUATE_RESPONSE, 201)
        with patch.object(client._client, "post", return_value=mock_resp) as mock_post:
            client.evaluate(**_minimal_evaluate_kwargs())
        body = mock_post.call_args[1]["json"]
        assert "actor_claims" not in body
        assert "organization_version" not in body


# ── execute ───────────────────────────────────────────────────────────────────


class TestExecute:
    def test_posts_to_execute_endpoint(self) -> None:
        client = _client()
        exec_resp = {"authorized": True, "outcome": "EXECUTION_AUTHORIZED"}
        mock_resp = _mock_response(exec_resp)
        with patch.object(client._client, "post", return_value=mock_resp) as mock_post:
            result = client.execute(
                permit_token="bce.v1.abc.sig",
                action_id="production.deploy",
                resource_ref="service/api",
            )
        url_arg = mock_post.call_args[0][0]
        assert url_arg.endswith("/v1/bccae/execute")
        assert result["authorized"] is True

    def test_returns_denial_as_dict_not_raise(self) -> None:
        client = _client()
        denial = {"authorized": False, "outcome": "EXECUTION_DENIED", "check": "EXPIRY"}
        with patch.object(client._client, "post", return_value=_mock_response(denial)):
            result = client.execute(
                permit_token="bce.v1.abc.sig",
                action_id="production.deploy",
                resource_ref="service/api",
            )
        assert result["authorized"] is False
        assert result["check"] == "EXPIRY"


# ── revoke ────────────────────────────────────────────────────────────────────


class TestRevoke:
    def test_posts_to_revocations_endpoint(self) -> None:
        client = _client()
        revoke_resp = {
            "revocation_id": "rev_1",
            "target_type": "PERMIT",
            "target_id": "permit_xyz",
            "effective_at": "2026-05-24T01:45:00Z",
        }
        mock_resp = _mock_response(revoke_resp, 201)
        with patch.object(client._client, "post", return_value=mock_resp) as mock_post:
            result = client.revoke(
                target_type="PERMIT",
                target_id="permit_xyz",
                reason="operator override",
            )
        url_arg = mock_post.call_args[0][0]
        assert url_arg.endswith("/v1/bccae/revocations")
        assert result["revocation_id"] == "rev_1"


# ── get_evidence ──────────────────────────────────────────────────────────────


class TestGetEvidence:
    def test_gets_from_evidence_endpoint(self) -> None:
        client = _client()
        ev_mock = _mock_response(_EVIDENCE_RESPONSE)
        with patch.object(client._client, "get", return_value=ev_mock) as mock_get:
            result = client.get_evidence("ev_1")
        url_arg = mock_get.call_args[0][0]
        assert url_arg.endswith("/v1/bccae/evidence/ev_1")
        assert result["evidence_id"] == "ev_1"
        assert result["chain_integrity"]["hash_intact"] is True

    def test_raises_on_empty_evidence_id(self) -> None:
        client = _client()
        with pytest.raises(ValueError, match="evidence_id"):
            client.get_evidence("")

    def test_raises_on_non_string_evidence_id(self) -> None:
        client = _client()
        with pytest.raises(ValueError, match="evidence_id"):
            client.get_evidence(None)  # type: ignore[arg-type]


# ── error handling ────────────────────────────────────────────────────────────


class TestErrorHandling:
    @pytest.mark.parametrize(
        "status,expected_code",
        [
            (401, "unauthorized"),
            (403, "permission_denied"),
            (404, "not_found"),
            (409, "conflict"),
            (429, "rate_limited"),
            (500, "network"),
            (503, "network"),
        ],
    )
    def test_http_error_codes(self, status: int, expected_code: str) -> None:
        client = _client()
        mock_resp = _mock_response({"message": f"HTTP {status}"}, status)
        with patch.object(client._client, "post", return_value=mock_resp):
            with pytest.raises(AtlaSentError) as exc_info:
                client.evaluate(**_minimal_evaluate_kwargs())
        assert exc_info.value.code == expected_code

    def test_uses_message_from_error_body(self) -> None:
        client = _client()
        mock_resp = _mock_response({"message": "custom error"}, 403)
        with patch.object(client._client, "post", return_value=mock_resp):
            with pytest.raises(AtlaSentError, match="custom error"):
                client.evaluate(**_minimal_evaluate_kwargs())

    def test_generic_message_when_no_body_message(self) -> None:
        client = _client()
        mock_resp = _mock_response({"code": "unknown"}, 500)
        with patch.object(client._client, "post", return_value=mock_resp):
            with pytest.raises(AtlaSentError, match="status 500"):
                client.evaluate(**_minimal_evaluate_kwargs())

    def test_non_json_response_raises(self) -> None:
        client = _client()
        mock_resp = MagicMock(spec=httpx.Response)
        mock_resp.status_code = 200
        mock_resp.is_success = True
        mock_resp.json.side_effect = ValueError("not json")
        with patch.object(client._client, "post", return_value=mock_resp):
            with pytest.raises(AtlaSentError) as exc_info:
                client.evaluate(**_minimal_evaluate_kwargs())
        assert exc_info.value.code == "network"

    def test_network_error_on_post_raises(self) -> None:
        client = _client()
        with patch.object(
            client._client,
            "post",
            side_effect=httpx.TransportError("ECONNREFUSED"),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                client.evaluate(**_minimal_evaluate_kwargs())
        assert exc_info.value.code == "network"

    def test_network_error_on_get_raises(self) -> None:
        client = _client()
        with patch.object(
            client._client,
            "get",
            side_effect=httpx.TransportError("ECONNREFUSED"),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                client.get_evidence("ev_1")
        assert exc_info.value.code == "network"

    def test_network_error_message_includes_path(self) -> None:
        client = _client()
        with patch.object(
            client._client,
            "post",
            side_effect=httpx.TransportError("connection refused"),
        ):
            with pytest.raises(AtlaSentError, match=r"/v1/bccae/evaluations"):
                client.evaluate(**_minimal_evaluate_kwargs())
