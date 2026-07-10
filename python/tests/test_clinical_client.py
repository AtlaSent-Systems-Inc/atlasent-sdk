"""Tests for atlasent.clinical_client — the clinical unblinding gate client."""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from atlasent.clinical import ClinicalBlindRequest
from atlasent.clinical_client import ClinicalTrialsClient
from atlasent.exceptions import AtlaSentError

BASE_URL = "https://api.atlasent.io"
API_KEY = "ask_test_clinical"


def _fake_client() -> MagicMock:
    c = MagicMock()
    c.base_url = BASE_URL
    c.api_key = API_KEY
    return c


def _fake_response(body: Any) -> MagicMock:
    raw = json.dumps(body).encode() if body is not None else b""
    resp = MagicMock()
    resp.read.return_value = raw
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


@contextmanager
def _mock_urlopen(body: Any):
    resp = _fake_response(body)
    with patch(
        "atlasent.clinical_client.urllib_request.urlopen", return_value=resp
    ) as m:
        yield m


TRIAL = {
    "id": "ctb_1",
    "org_id": "org_1",
    "trial_id": "NCT12345678",
    "trial_name": "Phase III",
    "blinding_type": "double_blind",
    "status": "blinded",
    "established_by": "pi",
    "randomization_code_hash": "a" * 64,
    "created_at": "2026-07-10T00:00:00Z",
}


# ── Reads ─────────────────────────────────────────────────────────────────────


def test_list_parses_trials_and_calls_get() -> None:
    client = ClinicalTrialsClient(_fake_client())
    with _mock_urlopen({"trials": [TRIAL]}) as m:
        resp = client.list(status="blinded", limit=10, offset=0)
    assert resp.trials[0].trial_id == "NCT12345678"
    req = m.call_args[0][0]
    assert req.method == "GET"
    assert "/v1/clinical-unblind?" in req.full_url
    assert "status=blinded" in req.full_url
    assert req.headers["Authorization"] == f"Bearer {API_KEY}"


def test_list_without_params_has_no_query() -> None:
    client = ClinicalTrialsClient(_fake_client())
    with _mock_urlopen({"trials": []}) as m:
        resp = client.list()
    assert resp.trials == []
    assert m.call_args[0][0].full_url == f"{BASE_URL}/v1/clinical-unblind"


def test_get_single_trial() -> None:
    client = ClinicalTrialsClient(_fake_client())
    with _mock_urlopen({"trial": TRIAL}) as m:
        resp = client.get("NCT12345678")
    assert resp.trial.status == "blinded"
    assert "trial_id=NCT12345678" in m.call_args[0][0].full_url


def test_history() -> None:
    event = {
        "id": "cue_1",
        "org_id": "org_1",
        "trial_id": "NCT12345678",
        "blind_id": "ctb_1",
        "event_type": "unblinding_executed",
        "actor_id": "pi",
        "reason": "DSMB",
        "unblinding_scope": "full",
        "occurred_at": "2026-07-10T01:00:00Z",
    }
    client = ClinicalTrialsClient(_fake_client())
    with _mock_urlopen({"events": [event]}) as m:
        resp = client.history("NCT12345678")
    assert resp.events[0].event_type == "unblinding_executed"
    assert (
        "/v1/clinical-unblind/history?trial_id=NCT12345678"
        in m.call_args[0][0].full_url
    )


# ── Writes ────────────────────────────────────────────────────────────────────


def test_blind_accepts_model_and_posts_body() -> None:
    client = ClinicalTrialsClient(_fake_client())
    req = ClinicalBlindRequest(
        trial_id="NCT12345678",
        trial_name="Phase III",
        phase="phase_3",
        blinding_type="double_blind",
        randomization_code_hash="b" * 64,
        established_by="pi",
        reason="Trial start",
    )
    with _mock_urlopen({"blind": TRIAL}) as m:
        resp = client.blind(req)
    assert resp.blind.trial_id == "NCT12345678"
    sent = m.call_args[0][0]
    assert sent.method == "POST"
    assert sent.full_url == f"{BASE_URL}/v1/clinical-unblind/blind"
    body = json.loads(sent.data)
    assert body["trial_id"] == "NCT12345678"
    # exclude_none drops unset optional fields (evaluation_id, sponsor_org, …)
    assert "evaluation_id" not in body


def test_request_unblind_accepts_dict() -> None:
    client = ClinicalTrialsClient(_fake_client())
    with _mock_urlopen(
        {"success": True, "trial_id": "NCT12345678", "status": "unblinded"}
    ) as m:
        resp = client.request_unblind(
            {
                "trial_id": "NCT12345678",
                "actor_id": "pi",
                "reason": "DSMB interim analysis",
                "approval_meaning": "I authorize the unblinding of NCT12345678.",
            }
        )
    assert resp.success is True
    assert resp.status == "unblinded"
    assert m.call_args[0][0].full_url.endswith("/unblind")


def test_emergency_unblind() -> None:
    client = ClinicalTrialsClient(_fake_client())
    body = {"success": True, "trial_id": "NCT12345678", "subject_id": "S-7"}
    with _mock_urlopen(body) as m:
        resp = client.emergency_unblind(
            {
                "trial_id": "NCT12345678",
                "actor_id": "dr",
                "subject_id": "S-7",
                "emergency_justification": "SAE",
            }
        )
    assert resp.subject_id == "S-7"
    assert m.call_args[0][0].full_url.endswith("/emergency")


def test_verify_permit_returns_raw_result() -> None:
    client = ClinicalTrialsClient(_fake_client())
    with _mock_urlopen({"valid": True, "outcome": "verified"}) as m:
        result = client.verify_permit(
            trial_id="NCT12345678",
            permit_token="pt.v3.abc",
            action_type="trial.unblinding.execute",
            actor_id="pi",
        )
    assert result == {"valid": True, "outcome": "verified"}
    sent = m.call_args[0][0]
    assert sent.full_url.endswith("/verify-permit")
    assert json.loads(sent.data)["permit_token"] == "pt.v3.abc"


# ── Errors + empty body ───────────────────────────────────────────────────────


def test_request_error_wrapped() -> None:
    client = ClinicalTrialsClient(_fake_client())
    with patch(
        "atlasent.clinical_client.urllib_request.urlopen", side_effect=OSError("boom")
    ):
        with pytest.raises(AtlaSentError, match="Clinical unblinding request failed"):
            client.list()


def test_empty_body_returns_empty_dict() -> None:
    client = ClinicalTrialsClient(_fake_client())
    with _mock_urlopen(None):
        # empty body → {} → verify_permit returns {}
        assert (
            client.verify_permit(
                trial_id="t",
                permit_token="p",
                action_type="trial.unblinding.execute",
                actor_id="a",
            )
            == {}
        )


def test_exported_from_package() -> None:
    import atlasent

    assert atlasent.ClinicalTrialsClient is ClinicalTrialsClient
