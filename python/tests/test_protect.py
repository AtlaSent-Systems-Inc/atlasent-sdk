"""Tests for atlasent.protect() — the category primitive."""

import httpx
import pytest

from atlasent import (
    AsyncAtlaSentClient,
    AtlaSentClient,
    AtlaSentDenied,
    AtlaSentDeniedError,
    AtlaSentError,
    Permit,
    protect,
)
from atlasent.authorize import _reset_default_client
from atlasent.config import configure
from atlasent.models import AuthorizationResult

EVALUATE_PERMIT = {
    "permitted": True,
    "decision_id": "dec_alpha",
    "reason": "policy authorized",
    "audit_hash": "hash_alpha",
    "timestamp": "2026-04-23T10:00:00Z",
}

EVALUATE_DENY = {
    "permitted": False,
    "decision_id": "dec_beta",
    "reason": "missing change_reason",
    "audit_hash": "hash_beta",
    "timestamp": "2026-04-23T10:00:00Z",
}

VERIFY_OK = {
    "verified": True,
    "outcome": "verified",
    "permit_hash": "permit_alpha",
    "timestamp": "2026-04-23T10:00:01Z",
}

VERIFY_REVOKED = {
    "verified": False,
    "outcome": "revoked",
    "permit_hash": "permit_alpha",
    "timestamp": "2026-04-23T10:00:01Z",
}


def _mock_resp(mocker, status_code=200, json_data=None):
    resp = mocker.Mock(spec=httpx.Response)
    resp.status_code = status_code
    resp.headers = {}
    resp.text = ""
    if json_data is not None:
        resp.json.return_value = json_data
    return resp


# ── Sync: AtlaSentClient.protect ───────────────────────────────────────


