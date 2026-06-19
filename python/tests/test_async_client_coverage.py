"""Additional targeted coverage for atlasent.async_client.

Mirrors the sync coverage in test_client_additional_coverage.py /
test_client_replay.py against the async surface. Exercises governance
list methods, async replay (200 + 409 paths), the _do_scim helper's
error / JSON branches, the SSE parser's terminal branches, and a few
evaluate / preflight edge cases that were previously unhit.
"""

from __future__ import annotations

import httpx
import pytest

from atlasent.async_client import AsyncAtlaSentClient, _parse_sse
from atlasent.exceptions import AtlaSentDenied, AtlaSentError
from atlasent.models import (
    EvaluatePreflightResult,
    EvaluateResult,
    ReplayResponse,
    StreamDecisionEvent,
    StreamProgressEvent,
)


@pytest.fixture
def async_client() -> AsyncAtlaSentClient:
    return AsyncAtlaSentClient(api_key="ask_test_cov", max_retries=0)


def _mock_resp(mocker, status_code=200, json_data=None, headers=None, text=""):
    resp = mocker.Mock(spec=httpx.Response)
    resp.status_code = status_code
    resp.headers = headers or {}
    resp.text = text
    if json_data is not None:
        resp.json.return_value = json_data
    else:
        resp.json.side_effect = ValueError("no json")
    return resp


def _governance_agent() -> dict[str, object]:
    return {
        "slug": "risk",
        "version": "1.0.0",
        "name": "Risk Agent",
        "description": "desc",
        "applicable_subject_kinds": ["change"],
        "authority_class": "advisory",
        "can_authorize": False,
        "capabilities": ["check"],
        "is_active": True,
        "created_at": "2026-05-08T00:00:00Z",
    }


def _governance_finding() -> dict[str, object]:
    return {
        "id": "f_1",
        "org_id": "org_1",
        "evaluation_id": "ev_1",
        "change_id": "chg_1",
        "agent_slug": "risk",
        "agent_version": "1.0.0",
        "finding_type": "policy",
        "severity": "high",
        "summary": "summary",
        "can_authorize": False,
        "created_at": "2026-05-08T00:00:00Z",
    }


def _governance_eval() -> dict[str, object]:
    return {
        "id": "ev_1",
        "org_id": "org_1",
        "change_id": "chg_1",
        "agent_slug": "risk",
        "agent_version": "1.0.0",
        "input_hash": "hash",
        "status": "completed",
        "findings_count": 1,
        "invoked_by_kind": "system",
        "started_at": "2026-05-08T00:00:00Z",
    }


# ── Governance list methods ────────────────────────────────────────────


class TestAsyncGovernance:
    @pytest.mark.asyncio
    async def test_list_methods_success(self, async_client, mocker):
        get_mock = mocker.patch.object(async_client, "_get")
        get_mock.side_effect = [
            ({"agents": [_governance_agent()]}, None, "req_1"),
            ({"findings": [_governance_finding()]}, None, "req_2"),
            ({"evaluations": [_governance_eval()]}, None, "req_3"),
        ]

        agents = await async_client.list_governance_agents()
        assert agents.agents[0].slug == "risk"

        findings = await async_client.list_governance_findings(change_id="chg_1")
        assert findings.findings[0].id == "f_1"

        evals = await async_client.list_governance_evaluations(change_id="chg_1")
        assert evals.evaluations[0].id == "ev_1"

    @pytest.mark.asyncio
    async def test_findings_with_agent_slug_filter(self, async_client, mocker):
        get_mock = mocker.patch.object(async_client, "_get")
        get_mock.return_value = ({"findings": []}, None, "req")
        await async_client.list_governance_findings(
            change_id="chg_1", agent_slug="risk"
        )
        _, kwargs = get_mock.call_args
        assert kwargs["params"] == {"change_id": "chg_1", "agent_slug": "risk"}

    @pytest.mark.asyncio
    async def test_evaluations_with_agent_slug_filter(self, async_client, mocker):
        get_mock = mocker.patch.object(async_client, "_get")
        get_mock.return_value = ({"evaluations": []}, None, "req")
        await async_client.list_governance_evaluations(
            change_id="chg_1", agent_slug="risk"
        )
        _, kwargs = get_mock.call_args
        assert kwargs["params"] == {"change_id": "chg_1", "agent_slug": "risk"}

    @pytest.mark.asyncio
    async def test_change_id_required(self, async_client):
        with pytest.raises(AtlaSentError, match="change_id is required"):
            await async_client.list_governance_findings(change_id="")
        with pytest.raises(AtlaSentError, match="change_id is required"):
            await async_client.list_governance_evaluations(change_id="")

    @pytest.mark.asyncio
    async def test_malformed_responses(self, async_client, mocker):
        get_mock = mocker.patch.object(async_client, "_get")
        get_mock.side_effect = [
            ({"agents": "bad"}, None, "req_a"),
            ({"findings": "bad"}, None, "req_b"),
            ({"evaluations": "bad"}, None, "req_c"),
        ]
        with pytest.raises(AtlaSentError, match="agents"):
            await async_client.list_governance_agents()
        with pytest.raises(AtlaSentError, match="findings"):
            await async_client.list_governance_findings(change_id="chg_1")
        with pytest.raises(AtlaSentError, match="evaluations"):
            await async_client.list_governance_evaluations(change_id="chg_1")


