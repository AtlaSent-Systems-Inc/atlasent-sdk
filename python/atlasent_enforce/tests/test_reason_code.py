"""Lock the ReasonCode + PermitOutcomeReasonCode unions against drift.

Mirrors typescript/packages/enforce/test/reason-code.test.ts so the
two SDKs cannot diverge silently.
"""

from __future__ import annotations

from typing import get_args

from atlasent_enforce import PermitOutcomeReasonCode, ReasonCode


# ── Runtime assertions on the Literal members ─────────────────────────


def test_reason_code_includes_revoked_and_not_found() -> None:
    members = set(get_args(ReasonCode))
    assert "permit_revoked" in members
    assert "permit_not_found" in members


def test_permit_outcome_reason_code_is_exactly_four_v1_sdk_outcomes() -> None:
    members = set(get_args(PermitOutcomeReasonCode))
    assert members == {
        "permit_expired",
        "permit_consumed",
        "permit_revoked",
        "permit_not_found",
    }


def test_permit_outcome_reason_code_is_subset_of_reason_code() -> None:
    permit_outcomes = set(get_args(PermitOutcomeReasonCode))
    reason_codes = set(get_args(ReasonCode))
    assert permit_outcomes.issubset(reason_codes), (
        "PermitOutcomeReasonCode must be a strict subset of ReasonCode; "
        f"missing in ReasonCode: {permit_outcomes - reason_codes}"
    )


def test_full_reason_code_membership_locked_against_drift() -> None:
    # Locks the full set so adding without updating the contract spec
    # breaks CI. Update both this assertion and contract/ENFORCE_PACK.md
    # in lockstep.
    assert set(get_args(ReasonCode)) == {
        "evaluate_client_error",
        "evaluate_unavailable",
        "verify_client_error",
        "verify_unavailable",
        "verify_latency_breach",
        "binding_mismatch",
        "permit_expired",
        "permit_consumed",
        "permit_revoked",
        "permit_not_found",
        "permit_tampered",
    }
