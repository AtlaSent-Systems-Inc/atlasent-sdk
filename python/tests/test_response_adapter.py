"""Tests for the response-shape adapter.

Verifies the adapter's job: turn both the legacy-server shape
(``{decision: "allow", permit_token, audit_entry_hash, valid}``) and
the realigned-server shape (``{permitted, decision_id, audit_hash,
verified}``) into the SDK-canonical form, without mutating canonical
inputs.
"""

from __future__ import annotations

from atlasent._response_adapter import (
    normalize_evaluate_response,
    normalize_verify_response,
)


# ── evaluate ──────────────────────────────────────────────────────────


class TestNormalizeEvaluateResponse:
    def test_canonical_shape_is_preserved(self):
        src = {
            "permitted": True,
            "decision_id": "dec_1",
            "reason": "ok",
            "audit_hash": "h",
            "timestamp": "2026-04-18T00:00:00Z",
        }
        out = normalize_evaluate_response(src)
        assert out["permitted"] is True
        assert out["decision_id"] == "dec_1"
        assert out["audit_hash"] == "h"
        assert out["timestamp"] == "2026-04-18T00:00:00Z"

    def test_legacy_allow_is_derived_from_decision_string(self):
        src = {
            "decision": "allow",
            "permit_token": "pmt_xyz",
            "audit_entry_hash": "h_entry",
            "request_id": "req_1",
        }
        out = normalize_evaluate_response(src)
        assert out["permitted"] is True
        assert out["decision_id"] == "pmt_xyz"
        assert out["audit_hash"] == "h_entry"
        assert isinstance(out["timestamp"], str) and out["timestamp"].endswith("Z")

    def test_legacy_deny_is_derived_from_decision_string(self):
        src = {
            "decision": "deny",
            "deny_reason": "Missing required context",
            "request_id": "req_2",
        }
        out = normalize_evaluate_response(src)
        assert out["permitted"] is False
        # No permit_token → decision_id falls back to request_id.
        assert out["decision_id"] == "req_2"
        assert out["reason"] == "Missing required context"

    def test_legacy_hold_is_not_permitted(self):
        # Only "allow" is permitted; "hold" and "escalate" are not.
        assert normalize_evaluate_response({"decision": "hold"})["permitted"] is False
        assert (
            normalize_evaluate_response({"decision": "escalate"})["permitted"] is False
        )

    def test_mixed_shape_canonical_wins(self):
        # During the rollout the realigned server emits both. Canonical
        # keys must not be overwritten by derived ones.
        src = {
            "permitted": True,
            "decision_id": "dec_canon",
            "decision": "allow",
            "permit_token": "pmt_raw",
            "audit_hash": "h_canon",
            "audit_entry_hash": "h_raw",
        }
        out = normalize_evaluate_response(src)
        assert out["decision_id"] == "dec_canon"
        assert out["audit_hash"] == "h_canon"

    def test_non_dict_is_passed_through(self):
        assert normalize_evaluate_response("nope") == "nope"  # type: ignore[comparison-overlap]
        assert normalize_evaluate_response(None) is None

    def test_empty_dict_gets_timestamp_but_no_permitted(self):
        # An empty body is still malformed — the adapter won't invent
        # permitted/decision_id out of nothing. Callers detect and raise.
        out = normalize_evaluate_response({})
        assert "permitted" not in out
        assert "decision_id" not in out
        assert isinstance(out["timestamp"], str)


# ── verify ────────────────────────────────────────────────────────────


class TestNormalizeVerifyResponse:
    def test_canonical_shape_is_preserved(self):
        src = {
            "verified": True,
            "outcome": "verified",
            "permit_hash": "h_permit",
            "timestamp": "2026-04-18T00:00:00Z",
        }
        out = normalize_verify_response(src)
        assert out["verified"] is True
        assert out["permit_hash"] == "h_permit"
        assert out["timestamp"] == "2026-04-18T00:00:00Z"

    def test_legacy_valid_true_is_derived(self):
        src = {"valid": True, "outcome": "allow", "decision": "allow"}
        out = normalize_verify_response(src)
        assert out["verified"] is True
        # Permit hash not known from legacy shape → empty string.
        assert out["permit_hash"] == ""

    def test_legacy_valid_false_is_derived(self):
        src = {"valid": False, "outcome": "deny", "reason": "expired"}
        out = normalize_verify_response(src)
        assert out["verified"] is False

    def test_mixed_shape_canonical_wins(self):
        src = {
            "verified": True,
            "valid": False,  # contradictory — canonical must win
            "permit_hash": "h_canon",
        }
        out = normalize_verify_response(src)
        assert out["verified"] is True
        assert out["permit_hash"] == "h_canon"

    def test_non_dict_is_passed_through(self):
        assert normalize_verify_response(None) is None
        assert normalize_verify_response(42) == 42  # type: ignore[comparison-overlap]