# ── Async replay ───────────────────────────────────────────────────────


class TestAsyncReplay:
    @pytest.mark.asyncio
    async def test_variance_none(self, async_client, mocker):
        wire = {
            "decision_id": "dec_abc",
            "original_decision": "allow",
            "replay_decision": "allow",
            "engine_version": "wire-v1@1.0.0",
            "engine_version_kind": "active",
            "accepts_replay": True,
            "variance": "NONE",
            "envelope_verification": "verified",
            "replayed_at": "2026-05-24T00:00:00Z",
        }
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=wire),
        )
        result = await async_client.replay(evaluation_id="dec_abc")
        assert isinstance(result, ReplayResponse)
        assert result.variance_kind == "NONE"
        assert result.replayed_decision == "allow"

    @pytest.mark.asyncio
    async def test_decision_changed_normalizes_to_policy_drift(
        self, async_client, mocker
    ):
        wire = {
            "decision_id": "dec_abc",
            "original_decision": "allow",
            "replay_decision": "deny",
            "replay_deny_code": "policy.expired",
            "accepts_replay": True,
            "variance": "DECISION_CHANGED",
            "replayed_at": "2026-05-24T00:00:00Z",
        }
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=wire),
        )
        result = await async_client.replay(evaluation_id="dec_abc")
        assert result.variance_kind == "POLICY_DRIFT"
        assert result.replayed_decision == "deny"
        assert result.replayed_deny_code == "policy.expired"

    @pytest.mark.asyncio
    async def test_unknown_wire_variance_defaults_to_none(self, async_client, mocker):
        wire = {
            "decision_id": "dec_abc",
            "original_decision": "allow",
            "accepts_replay": True,
            "variance": "SOMETHING_NEW",
            "replayed_at": "2026-05-24T00:00:00Z",
        }
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=wire),
        )
        result = await async_client.replay(evaluation_id="dec_abc")
        assert result.variance_kind == "NONE"

    @pytest.mark.asyncio
    async def test_409_engine_drift(self, async_client, mocker):
        body = (
            '{"error":"replay_not_eligible",'
            '"message":"Engine version wire-v0@0.9.0 does not accept replay"}'
        )
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, status_code=409, text=body),
        )
        result = await async_client.replay(evaluation_id="dec_abc")
        assert result.variance_kind == "ENGINE_DRIFT"
        assert result.accepts_replay is False
        assert result.original_decision == "deny"

    @pytest.mark.asyncio
    async def test_409_bundle_missing(self, async_client, mocker):
        body = (
            '{"error":"replay_not_eligible",'
            '"message":"No policy bundle recorded for this decision"}'
        )
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, status_code=409, text=body),
        )
        result = await async_client.replay(evaluation_id="dec_abc")
        assert result.variance_kind == "BUNDLE_MISSING"

    @pytest.mark.asyncio
    async def test_500_propagates(self, async_client, mocker):
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, status_code=500, text="boom"),
        )
        with pytest.raises(AtlaSentError) as exc:
            await async_client.replay(evaluation_id="dec_abc")
        assert exc.value.status_code == 500

    @pytest.mark.asyncio
    async def test_url_encodes_evaluation_id(self, async_client, mocker):
        wire = {
            "decision_id": "odd:id",
            "original_decision": "allow",
            "variance": "NONE",
            "accepts_replay": True,
            "replayed_at": "2026-05-24T00:00:00Z",
        }
        post = mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=wire),
        )
        await async_client.replay(evaluation_id="odd:id")
        url = post.call_args[0][0]
        assert "/v1/decisions/odd%3Aid/replay" in url


