"""Additional targeted coverage for atlasent.client."""

from __future__ import annotations

import httpx
import pytest

from atlasent.client import AtlaSentClient, _compute_execution_hash, _server_message
from atlasent.exceptions import AtlaSentError
from atlasent.hitl import HitlCreateRequest


@pytest.fixture
def client() -> AtlaSentClient:
    return AtlaSentClient(api_key="ask_test_cov", max_retries=0)


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


def _hitl_escalation() -> dict[str, object]:
    return {
        "id": "es_1",
        "org_id": "org_1",
        "agent_id": "agent_1",
        "status": "pending",
        "escalation_reason": "reason",
        "created_at": "2026-05-08T00:00:00Z",
        "quorum_required": "single_approver",
        "min_approvers": 1,
        "approver_pool_size": 1,
        "escalation_depth": 0,
        "max_escalation_depth": 2,
        "fallback_decision": "reject",
    }


def test_compute_execution_hash_sorts_nested_dicts_and_lists() -> None:
    p1 = {"z": 1, "nested": [{"b": 2, "a": 1}]}
    p2 = {"nested": [{"a": 1, "b": 2}], "z": 1}
    assert _compute_execution_hash(p1) == _compute_execution_hash(p2)


def test_governance_list_methods_success_and_validation(
    client: AtlaSentClient, mocker
) -> None:
    get_mock = mocker.patch.object(client, "_get")
    get_mock.side_effect = [
        ({"agents": [_governance_agent()]}, None, "req_1"),
        ({"findings": [_governance_finding()]}, None, "req_2"),
        ({"evaluations": [_governance_eval()]}, None, "req_3"),
    ]

    assert client.list_governance_agents().agents[0].slug == "risk"
    assert client.list_governance_findings(change_id="chg_1").findings[0].id == "f_1"
    assert (
        client.list_governance_evaluations(change_id="chg_1").evaluations[0].id
        == "ev_1"
    )


def test_governance_list_methods_error_paths(client: AtlaSentClient, mocker) -> None:
    with pytest.raises(AtlaSentError, match="change_id is required"):
        client.list_governance_findings(change_id="")
    with pytest.raises(AtlaSentError, match="change_id is required"):
        client.list_governance_evaluations(change_id="")

    get_mock = mocker.patch.object(client, "_get")
    get_mock.side_effect = [
        ({"agents": "bad"}, None, "req_a"),
        ({"findings": "bad"}, None, "req_b"),
        ({"evaluations": "bad"}, None, "req_c"),
    ]

    with pytest.raises(AtlaSentError, match="agents"):
        client.list_governance_agents()
    with pytest.raises(AtlaSentError, match="findings"):
        client.list_governance_findings(change_id="chg_1")
    with pytest.raises(AtlaSentError, match="evaluations"):
        client.list_governance_evaluations(change_id="chg_1")


def test_hitl_methods_cover_request_paths_and_bodies(
    client: AtlaSentClient, mocker
) -> None:
    post_mock = mocker.patch.object(client, "_post")
    get_mock = mocker.patch.object(client, "_get")

    post_mock.side_effect = [
        (_hitl_escalation(), None, "r1"),
        (_hitl_escalation(), None, "r2"),
        (_hitl_escalation(), None, "r3"),
        (_hitl_escalation(), None, "r4"),
        (_hitl_escalation(), None, "r5"),
    ]
    get_mock.side_effect = [
        ({"escalations": [_hitl_escalation()], "total": 1}, None, "g1"),
        (_hitl_escalation(), None, "g2"),
        (
            {
                "approvals": [
                    {
                        "id": "a_1",
                        "decision": "approve",
                        "quorum_at_vote": "single_approver",
                        "created_at": "2026-05-08T00:00:00Z",
                    }
                ]
            },
            None,
            "g3",
        ),
        (
            {
                "chain": [
                    {
                        "id": "hop_1",
                        "depth": 1,
                        "created_at": "2026-05-08T00:00:00Z",
                    }
                ]
            },
            None,
            "g4",
        ),
    ]

    req = HitlCreateRequest(agent_id="agent_1", escalation_reason="reason")
    assert client.create_hitl_escalation(req).escalation.id == "es_1"

    result = client.list_hitl_escalations(
        status="pending",
        agent_id="agent_1",
        assigned_to_user_id="u_1",
        limit=10,
        cursor="cur_1",
    )
    assert result.total == 1

    assert client.get_hitl_escalation("es_1").escalation.id == "es_1"
    assert client.list_hitl_approvals("es_1").approvals[0].id == "a_1"
    assert client.get_hitl_chain("es_1").chain[0].id == "hop_1"
    assert client.approve_hitl_escalation("es_1", note="ok").escalation.id == "es_1"
    assert client.reject_hitl_escalation("es_1", note="no").escalation.id == "es_1"
    assert (
        client.escalate_hitl_escalation(
            "es_1", to_role="reviewer", to_user_id="u_2", reason="escalate"
        ).escalation.id
        == "es_1"
    )
    assert client.timeout_hitl_escalation("es_1").escalation.id == "es_1"

    with pytest.raises(AtlaSentError, match="escalation_id is required"):
        client.get_hitl_escalation("")


def test_server_message_helper_parses_expected_shapes(mocker) -> None:
    response = mocker.Mock(spec=httpx.Response)
    response.json.return_value = {"error": "bad"}
    assert _server_message(response) == "bad"

    response.json.return_value = {"message": "oops"}
    assert _server_message(response) == "oops"

    response.json.return_value = {"reason": "why"}
    assert _server_message(response) == "why"

    response.json.return_value = {"reason": ""}
    assert _server_message(response) is None

    response.json.side_effect = ValueError("not json")
    assert _server_message(response) is None
