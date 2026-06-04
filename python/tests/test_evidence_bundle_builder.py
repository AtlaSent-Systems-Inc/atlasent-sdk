"""Round-trip: the reference builder produces bundles the verifier accepts."""

import pytest

from atlasent.evidence_bundle_builder import build_evidence_bundle, generate_issuing_key
from atlasent.evidence_bundle_verifier import verify_evidence_bundle


def test_build_then_verify_roundtrip():
    sk, key_set = generate_issuing_key("k1")
    bundle = build_evidence_bundle(
        [
            {"decision_id": "d1", "decision": {"action": "x", "outcome": "permit"}},
            {"decision_id": "d2", "decision": {"action": "y", "outcome": "deny"}},
        ],
        sk,
        "k1",
    )
    r = verify_evidence_bundle(bundle, key_set)
    assert r.ok is True
    assert r.record_count == 2
    assert r.checks == ["signature", "chain_binding", "summary_hash"]


def test_build_unicode_roundtrip():
    sk, key_set = generate_issuing_key("k1")
    bundle = build_evidence_bundle(
        [{"decision_id": "d1", "decision": {"actor": "Frédéric / 北京"}}], sk, "k1"
    )
    assert verify_evidence_bundle(bundle, key_set).ok is True


def test_build_requires_records():
    sk, _ = generate_issuing_key()
    with pytest.raises(ValueError):
        build_evidence_bundle([], sk, "k1")
