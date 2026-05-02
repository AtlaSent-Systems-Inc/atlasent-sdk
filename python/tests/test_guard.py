"""Tests for atlasent_guard and async_atlasent_guard decorators."""

import httpx
import pytest

from atlasent.async_client import AsyncAtlaSentClient
from atlasent.client import AtlaSentClient
from atlasent.exceptions import AtlaSentDenied
from atlasent.guard import async_atlasent_guard, atlasent_guard
from atlasent.models import GateResult

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


def _mock_resp(mocker, status_code=200, json_data=None):
    resp = mocker.Mock(spec=httpx.Response)
    resp.status_code = status_code
    resp.headers = {}
    resp.text = ""
    if json_data is not None:
        resp.json.return_value = json_data
    return resp


class TestAtlaSentGuard:
    def test_permit_passes_gate_result(self, mocker):
        client = AtlaSentClient(api_key="ask_test_xxxxxxxx", max_retries=0)
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        @atlasent_guard(client, "read_data", actor_id="agent-1")
        def my_func(gate_result=None):
            return gate_result

        result = my_func()
        assert isinstance(result, GateResult)
        assert result.evaluation.permit_token == "dec_100"

    def test_deny_raises(self, mocker):
        client = AtlaSentClient(api_key="ask_test_xxxxxxxx", max_retries=0)
        mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_DENY),
        )

        @atlasent_guard(client, "write_data", actor_id="agent-1")
        def my_func(gate_result=None):
            return gate_result

        with pytest.raises(AtlaSentDenied):
            my_func()

    def test_dynamic_actor_id(self, mocker):
        client = AtlaSentClient(api_key="ask_test_xxxxxxxx", max_retries=0)
        mock_post = mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        @atlasent_guard(client, "read_data", actor_id_kwarg="agent_id")
        def my_func(agent_id="default", gate_result=None):
            return gate_result

        my_func(agent_id="dynamic-agent")
        payload = mock_post.call_args_list[0][1]["json"]
        assert payload["actor_id"] == "dynamic-agent"

    def test_dynamic_context_merges_with_static(self, mocker):
        client = AtlaSentClient(api_key="ask_test_xxxxxxxx", max_retries=0)
        mock_post = mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        @atlasent_guard(
            client,
            "read_data",
            actor_id="agent-1",
            context={"environment": "prod"},
            context_kwarg="ctx",
        )
        def my_func(ctx=None, gate_result=None):
            return gate_result

        my_func(ctx={"user": "dr_smith"})
        payload = mock_post.call_args_list[0][1]["json"]
        assert payload["context"] == {"environment": "prod", "user": "dr_smith"}

    def test_non_dict_context_kwarg_is_ignored(self, mocker):
        # If the caller passed a non-dict value for the context kwarg
        # (bad usage), silently fall back to the static context rather
        # than crashing the request.
        client = AtlaSentClient(api_key="ask_test_xxxxxxxx", max_retries=0)
        mock_post = mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        @atlasent_guard(
            client,
            "read_data",
            actor_id="agent-1",
            context={"environment": "prod"},
            context_kwarg="ctx",
        )
        def my_func(ctx=None, gate_result=None):
            return gate_result

        my_func(ctx="not-a-dict")
        payload = mock_post.call_args_list[0][1]["json"]
        assert payload["context"] == {"environment": "prod"}


class TestAsyncAtlaSentGuard:
    @pytest.mark.asyncio
    async def test_permit_passes_gate_result(self, mocker):
        client = AsyncAtlaSentClient(api_key="ask_test_xxxxxxxx", max_retries=0)
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        @async_atlasent_guard(client, "read_data", actor_id="agent-1")
        async def my_func(gate_result=None):
            return gate_result

        result = await my_func()
        assert isinstance(result, GateResult)
        assert result.verification.valid is True

    @pytest.mark.asyncio
    async def test_deny_raises(self, mocker):
        client = AsyncAtlaSentClient(api_key="ask_test_xxxxxxxx", max_retries=0)
        mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_DENY),
        )

        @async_atlasent_guard(client, "write_data", actor_id="agent-1")
        async def my_func(gate_result=None):
            return gate_result

        with pytest.raises(AtlaSentDenied):
            await my_func()

    @pytest.mark.asyncio
    async def test_dynamic_actor_id(self, mocker):
        client = AsyncAtlaSentClient(api_key="ask_test_xxxxxxxx", max_retries=0)
        mock_post = mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        @async_atlasent_guard(client, "read_data", actor_id_kwarg="agent_id")
        async def my_func(agent_id="default", gate_result=None):
            return gate_result

        await my_func(agent_id="dynamic-agent")
        payload = mock_post.call_args_list[0][1]["json"]
        assert payload["actor_id"] == "dynamic-agent"

    @pytest.mark.asyncio
    async def test_dynamic_context_merges_with_static(self, mocker):
        client = AsyncAtlaSentClient(api_key="ask_test_xxxxxxxx", max_retries=0)
        mock_post = mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        @async_atlasent_guard(
            client,
            "read_data",
            actor_id="agent-1",
            context={"environment": "prod"},
            context_kwarg="ctx",
        )
        async def my_func(ctx=None, gate_result=None):
            return gate_result

        await my_func(ctx={"user": "dr_smith"})
        payload = mock_post.call_args_list[0][1]["json"]
        assert payload["context"] == {"environment": "prod", "user": "dr_smith"}