# ── evaluate / preflight edge cases ────────────────────────────────────


class TestAsyncEvaluateEdges:
    @pytest.mark.asyncio
    async def test_approval_dict_is_coerced(self, async_client, mocker):
        wire = {
            "permitted": True,
            "decision_id": "dec_100",
            "reason": "OK",
            "audit_hash": "h",
            "timestamp": "2025-01-15T12:00:00Z",
        }
        post = mocker.patch.object(async_client, "_post")
        post.return_value = (wire, None, "req")
        result = await async_client.evaluate(
            "production.deploy",
            "agent-1",
            {"environment": "production"},
            approval={"approval_id": "appr_1"},
        )
        assert isinstance(result, EvaluateResult)

    @pytest.mark.asyncio
    async def test_allow_without_permit_token_is_bad_response(
        self, async_client, mocker
    ):
        wire = {"decision": "allow", "reason": "OK"}
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=wire),
        )
        with pytest.raises(AtlaSentError, match="no permit_token"):
            await async_client.evaluate("read_data", "agent-1")

    @pytest.mark.asyncio
    async def test_preflight_legacy_permitted_false_is_deny(self, async_client, mocker):
        wire = {
            "permitted": False,
            "decision_id": "dec_200",
            "reason": "nope",
            "audit_hash": "h",
            "timestamp": "2025-01-15T12:00:00Z",
        }
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=wire),
        )
        result = await async_client.evaluate_preflight("read_data", "agent-1")
        assert isinstance(result, EvaluatePreflightResult)
        assert result.evaluation.decision == "deny"

    @pytest.mark.asyncio
    async def test_preflight_invalid_decision_is_bad_response(
        self, async_client, mocker
    ):
        wire = {"decision": "maybe"}
        mocker.patch.object(
            async_client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=wire),
        )
        with pytest.raises(AtlaSentError, match="decision"):
            await async_client.evaluate_preflight("read_data", "agent-1")

    @pytest.mark.asyncio
    async def test_protect_propagates_deny_at_evaluate(self, async_client, mocker):
        post = mocker.patch.object(async_client, "_post")
        post.side_effect = AtlaSentDenied(
            decision="deny",
            permit_token="dec_x",
            reason="blocked",
            deny_code="POLICY",
            request_id="req",
            response_body={"audit_hash": "ah"},
        )
        from atlasent.exceptions import AtlaSentDeniedError

        with pytest.raises(AtlaSentDeniedError) as exc:
            await async_client.protect(
                agent="a", action="production.deploy", context={"environment": "prod"}
            )
        assert exc.value.audit_hash == "ah"


# ── _do_scim helper branches ───────────────────────────────────────────


class TestAsyncDoScim:
    @pytest.mark.asyncio
    async def test_204_returns_none(self, async_client, mocker):
        request_mock = mocker.AsyncMock(
            return_value=_mock_resp(mocker, status_code=204)
        )
        mocker.patch.object(async_client._client, "request", request_mock)
        result = await async_client.async_scim_delete_user("org_1", "u_1")
        assert result is None

    @pytest.mark.asyncio
    async def test_get_returns_json(self, async_client, mocker):
        request_mock = mocker.AsyncMock(
            return_value=_mock_resp(mocker, json_data={"id": "u_1"})
        )
        mocker.patch.object(async_client._client, "request", request_mock)
        result = await async_client.async_scim_get_user("org_1", "u_1")
        assert result == {"id": "u_1"}

    @pytest.mark.asyncio
    async def test_error_status_uses_server_message(self, async_client, mocker):
        resp = _mock_resp(
            mocker, status_code=400, json_data={"error": "bad scim filter"}
        )
        request_mock = mocker.AsyncMock(return_value=resp)
        mocker.patch.object(async_client._client, "request", request_mock)
        with pytest.raises(AtlaSentError, match="bad scim filter") as exc:
            await async_client.async_scim_list_users("org_1")
        assert exc.value.code == "bad_request"

    @pytest.mark.asyncio
    async def test_500_maps_to_server_error(self, async_client, mocker):
        resp = _mock_resp(mocker, status_code=503)
        resp.json.side_effect = ValueError("no json")
        request_mock = mocker.AsyncMock(return_value=resp)
        mocker.patch.object(async_client._client, "request", request_mock)
        with pytest.raises(AtlaSentError) as exc:
            await async_client.async_scim_get_group("org_1", "g_1")
        assert exc.value.code == "server_error"

    @pytest.mark.asyncio
    async def test_200_with_malformed_json_raises_bad_response(
        self, async_client, mocker
    ):
        resp = _mock_resp(mocker, status_code=200)
        resp.json.side_effect = ValueError("boom")
        request_mock = mocker.AsyncMock(return_value=resp)
        mocker.patch.object(async_client._client, "request", request_mock)
        with pytest.raises(AtlaSentError, match="malformed JSON") as exc:
            await async_client.async_get_siem_config("org_1")
        assert exc.value.code == "bad_response"

    @pytest.mark.asyncio
    async def test_post_body_serialized(self, async_client, mocker):
        request_mock = mocker.AsyncMock(
            return_value=_mock_resp(mocker, json_data={"id": "u_2"})
        )
        mocker.patch.object(async_client._client, "request", request_mock)
        await async_client.async_scim_create_user("org_1", {"userName": "joe"})
        _, kwargs = request_mock.call_args
        assert b"schemas" in kwargs["content"]
        assert kwargs["headers"]["Content-Type"] == "application/json"


