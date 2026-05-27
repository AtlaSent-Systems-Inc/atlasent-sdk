"""Tests for atlasent.replay — offline evidence bundle verification."""

from __future__ import annotations

import hashlib

import pytest

from atlasent.replay import (
    EvidenceVerificationResult,
    _compute_root_hash,
    verify_evidence_bundle,
)

# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_bundle(**overrides):
    """Return a minimal valid evidence bundle, optionally with overrides."""
    bundle = {
        "bundle_id": "bnd_test123",
        "org_id": "org_abc",
        "status": "ready",
        "permits": [
            {"permit_id": "prm_001", "evaluation_id": "eval_001"},
        ],
    }
    bundle.update(overrides)
    return bundle


def _bundle_with_hash_chain(permits=None):
    """Return a bundle with a hash_chain whose root_hash is correct."""
    if permits is None:
        permits = [{"permit_id": "prm_001", "evaluation_id": "eval_001"}]
    root = _compute_root_hash(permits)
    return {
        "bundle_id": "bnd_hashed",
        "org_id": "org_abc",
        "status": "ready",
        "permits": permits,
        "hash_chain": {"root_hash": root, "entry_count": len(permits)},
    }


# ── Basic validation ──────────────────────────────────────────────────────────


class TestVerifyEvidenceBundle:
    def test_valid_bundle_returns_valid_true(self):
        result = verify_evidence_bundle(_make_bundle())
        assert result.valid is True
        assert result.permit_id == "prm_001"
        assert result.bundle_id == "bnd_test123"
        assert result.reason is None

    def test_returns_evidence_verification_result(self):
        result = verify_evidence_bundle(_make_bundle())
        assert isinstance(result, EvidenceVerificationResult)

    def test_non_dict_raises_type_error(self):
        with pytest.raises(TypeError, match="bundle must be a dict"):
            verify_evidence_bundle("not-a-dict")  # type: ignore[arg-type]

    def test_non_dict_list_raises_type_error(self):
        with pytest.raises(TypeError, match="bundle must be a dict"):
            verify_evidence_bundle([1, 2, 3])  # type: ignore[arg-type]


# ── Missing required fields ───────────────────────────────────────────────────


class TestMissingRequiredFields:
    @pytest.mark.parametrize("field", ["bundle_id", "org_id", "status"])
    def test_missing_field_returns_invalid(self, field: str):
        bundle = _make_bundle()
        del bundle[field]
        result = verify_evidence_bundle(bundle)
        assert result.valid is False
        assert result.reason == f"missing required field: {field}"

    def test_missing_bundle_id_bundle_id_is_none(self):
        bundle = _make_bundle()
        del bundle["bundle_id"]
        result = verify_evidence_bundle(bundle)
        assert result.bundle_id is None

    def test_missing_org_id_preserves_bundle_id(self):
        bundle = _make_bundle()
        del bundle["org_id"]
        result = verify_evidence_bundle(bundle)
        assert result.bundle_id == "bnd_test123"


# ── Status checks ─────────────────────────────────────────────────────────────


class TestStatusChecks:
    @pytest.mark.parametrize("status", ["generating", "failed", "pending", "building"])
    def test_non_ready_status_returns_invalid(self, status: str):
        result = verify_evidence_bundle(_make_bundle(status=status))
        assert result.valid is False
        assert f"bundle status is '{status}'" in result.reason
        assert "expected 'ready'" in result.reason

    def test_ready_status_is_valid(self):
        result = verify_evidence_bundle(_make_bundle(status="ready"))
        assert result.valid is True


# ── Hash chain verification ───────────────────────────────────────────────────


class TestHashChainVerification:
    def test_valid_hash_chain_passes(self):
        bundle = _bundle_with_hash_chain()
        result = verify_evidence_bundle(bundle)
        assert result.valid is True

    def test_tampered_hash_chain_returns_invalid(self):
        bundle = _bundle_with_hash_chain()
        bundle["hash_chain"]["root_hash"] = "deadbeef" * 8
        result = verify_evidence_bundle(bundle)
        assert result.valid is False
        assert "root hash mismatch" in result.reason

    def test_hash_chain_absent_skips_check(self):
        """When hash_chain is not present, the check is skipped."""
        bundle = _make_bundle()
        assert "hash_chain" not in bundle
        result = verify_evidence_bundle(bundle)
        assert result.valid is True

    def test_hash_chain_without_root_hash_key_skips(self):
        """hash_chain dict with no root_hash key treated as absent."""
        bundle = _make_bundle()
        bundle["hash_chain"] = {"entry_count": 1}  # no root_hash
        result = verify_evidence_bundle(bundle)
        # hash_chain.get("root_hash") is None, computed is not None → mismatch
        assert result.valid is False  # computed hash != None → mismatch

    def test_multiple_permits_hash_chain(self):
        permits = [
            {"permit_id": "prm_001", "evaluation_id": "eval_001"},
            {"permit_id": "prm_002", "evaluation_id": "eval_002"},
        ]
        bundle = _bundle_with_hash_chain(permits)
        result = verify_evidence_bundle(bundle)
        assert result.valid is True
        assert result.permit_id == "prm_001"


# ── Permit extraction ─────────────────────────────────────────────────────────


class TestPermitExtraction:
    def test_first_permit_id_is_returned(self):
        result = verify_evidence_bundle(_make_bundle())
        assert result.permit_id == "prm_001"

    def test_empty_permits_permit_id_is_none(self):
        result = verify_evidence_bundle(_make_bundle(permits=[]))
        assert result.permit_id is None
        assert result.valid is True  # empty permits list is still valid

    def test_permit_without_permit_id_key(self):
        bundle = _make_bundle(permits=[{"evaluation_id": "eval_001"}])
        result = verify_evidence_bundle(bundle)
        assert result.permit_id is None
        assert result.valid is True


# ── _compute_root_hash ────────────────────────────────────────────────────────


class TestComputeRootHash:
    def test_deterministic(self):
        permits = [{"permit_id": "a"}, {"permit_id": "b"}]
        assert _compute_root_hash(permits) == _compute_root_hash(permits)

    def test_empty_list(self):
        result = _compute_root_hash([])
        # SHA-256 of "[]" with sort_keys=True
        expected = hashlib.sha256(b"[]").hexdigest()
        assert result == expected

    def test_sort_keys_canonical_form(self):
        """Keys are sorted so order-of-keys in permits doesn't matter."""
        p1 = [{"b": 2, "a": 1}]
        p2 = [{"a": 1, "b": 2}]
        assert _compute_root_hash(p1) == _compute_root_hash(p2)