class TestSyncProtect:
    def test_returns_verified_permit_on_allow(self, mocker):
        client = AtlaSentClient(api_key="k", max_retries=0)
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )
        permit = client.protect(
            agent="deploy-bot",
            action="deploy_to_production",
            context={"commit": "abc123"},
        )
        assert isinstance(permit, Permit)
        assert permit.permit_id == "dec_alpha"
        assert permit.permit_hash == "permit_alpha"
        assert permit.audit_hash == "hash_alpha"
        assert permit.reason == "policy authorized"
        assert permit.timestamp == "2026-04-23T10:00:01Z"

    def test_raises_denied_on_policy_deny(self, mocker):
        client = AtlaSentClient(api_key="k", max_retries=0)
        mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_DENY),
        )
        with pytest.raises(AtlaSentDeniedError) as exc_info:
            client.protect(agent="bot", action="deploy")

        err = exc_info.value
        assert err.decision == "deny"
        assert err.evaluation_id == "dec_beta"
        assert err.reason == "missing change_reason"
        assert err.audit_hash == "hash_beta"
        # Verify the round-trip didn't happen — only one call.
        assert client._client.post.call_count == 1

    def test_deny_is_also_catchable_as_parent_class(self, mocker):
        """Single exception family: `except AtlaSentDenied` still works."""
        client = AtlaSentClient(api_key="k", max_retries=0)
        mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_DENY),
        )
        with pytest.raises(AtlaSentDenied):
            client.protect(agent="bot", action="deploy")

    def test_raises_denied_on_verify_revoked(self, mocker):
        client = AtlaSentClient(api_key="k", max_retries=0)
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_REVOKED),
            ],
        )
        with pytest.raises(AtlaSentDeniedError) as exc_info:
            client.protect(agent="bot", action="deploy")
        err = exc_info.value
        assert err.decision == "deny"
        assert err.evaluation_id == "dec_alpha"
        assert "revoked" in err.reason
        # Audit hash preserved from the allow evaluation.
        assert err.audit_hash == "hash_alpha"

    def test_transport_error_propagates_as_atlasent_error_not_denied(self, mocker):
        client = AtlaSentClient(api_key="k", max_retries=0)
        mocker.patch.object(
            client._client,
            "post",
            side_effect=httpx.TimeoutException("t"),
        )
        with pytest.raises(AtlaSentError) as exc_info:
            client.protect(agent="a", action="b")
        # Not misrouted as a denial.
        assert not isinstance(exc_info.value, AtlaSentDeniedError)

    def test_http_500_propagates_as_atlasent_error(self, mocker):
        client = AtlaSentClient(api_key="k", max_retries=0)
        resp = _mock_resp(mocker, status_code=500)
        resp.text = "boom"
        mocker.patch.object(client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError) as exc_info:
            client.protect(agent="a", action="b")
        assert exc_info.value.code == "server_error"

    def test_payload_passes_agent_action_context_to_both_endpoints(self, mocker):
        client = AtlaSentClient(api_key="k", max_retries=0)
        mock_post = mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )
        client.protect(
            agent="deploy-bot",
            action="deploy",
            context={"commit": "abc123"},
        )

        # evaluate call (first)
        evaluate_payload = mock_post.call_args_list[0][1]["json"]
        assert evaluate_payload["agent"] == "deploy-bot"
        assert evaluate_payload["action"] == "deploy"
        assert evaluate_payload["context"] == {"commit": "abc123"}

        # verifyPermit call (second) — server cross-check
        verify_payload = mock_post.call_args_list[1][1]["json"]
        assert verify_payload["decision_id"] == "dec_alpha"
        assert verify_payload["agent"] == "deploy-bot"
        assert verify_payload["action"] == "deploy"
        assert verify_payload["context"] == {"commit": "abc123"}

    def test_default_empty_context(self, mocker):
        client = AtlaSentClient(api_key="k", max_retries=0)
        mock_post = mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )
        client.protect(agent="a", action="b")
        assert mock_post.call_args_list[0][1]["json"]["context"] == {}

    def test_deny_with_none_response_body_uses_empty_audit_hash(self, mocker):
        client = AtlaSentClient(api_key="k", max_retries=0)
        mocker.patch.object(
            client,
            "evaluate",
            side_effect=AtlaSentDenied("denied", permit_token="tok", response_body=None),
        )
        with pytest.raises(AtlaSentDeniedError) as exc_info:
            client.protect(agent="bot", action="deploy")
        assert exc_info.value.audit_hash == ""

    def test_deny_with_non_string_audit_hash_uses_empty_audit_hash(self, mocker):
        client = AtlaSentClient(api_key="k", max_retries=0)
        mocker.patch.object(
            client,
            "evaluate",
            side_effect=AtlaSentDenied(
                "denied",
                permit_token="tok",
                response_body={"audit_hash": 12345},
            ),
        )
        with pytest.raises(AtlaSentDeniedError) as exc_info:
            client.protect(agent="bot", action="deploy")
        assert exc_info.value.audit_hash == ""


# ── Async: AsyncAtlaSentClient.protect ─────────────────────────────────


