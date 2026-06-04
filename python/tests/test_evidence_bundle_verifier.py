"""Tests for the offline evidence-bundle reference verifier.

Reads the same cross-language fixtures the TypeScript verifier uses
(contract/vectors/evidence-bundles), so a passing run on both sides proves the
two reference implementations agree byte-for-byte on canonicalization and
Ed25519 interop.
"""

import json
import pathlib

import pytest

from atlasent.evidence_bundle_verifier import (
    BundleVerificationError,
    canonical_json,
    merkle_root_hex,
    verify_evidence_bundle,
)

VEC = (
    pathlib.Path(__file__).resolve().parents[2]
    / "contract"
    / "vectors"
    / "evidence-bundles"
)


def load(name: str):
    return json.loads((VEC / name).read_text())


KEY_SET = load("key-set.json")


def reason(name: str) -> str:
    try:
        verify_evidence_bundle(load(name), KEY_SET)
        return "<no-error>"
    except BundleVerificationError as e:
        return e.reason


def test_valid_bundle_passes():
    r = verify_evidence_bundle(load("valid-3-records.json"), KEY_SET)
    assert r.ok is True
    assert r.record_count == 3
    assert r.checks == ["signature", "chain_binding", "summary_hash"]
    assert r.key_id == "evidence-issuing-2026-06"


@pytest.mark.parametrize(
    "fixture,expected",
    [
        ("tampered-signature.json", "signature_invalid"),
        ("broken-chain.json", "chain_broken"),
        ("unknown-key.json", "unknown_key_id"),
        ("anchor-mismatch.json", "chain_anchor_mismatch"),
        ("summary-mismatch.json", "summary_hash_mismatch"),
        ("entry-tampered.json", "chain_broken"),
    ],
)
def test_inconsistent_bundles_rejected(fixture, expected):
    assert reason(fixture) == expected


def test_malformed_inputs_rejected_before_crypto():
    with pytest.raises(BundleVerificationError) as e1:
        verify_evidence_bundle(None, KEY_SET)
    assert e1.value.reason == "bad_format"

    with pytest.raises(BundleVerificationError) as e2:
        verify_evidence_bundle({}, KEY_SET)
    assert e2.value.reason == "bad_format"

    no_key_id = load("valid-3-records.json")
    del no_key_id["signature"]["key_id"]
    with pytest.raises(BundleVerificationError) as e3:
        verify_evidence_bundle(no_key_id, KEY_SET)
    assert e3.value.reason == "bad_format"

    bad_alg = load("valid-3-records.json")
    bad_alg["signature"]["alg"] = "RS256"
    with pytest.raises(BundleVerificationError) as e4:
        verify_evidence_bundle(bad_alg, KEY_SET)
    assert e4.value.reason == "bad_format"


def test_canonical_json_matches_the_ts_twin():
    assert (
        canonical_json({"b": 1, "a": {"d": 2, "c": 3}}) == '{"a":{"c":3,"d":2},"b":1}'
    )
    assert canonical_json([3, {"z": True, "a": None}]) == '[3,{"a":null,"z":true}]'
    assert canonical_json(True) == "true"
    assert canonical_json(False) == "false"
    assert canonical_json(None) == "null"
    assert canonical_json("x") == '"x"'
    assert canonical_json(42) == "42"


def test_canonical_json_rejects_floats():
    with pytest.raises(BundleVerificationError) as e:
        canonical_json(1.5)
    assert e.value.reason == "bad_format"


def test_merkle_root_empty_is_sha256_of_empty():
    # SHA-256 of the empty string.
    assert merkle_root_hex([]) == (
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
