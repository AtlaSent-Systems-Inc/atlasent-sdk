"""Tests for AtlaSentClient.replay() — ADR-015 Phase C parity runtime."""
from __future__ import annotations

import os
import pytest
from unittest.mock import MagicMock

from atlasent import AtlaSentClient
from atlasent.exceptions import AtlaSentError
from atlasent.models import ReplayResponse


FAKE_KEY = "ask_live_testkey0000000000"


def _make_client() -> AtlaSentClient:
    os.environ["ATLASENT_ALLOW_INSECURE_HTTP"] = "1"
    return AtlaSentClient(api_key=FAKE_KEY, base_url="http://localhost:9999")


def _mock_resp(*, status_code: int = 200, json_data: dict, text: str = ""):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data
    resp.text = text or str(json_data)
    resp.headers = {}
    return resp


class TestReplayNone:
    def test_variance_none(self, mocker):
        client = _make_client()
        resp = _mock_resp(json_data={
            "decision_id": "dec-001",
            "variance": "NONE",
            "original_decision": "allow",
            "accepts_replay": True,
            "replayed_at": "2026-05-24T00:00:00Z",
        })
        mocker.patch.object(client._client, "post", return_value=resp)
        result = client.replay(evaluation_id="dec-001")
        assert result.variance_kind == "NONE"
        assert result.decision_id == "dec-001"
        assert result.original_decision == "allow"
        assert result.accepts_replay is True


class TestReplayPolicyDrift:
    def test_decision_changed_maps_to_policy_drift(self, mocker):
        client = _make_client()
        resp = _mock_resp(json_data={
            "decision_id": "dec-002",
            "variance": "DECISION_CHANGED",
            "original_decision": "allow",
            "replay_decision": "deny",
            "accepts_replay": True,
            "replayed_at": "2026-05-24T00:00:00Z",
        })
        mocker.patch.object(client._client, "post", return_value=resp)
        result = client.replay(evaluation_id="dec-002")
        assert result.variance_kind == "POLICY_DRIFT"
        assert result.replayed_decision == "deny"


class TestReplayEnvelopeDrift:
    def test_envelope_drift_no_replayed_decision(self, mocker):
        client = _make_client()
        resp = _mock_resp(json_data={
            "decision_id": "dec-003",
            "variance": "ENVELOPE_DRIFT",
            "original_decision": "allow",
            "accepts_replay": False,
            "replayed_at": "2026-05-24T00:00:00Z",
        })
        mocker.patch.object(client._client, "post", return_value=resp)
        result = client.replay(evaluation_id="dec-003")
        assert result.variance_kind == "ENVELOPE_DRIFT"
        assert result.replayed_decision is None
        assert result.accepts_replay is False


class TestReplayEngineDrift:
    def test_409_engine_drift_does_not_raise(self, mocker):
        client = _make_client()
        resp = _mock_resp(
            status_code=409,
            json_data={"error": "replay_not_eligible", "message": "engine retired"},
            text="API error 409: engine retired",
        )
        mocker.patch.object(client._client, "post", return_value=resp)
        result = client.replay(evaluation_id="dec-004")
        assert result.variance_kind == "ENGINE_DRIFT"
        assert result.accepts_replay is False
        assert result.decision_id == "dec-004"


class TestReplayBundleMissing:
    def test_409_bundle_missing_does_not_raise(self, mocker):
        client = _make_client()
        resp = _mock_resp(
            status_code=409,
            json_data={"error": "replay_not_eligible", "message": "no bundle recorded"},
            text="API error 409: no bundle recorded",
        )
        mocker.patch.object(client._client, "post", return_value=resp)
        result = client.replay(evaluation_id="dec-005")
        assert result.variance_kind == "BUNDLE_MISSING"
        assert result.accepts_replay is False


class TestReplayPath:
    def test_url_path_correctness(self, mocker):
        client = _make_client()
        resp = _mock_resp(json_data={
            "decision_id": "abc123",
            "variance": "NONE",
            "original_decision": "allow",
            "accepts_replay": True,
            "replayed_at": "2026-05-24T00:00:00Z",
        })
        mock_post = mocker.patch.object(client._client, "post", return_value=resp)
        client.replay(evaluation_id="abc123")
        call_url = mock_post.call_args[0][0]
        assert "/v1/decisions/abc123/replay" in call_url


class TestReplayRateLimit:
    def test_rate_limit_headers_parsed(self, mocker):
        client = _make_client()
        resp = _mock_resp(json_data={
            "decision_id": "dec-rl",
            "variance": "NONE",
            "original_decision": "allow",
            "accepts_replay": True,
            "replayed_at": "2026-05-24T00:00:00Z",
        })
        resp.headers = {
            "x-ratelimit-limit": "100",
            "x-ratelimit-remaining": "42",
            "x-ratelimit-reset": "1748044800",
        }
        mocker.patch.object(client._client, "post", return_value=resp)
        result = client.replay(evaluation_id="dec-rl")
        assert result.rate_limit is not None
        assert result.rate_limit.limit == 100
        assert result.rate_limit.remaining == 42


class TestReplayFallbacks:
    def test_missing_decision_id_falls_back_to_input(self, mocker):
        client = _make_client()
        resp = _mock_resp(json_data={
            # no decision_id in response body
            "variance": "NONE",
            "original_decision": "allow",
            "accepts_replay": True,
            "replayed_at": "2026-05-24T00:00:00Z",
        })
        mocker.patch.object(client._client, "post", return_value=resp)
        result = client.replay(evaluation_id="fallback-id")
        assert result.decision_id == "fallback-id"

    def test_non_409_errors_propagate(self, mocker):
        client = _make_client()
        resp = _mock_resp(status_code=500, json_data={"error": "server_error"})
        mocker.patch.object(client._client, "post", return_value=resp)
        with pytest.raises(AtlaSentError):
            client.replay(evaluation_id="dec-err")
