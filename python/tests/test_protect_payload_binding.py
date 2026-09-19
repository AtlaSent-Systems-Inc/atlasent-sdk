"""What protect() / with_permit() actually put on the wire for the binding.

``test_payload_hash_parity.py`` proves the digest FUNCTION agrees with the
server's. That is necessary and was never sufficient — two separate defects
lived above it, both invisible to a function-level test:

1. The digest was presented as BARE hex against a ``sha256:``-prefixed bound
   value. Deterministic ``PAYLOAD_MISMATCH``, every call.
2. The hashed payload was a hand-written three-key literal
   (``action_type`` / ``actor_id`` / ``context``) while the POSTED body also
   carried ``state_snapshot`` when the caller passed one. The server hashes the
   whole body, so ``protect(state_snapshot=...)`` could never match either —
   a second, independent guaranteed mismatch, and one the prefix fix alone
   would not have touched.

So these tests assert the posted BODY and the presented value, never the
arguments to a helper. Defect 2 in particular is only visible by comparing the
hashed payload against what the transport really saw.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import httpx
import pytest

from atlasent import AtlaSentClient
from atlasent.payload_hash import canonicalize_payload

EVALUATE_PERMIT = {
    "permitted": True,
    "decision_id": "dec_bind",
    "reason": "policy authorized",
    "audit_hash": "hash_bind",
    "timestamp": "2026-09-19T10:00:00Z",
}

VERIFY_OK = {
    "verified": True,
    "outcome": "verified",
    "permit_hash": "permit_bind",
    "timestamp": "2026-09-19T10:00:01Z",
}


def _mock_resp(mocker, json_data):
    resp = mocker.Mock(spec=httpx.Response)
    resp.status_code = 200
    resp.headers = {}
    resp.text = ""
    resp.json.return_value = json_data
    return resp


def _posted_bodies(post_mock) -> list[dict[str, Any]]:
    """Every JSON body the transport was handed, in call order.

    Round-tripped through ``json`` so a value that would not survive
    serialization is seen here exactly as the server would see it.
    """
    bodies = []
    for call in post_mock.call_args_list:
        payload = call.kwargs.get("json")
        bodies.append(json.loads(json.dumps(payload)) if payload is not None else {})
    return bodies


def _server_bound_hash_of(evaluate_body: dict[str, Any]) -> str:
    """The server's binding, recomputed from the body THIS TEST saw posted.

    Deliberately derived from the captured body rather than rebuilt
    independently: that is what makes this catch a field reaching the wire
    without reaching the hash. Mirrors ``v1-evaluate`` — strip
    ``traceparent`` / ``shadow`` / ``explain``, then hash with the scheme
    prefix.
    """
    core = {
        k: v
        for k, v in evaluate_body.items()
        if k not in ("traceparent", "shadow", "explain")
    }
    digest = hashlib.sha256(canonicalize_payload(core).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _protect(mocker, **kwargs):
    client = AtlaSentClient(api_key="ask_test_xxxxxxxx", max_retries=0)
    post = mocker.patch.object(
        client._client,
        "post",
        side_effect=[
            _mock_resp(mocker, EVALUATE_PERMIT),
            _mock_resp(mocker, VERIFY_OK),
        ],
    )
    client.protect(
        agent="agent-7",
        action="tools.write_file",
        context={"environment": "production", "input": {"path": "/tmp/x"}},
        **kwargs,
    )
    return _posted_bodies(post)


class TestProtectPresentsTheBoundForm:
    def test_presented_digest_matches_the_hash_the_server_bound(self, mocker) -> None:
        # THE regression test for defect 1.
        evaluate_body, verify_body = _protect(mocker)
        assert verify_body["execution_hash"] == _server_bound_hash_of(evaluate_body)

    def test_presented_digest_is_prefixed_not_bare_hex(self, mocker) -> None:
        _, verify_body = _protect(mocker)
        presented = verify_body["execution_hash"]
        assert isinstance(presented, str)
        assert presented.startswith("sha256:")
        assert len(presented) == len("sha256:") + 64


class TestProtectHashesTheBodyItActuallyPosted:
    def test_matches_when_state_snapshot_is_passed(self, mocker) -> None:
        # THE regression test for defect 2. The old three-key literal omitted
        # state_snapshot, so this call could never verify even with the prefix
        # correct. Passing a snapshot must not change the answer.
        evaluate_body, verify_body = _protect(
            mocker,
            state_snapshot={
                "source": "terraform",
                "source_kind": "trusted",
                "complete": True,
                "payload": {"replicas": 3},
            },
        )
        assert "state_snapshot" in evaluate_body, (
            "precondition: the snapshot must reach the wire, or this test "
            "proves nothing"
        )
        assert verify_body["execution_hash"] == _server_bound_hash_of(evaluate_body)

    def test_matches_when_state_snapshot_is_omitted(self, mocker) -> None:
        evaluate_body, verify_body = _protect(mocker)
        assert "state_snapshot" not in evaluate_body
        assert verify_body["execution_hash"] == _server_bound_hash_of(evaluate_body)

    def test_the_snapshot_changes_the_presented_digest(self, mocker) -> None:
        # If it did not, the hash would not be covering the snapshot at all and
        # the two tests above could pass for the wrong reason.
        _, without = _protect(mocker)
        _, with_snapshot = _protect(
            mocker, state_snapshot={"source": "terraform", "payload": {"replicas": 3}}
        )
        assert without["execution_hash"] != with_snapshot["execution_hash"]


class TestPresentedDigestDependsOnTheRequest:
    @pytest.mark.parametrize(
        "context",
        [
            {"environment": "production", "input": {"path": "/tmp/a"}},
            {"environment": "production", "input": {"path": "/tmp/b"}},
        ],
    )
    def test_context_is_covered(self, mocker, context: dict[str, Any]) -> None:
        client = AtlaSentClient(api_key="ask_test_xxxxxxxx", max_retries=0)
        post = mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, EVALUATE_PERMIT),
                _mock_resp(mocker, VERIFY_OK),
            ],
        )
        client.protect(agent="a", action="tools.write_file", context=context)
        evaluate_body, verify_body = _posted_bodies(post)
        assert verify_body["execution_hash"] == _server_bound_hash_of(evaluate_body)

    def test_two_different_contexts_produce_two_different_digests(
        self, mocker
    ) -> None:
        # A constant binding would satisfy every assertion above while
        # authorizing any payload.
        _, a = _protect(mocker)

        client = AtlaSentClient(api_key="ask_test_xxxxxxxx", max_retries=0)
        post = mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, EVALUATE_PERMIT),
                _mock_resp(mocker, VERIFY_OK),
            ],
        )
        client.protect(
            agent="agent-7",
            action="tools.write_file",
            context={"environment": "production", "input": {"path": "/tmp/OTHER"}},
        )
        _, b = _posted_bodies(post)

        assert a["execution_hash"] != b["execution_hash"]