# ── SIEM / evidence-export validation paths ────────────────────────────


class TestAsyncSiemEvidenceValidation:
    @pytest.mark.asyncio
    async def test_siem_rejects_non_https(self, async_client):
        with pytest.raises(ValueError, match="HTTPS"):
            await async_client.async_upsert_siem_config(
                "org_1", destination_url="http://x"
            )

    @pytest.mark.asyncio
    async def test_siem_rejects_bad_format(self, async_client):
        with pytest.raises(ValueError, match="format"):
            await async_client.async_upsert_siem_config(
                "org_1", destination_url="https://x", format="bogus"
            )

    @pytest.mark.asyncio
    async def test_siem_rejects_bad_batch_size(self, async_client):
        with pytest.raises(ValueError, match="batch_size"):
            await async_client.async_upsert_siem_config(
                "org_1", destination_url="https://x", batch_size=0
            )

    @pytest.mark.asyncio
    async def test_evidence_rejects_bad_regime_on_list(self, async_client):
        with pytest.raises(ValueError, match="regime"):
            await async_client.async_list_evidence_exports("org_1", regime="bogus")

    @pytest.mark.asyncio
    async def test_evidence_rejects_bad_regime_on_create(self, async_client):
        with pytest.raises(ValueError, match="regime"):
            await async_client.async_create_evidence_export("org_1", regime="bogus")


# ── SSE parser terminal branches ───────────────────────────────────────


async def _aiter(lines):
    for ln in lines:
        yield ln


class TestParseSseTerminalBranches:
    @pytest.mark.asyncio
    async def test_partial_data_without_done_raises_parse_error(self):
        from atlasent.exceptions import StreamParseError

        lines = ['data: {"type":"progress"']  # no blank line / no terminator
        with pytest.raises(StreamParseError):
            async for _ in _parse_sse(_aiter(lines), "req"):
                pass

    @pytest.mark.asyncio
    async def test_error_event_raises(self):
        lines = [
            "event: error",
            'data: {"message":"boom","code":"server_error"}',
            "",
        ]
        with pytest.raises(AtlaSentError, match="boom"):
            async for _ in _parse_sse(_aiter(lines), "req"):
                pass

    @pytest.mark.asyncio
    async def test_progress_then_final_decision(self):
        events = []
        lines = [
            "event: progress",
            'data: {"stage":"evaluating"}',
            "",
            "event: decision",
            'data: {"decision":"allow","is_final":true}',
            "",
        ]
        async for ev in _parse_sse(_aiter(lines), "req"):
            events.append(ev)
        assert isinstance(events[0], StreamProgressEvent)
        assert isinstance(events[1], StreamDecisionEvent)

    @pytest.mark.asyncio
    async def test_progress_done_true_terminates(self):
        events = []
        lines = [
            "event: progress",
            'data: {"stage":"done","done":true}',
            "",
            "event: progress",
            'data: {"stage":"after"}',
            "",
        ]
        async for ev in _parse_sse(_aiter(lines), "req"):
            events.append(ev)
        # done:true on the first progress event stops iteration.
        assert len(events) == 1

    @pytest.mark.asyncio
    async def test_id_field_invokes_callback(self):
        seen = []
        lines = [
            "id: evt-42",
            "event: decision",
            'data: {"decision":"allow","is_final":true}',
            "",
        ]
        async for _ in _parse_sse(_aiter(lines), "req", on_event_id=seen.append):
            pass
        assert seen == ["evt-42"]