class TestAsyncProtect:
    @pytest.mark.asyncio
    async def test_returns_verified_permit_on_allow(self, mocker):
        client = AsyncAtlaSentClient(api_key="k", max_retries=0)
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )
        permit = await client.protect(
            agent="deploy-bot",
            action="deploy_to_production",
            context={"commit": "abc123"},
        )
        assert isinstance(permit, Permit)
        assert permit.permit_id == "dec_alpha"

    @pytest.mark.asyncio
    async def test_raises_denied_on_deny(self, mocker):
        client = AsyncAtlaSentClient(api_key="k", max_retries=0)
        mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_DENY),
        )
        with pytest.raises(AtlaSentDeniedError) as exc_info:
            await client.protect(agent="bot", action="deploy")
        assert exc_info.value.decision == "deny"
        assert exc_info.value.evaluation_id == "dec_beta"

    @pytest.mark.asyncio
    async def test_raises_denied_on_verify_revoked(self, mocker):
        client = AsyncAtlaSentClient(api_key="k", max_retries=0)
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_REVOKED),
            ],
        )
        with pytest.raises(AtlaSentDeniedError) as exc_info:
            await client.protect(agent="bot", action="deploy")
        assert exc_info.value.evaluation_id == "dec_alpha"
        assert "revoked" in exc_info.value.reason

    @pytest.mark.asyncio
    async def test_deny_with_none_response_body_uses_empty_audit_hash(self, mocker):
        client = AsyncAtlaSentClient(api_key="k", max_retries=0)
        mocker.patch.object(
            client,
            "evaluate",
            side_effect=AtlaSentDenied("denied", permit_token="tok", response_body=None),
        )
        with pytest.raises(AtlaSentDeniedError) as exc_info:
            await client.protect(agent="bot", action="deploy")
        assert exc_info.value.audit_hash == ""

    @pytest.mark.asyncio
    async def test_deny_with_non_string_audit_hash_uses_empty_audit_hash(self, mocker):
        client = AsyncAtlaSentClient(api_key="k", max_retries=0)
        mocker.patch.object(
            client,
            "evaluate",
            side_effect=AtlaSentDenied(
                "denied",
                permit_token="tok",
                response_body={"audit_hash": ["not", "a", "string"]},
            ),
        )
        with pytest.raises(AtlaSentDeniedError) as exc_info:
            await client.protect(agent="bot", action="deploy")
        assert exc_info.value.audit_hash == ""

    @pytest.mark.asyncio
    async def test_authorize_verify_false_skips_verify_call(self, mocker):
        client = AsyncAtlaSentClient(api_key="k", max_retries=0)
        mock_post = mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_PERMIT),
        )
        result = await client.authorize(agent="bot", action="deploy", verify=False)
        assert isinstance(result, AuthorizationResult)
        assert result.permitted is True
        assert result.permit_hash == ""
        assert result.verified is False
        # Only evaluate was called — no verify round-trip.
        assert mock_post.call_count == 1


# ── Module-level: atlasent.protect ─────────────────────────────────────


class TestModuleLevelProtect:
    def setup_method(self):
        _reset_default_client()

    def teardown_method(self):
        _reset_default_client()

    def test_uses_configured_global_client(self, mocker):
        configure(api_key="ask_test")
        # Patch on whichever singleton the module reaches for.
        from atlasent.authorize import _get_default_client

        client = _get_default_client()
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        permit = protect(agent="a", action="b")
        assert isinstance(permit, Permit)
        assert permit.permit_id == "dec_alpha"

    def test_module_level_raises_denied_on_deny(self, mocker):
        configure(api_key="ask_test")
        from atlasent.authorize import _get_default_client

        client = _get_default_client()
        mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_DENY),
        )

        with pytest.raises(AtlaSentDeniedError):
            protect(agent="a", action="b")


# ── AtlaSentDeniedError shape ──────────────────────────────────────────


class TestAtlaSentDeniedErrorShape:
    def test_fields_match_typescript_parity(self):
        err = AtlaSentDeniedError(
            decision="deny",
            evaluation_id="dec_x",
            reason="policy said no",
            audit_hash="h_x",
        )
        assert err.decision == "deny"
        assert err.evaluation_id == "dec_x"
        assert err.reason == "policy said no"
        assert err.audit_hash == "h_x"
        # permit_token is the AtlaSentDenied legacy alias — same data.
        assert err.permit_token == "dec_x"

    def test_is_atlasent_denied_subclass(self):
        err = AtlaSentDeniedError(decision="deny", evaluation_id="dec_x")
        assert isinstance(err, AtlaSentDenied)
        assert isinstance(err, AtlaSentError)

    def test_decision_union_allows_hold_and_escalate(self):
        # Compile-only parity: the union includes values the API may
        # start returning. Today only "deny" is emitted internally.
        hold = AtlaSentDeniedError(decision="hold", evaluation_id="dec_x")
        escalate = AtlaSentDeniedError(decision="escalate", evaluation_id="dec_x")
        assert hold.decision == "hold"
        assert escalate.decision == "escalate"

    def test_default_decision_is_deny(self):
        err = AtlaSentDeniedError(evaluation_id="dec_x")
        assert err.decision == "deny"
