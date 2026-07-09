"""Tests for atlasent.clinical."""

from __future__ import annotations

import atlasent
from atlasent.clinical import (
    ClinicalBlindRequest,
    ClinicalBlindResponse,
    ClinicalEmergencyRequest,
    ClinicalHistoryResponse,
    ClinicalMutationResponse,
    ClinicalTrialBlind,
    ClinicalTrialGetResponse,
    ClinicalTrialListResponse,
    ClinicalUnblindingEvent,
    ClinicalUnblindRequest,
    is_unblinded,
    latest_unblinding_event,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_blind(status: str = "blinded") -> ClinicalTrialBlind:
    return ClinicalTrialBlind(
        id="ctb_01",
        org_id="org_01",
        trial_id="TRIAL-042",
        trial_name="Phase III efficacy study",
        blinding_type="double_blind",
        status=status,  # type: ignore[arg-type]
        established_by="user_pi",
        randomization_code_hash="a" * 64,
        created_at="2026-07-09T00:00:00Z",
    )


def make_event(
    occurred_at: str, event_type: str = "unblinding_executed"
) -> ClinicalUnblindingEvent:
    return ClinicalUnblindingEvent(
        id=f"cue_{occurred_at}",
        org_id="org_01",
        trial_id="TRIAL-042",
        blind_id="ctb_01",
        event_type=event_type,  # type: ignore[arg-type]
        actor_id="user_pi",
        reason="DSMB interim analysis",
        unblinding_scope="full",
        occurred_at=occurred_at,
    )


# ---------------------------------------------------------------------------
# Model round-trips
# ---------------------------------------------------------------------------


def test_trial_blind_defaults_and_extra() -> None:
    blind = make_blind()
    assert blind.status == "blinded"
    assert blind.protocol_number is None
    assert blind.unblinded_at is None
    # extra keys are preserved (forward-compat with additive server fields)
    parsed = ClinicalTrialBlind.model_validate(
        {**blind.model_dump(), "future_field": "ok"}
    )
    assert parsed.model_dump()["future_field"] == "ok"


def test_blind_request_and_response() -> None:
    req = ClinicalBlindRequest(
        trial_id="TRIAL-042",
        trial_name="Phase III efficacy study",
        phase="phase_3",
        blinding_type="double_blind",
        randomization_code_hash="b" * 64,
        established_by="user_pi",
        reason="Trial start",
    )
    assert req.approval_meaning is None
    resp = ClinicalBlindResponse(blind=make_blind())
    assert resp.blind.trial_id == "TRIAL-042"


def test_unblind_request_requires_meaning() -> None:
    req = ClinicalUnblindRequest(
        trial_id="TRIAL-042",
        actor_id="user_pi",
        reason="DSMB recommends unblinding",
        approval_meaning="I authorize the unblinding of trial TRIAL-042 per DSMB.",
        unblinding_scope="full",
        dsmb_authorization_ref="DSMB-2026-07",
    )
    assert req.approval_meaning.startswith("I authorize")


def test_emergency_request() -> None:
    req = ClinicalEmergencyRequest(
        trial_id="TRIAL-042",
        actor_id="dr_smith",
        subject_id="SUBJ-0007",
        emergency_justification="SAE requiring immediate knowledge of assignment.",
    )
    assert req.subject_id == "SUBJ-0007"


def test_mutation_and_container_responses() -> None:
    mut = ClinicalMutationResponse(
        success=True, trial_id="TRIAL-042", status="unblinded"
    )
    assert mut.success is True
    assert ClinicalTrialListResponse(trials=[make_blind()]).trials[0].id == "ctb_01"
    assert ClinicalTrialGetResponse(trial=make_blind()).trial.id == "ctb_01"
    hist = ClinicalHistoryResponse(events=[make_event("2026-07-09T01:00:00Z")])
    assert hist.events[0].event_type == "unblinding_executed"
    assert hist.events[0].emergency is False


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_is_unblinded() -> None:
    assert is_unblinded("unblinded") is True
    assert is_unblinded("emergency_unblinded") is True
    assert is_unblinded("blinded") is False
    assert is_unblinded("unblinding_in_progress") is False
    assert is_unblinded("suspended") is False


def test_latest_unblinding_event() -> None:
    assert latest_unblinding_event([]) is None
    events = [
        make_event("2026-07-09T01:00:00Z", "unblinding_initiated"),
        make_event("2026-07-09T03:00:00Z", "unblinding_executed"),
        make_event("2026-07-09T02:00:00Z", "blind_established"),
    ]
    latest = latest_unblinding_event(events)
    assert latest is not None
    assert latest.occurred_at == "2026-07-09T03:00:00Z"


# ---------------------------------------------------------------------------
# Package-level lazy export surface
# ---------------------------------------------------------------------------


def test_lazy_exports_available() -> None:
    for name in (
        "ClinicalTrialBlind",
        "ClinicalUnblindingEvent",
        "ClinicalBlindRequest",
        "ClinicalUnblindRequest",
        "ClinicalEmergencyRequest",
        "is_unblinded",
        "latest_unblinding_event",
    ):
        assert hasattr(atlasent, name), name
    assert atlasent.is_unblinded("unblinded") is True
