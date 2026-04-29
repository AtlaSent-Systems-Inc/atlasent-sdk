"""Offline replay harness tests.

Mirrors ``typescript/packages/v2-preview/test/verifyProof.test.ts``
scenario-for-scenario so both languages exercise the same proof
lifecycle against the same canonicalization + signing rules.
Generates synthetic Ed25519 key pairs at test time via
``cryptography``; no fixtures on disk.

Covers: valid single proof, valid multi-proof chain, tampered
payload hash, broken chain link, wrong key, rotated key (hint
misses, fallback succeeds), pending execution (strict + non-strict),
absent signature, malformed base64url signature, empty key set,
out-of-order bundles, retired_signing_key, aggregate tallies.
"""

from __future__ import annotations

import base64
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from atlasent_v2_preview.canonicalize import canonicalize_payload
from atlasent_v2_preview.verify_proof import (
    GENESIS_HASH,
    VerifyKey,
    replay_proof_bundle,
    signed_bytes_for_proof,
    verify_proof,
)


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _gen_key(key_id: str) -> tuple[VerifyKey, Ed25519PrivateKey]:
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key()
    assert isinstance(pub, Ed25519PublicKey)
    return VerifyKey(key_id=key_id, public_key=pub), priv


def _sign(priv: Ed25519PrivateKey, proof: dict[str, Any]) -> str:
    bytes_to_sign = signed_bytes_for_proof({**proof, "signature": ""})
    return _b64url(priv.sign(bytes_to_sign))


def _base_proof(**overrides: Any) -> dict[str, Any]:
    proof: dict[str, Any] = {
        "proof_id": "11111111-2222-3333-4444-555555555555",
        "permit_id": "dec_abc",
        "org_id": "org-1",
        "agent": "deploy-bot",
        "action": "deploy_to_production",
        "target": "prod-cluster",
        "payload_hash": "a" * 64,
        "policy_version": "v3-a7f1",
        "decision": "allow",
        "execution_status": "executed",
        "execution_hash": None,
        "audit_hash": "b" * 64,
        "previous_hash": GENESIS_HASH,
        "chain_hash": "c" * 64,
        "signing_key_id": "key-test",
        "signature": "",
        "issued_at": "2026-04-24T12:00:00Z",
        "consumed_at": "2026-04-24T12:00:01Z",
    }
    proof.update(overrides)
    return proof


# ── signed_bytes_for_proof ───────────────────────────────────────────


class TestSignedBytesForProof:
    def test_excludes_signature_and_signing_key_id(self):
        proof = _base_proof(
            signature="should-not-affect",
            signing_key_id="should-not-affect-either",
        )
        text = signed_bytes_for_proof(proof).decode("utf-8")
        assert "should-not-affect" not in text
        assert '"signature"' not in text
        assert '"signing_key_id"' not in text

    def test_serializes_sixteen_signed_fields(self):
        proof = _base_proof()
        import json

        envelope = json.loads(signed_bytes_for_proof(proof).decode("utf-8"))
        assert sorted(envelope.keys()) == sorted(
            [
                "action",
                "agent",
                "audit_hash",
                "chain_hash",
                "consumed_at",
                "decision",
                "execution_hash",
                "execution_status",
                "issued_at",
                "org_id",
                "payload_hash",
                "permit_id",
                "policy_version",
                "previous_hash",
                "proof_id",
                "target",
            ]
        )

    def test_matches_canonicalize_of_sixteen_field_subset(self):
        proof = _base_proof()
        envelope = {
            "proof_id": proof["proof_id"],
            "permit_id": proof["permit_id"],
            "org_id": proof["org_id"],
            "agent": proof["agent"],
            "action": proof["action"],
            "target": proof["target"],
            "payload_hash": proof["payload_hash"],
            "policy_version": proof["policy_version"],
            "decision": proof["decision"],
            "execution_status": proof["execution_status"],
            "execution_hash": proof["execution_hash"],
            "audit_hash": proof["audit_hash"],
            "previous_hash": proof["previous_hash"],
            "chain_hash": proof["chain_hash"],
            "issued_at": proof["issued_at"],
            "consumed_at": proof["consumed_at"],
        }
        assert (
            signed_bytes_for_proof(proof)
            == canonicalize_payload(envelope).encode("utf-8")
        )


# ── verify_proof — single proof ─────────────────────────────────────


@pytest.fixture
def signer():
    return _gen_key("key-test")


@pytest.fixture
def wrong_signer():
    return _gen_key("key-other")


class TestVerifyProof:
    def test_valid_signed_proof(self, signer):
        verify_key, priv = signer
        proof = _base_proof()
        proof["signature"] = _sign(priv, proof)
        result = verify_proof(proof, [verify_key], GENESIS_HASH)
        assert result.verification_status == "valid"
        assert result.signing_key_id == "key-test"
        assert all(c.passed for c in result.checks)

    def test_rotation_fallback_when_hint_unknown(self, signer, wrong_signer):
        verify_key, priv = signer
        wrong_key, _ = wrong_signer
        proof = _base_proof(signing_key_id="key-unknown")
        proof["signature"] = _sign(priv, proof)
        result = verify_proof(proof, [wrong_key, verify_key], GENESIS_HASH)
        assert result.verification_status == "valid"
        assert result.signing_key_id == "key-test"

    def test_tampered_payload_hash(self, signer):
        verify_key, priv = signer
        proof = _base_proof()
        proof["signature"] = _sign(priv, proof)
        proof["payload_hash"] = "f" * 64  # tamper after signing
        result = verify_proof(proof, [verify_key], GENESIS_HASH)
        assert result.verification_status == "invalid"
        sig = next(c for c in result.checks if c.name == "signature")
        assert sig.passed is False
        assert sig.reason == "invalid_signature"

    def test_wrong_key(self, signer, wrong_signer):
        _, priv = signer
        wrong_key, _ = wrong_signer
        proof = _base_proof()
        proof["signature"] = _sign(priv, proof)
        result = verify_proof(proof, [wrong_key], GENESIS_HASH)
        assert result.verification_status == "invalid"

    def test_empty_keyset(self, signer):
        _, priv = signer
        proof = _base_proof()
        proof["signature"] = _sign(priv, proof)
        result = verify_proof(proof, [], GENESIS_HASH)
        assert result.verification_status == "invalid"
        sig = next(c for c in result.checks if c.name == "signature")
        assert sig.reason == "invalid_signature"

    def test_empty_signature(self, signer):
        verify_key, _ = signer
        proof = _base_proof(signature="")
        result = verify_proof(proof, [verify_key], GENESIS_HASH)
        sig = next(c for c in result.checks if c.name == "signature")
        assert sig.passed is False
        assert sig.reason == "invalid_signature"

    def test_malformed_base64url(self, signer):
        verify_key, _ = signer
        proof = _base_proof(signature="!!!not-base64!!!")
        result = verify_proof(proof, [verify_key], GENESIS_HASH)
        assert result.verification_status == "invalid"

    def test_chain_link_breaks_on_mismatch(self, signer):
        verify_key, priv = signer
        proof = _base_proof(previous_hash="d" * 64)
        proof["signature"] = _sign(priv, proof)
        result = verify_proof(proof, [verify_key], GENESIS_HASH)
        link = next(c for c in result.checks if c.name == "chain_link")
        assert link.passed is False
        assert link.reason == "broken_chain"

    def test_chain_link_skipped_when_previous_is_none(self, signer):
        verify_key, priv = signer
        proof = _base_proof(previous_hash="d" * 64)
        proof["signature"] = _sign(priv, proof)
        result = verify_proof(proof, [verify_key], None)
        link = next(c for c in result.checks if c.name == "chain_link")
        assert link.passed is True

    def test_payload_hash_rejects_non_hex(self, signer):
        verify_key, priv = signer
        proof = _base_proof(payload_hash="not-hex")
        proof["signature"] = _sign(priv, proof)
        result = verify_proof(proof, [verify_key], GENESIS_HASH)
        h = next(c for c in result.checks if c.name == "payload_hash")
        assert h.passed is False
        assert h.reason == "payload_hash_mismatch"

    def test_missing_policy_version(self, signer):
        verify_key, priv = signer
        proof = _base_proof(policy_version="")
        proof["signature"] = _sign(priv, proof)
        result = verify_proof(proof, [verify_key], GENESIS_HASH)
        pv = next(c for c in result.checks if c.name == "policy_version")
        assert pv.passed is False
        assert pv.reason == "missing_policy_version"

    def test_pending_is_incomplete_by_default(self, signer):
        verify_key, priv = signer
        proof = _base_proof(execution_status="pending", consumed_at=None)
        proof["signature"] = _sign(priv, proof)
        result = verify_proof(proof, [verify_key], GENESIS_HASH)
        assert result.verification_status == "incomplete"
        assert result.reason == "execution pending"

    def test_pending_is_invalid_under_strict(self, signer):
        verify_key, priv = signer
        proof = _base_proof(execution_status="pending", consumed_at=None)
        proof["signature"] = _sign(priv, proof)
        result = verify_proof(proof, [verify_key], GENESIS_HASH, strict=True)
        assert result.verification_status == "invalid"
        exec_check = next(c for c in result.checks if c.name == "execution_coherence")
        assert exec_check.reason == "execution_not_consumed"

    def test_failed_without_consumed_at(self, signer):
        verify_key, priv = signer
        proof = _base_proof(execution_status="failed", consumed_at=None)
        proof["signature"] = _sign(priv, proof)
        result = verify_proof(proof, [verify_key], GENESIS_HASH)
        exec_check = next(c for c in result.checks if c.name == "execution_coherence")
        assert exec_check.passed is False
        assert exec_check.reason == "execution_not_consumed"

    def test_retired_signing_key_when_hint_absent(self, signer, wrong_signer):
        _, priv = signer
        wrong_key, _ = wrong_signer
        proof = _base_proof(signing_key_id="key-retired")
        proof["signature"] = _sign(priv, proof)
        result = verify_proof(proof, [wrong_key], GENESIS_HASH)
        sig = next(c for c in result.checks if c.name == "signature")
        assert sig.reason == "retired_signing_key"


# ── replay_proof_bundle — chain + aggregates ────────────────────────


def _chain_of(priv: Ed25519PrivateKey, n: int) -> list[dict[str, Any]]:
    chain: list[dict[str, Any]] = []
    prev = GENESIS_HASH
    for i in range(n):
        proof = _base_proof(
            proof_id=f"proof-{i}",
            previous_hash=prev,
            chain_hash=(f"{i:02x}" * 32)[:64],
        )
        proof["signature"] = _sign(priv, proof)
        chain.append(proof)
        prev = proof["chain_hash"]
    return chain


class TestReplayProofBundle:
    def test_valid_chain_all_passed(self, signer):
        verify_key, priv = signer
        bundle = _chain_of(priv, 3)
        result = replay_proof_bundle(bundle, [verify_key])
        assert result.passed == 3
        assert result.failed == 0
        assert result.incomplete == 0
        assert len(result.proofs) == 3

    def test_break_in_middle_of_chain(self, signer):
        verify_key, priv = signer
        bundle = _chain_of(priv, 3)
        bundle[1]["previous_hash"] = "f" * 64
        bundle[1]["signature"] = _sign(priv, bundle[1])
        result = replay_proof_bundle(bundle, [verify_key])
        assert result.failed == 1
        link = next(c for c in result.proofs[1].checks if c.name == "chain_link")
        assert link.passed is False

    def test_preserves_input_order(self, signer):
        verify_key, priv = signer
        bundle = _chain_of(priv, 4)
        result = replay_proof_bundle(bundle, [verify_key])
        for i in range(4):
            assert result.proofs[i].proof_id == f"proof-{i}"

    def test_mixed_passed_failed_incomplete(self, signer):
        verify_key, priv = signer
        bundle = _chain_of(priv, 3)
        bundle[1]["execution_status"] = "pending"
        bundle[1]["consumed_at"] = None
        bundle[1]["signature"] = _sign(priv, bundle[1])
        bundle[2]["signature"] = "invalid"
        result = replay_proof_bundle(bundle, [verify_key])
        assert result.passed == 1
        assert result.incomplete == 1
        assert result.failed == 1

    def test_empty_bundle(self, signer):
        verify_key, _ = signer
        result = replay_proof_bundle([], [verify_key])
        assert result.passed == 0
        assert result.failed == 0
        assert result.incomplete == 0
        assert result.proofs == []


# ── load_verify_keys ─────────────────────────────────────────────────


class TestLoadVerifyKeys:
    def test_loads_valid_ed25519_pem(self):
        priv = Ed25519PrivateKey.generate()
        from cryptography.hazmat.primitives import serialization

        pem = priv.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("utf-8")
        keys = __import__("atlasent_v2_preview").load_verify_keys([pem])
        assert len(keys) == 1
        assert keys[0].key_id == "pem_0"

    def test_skips_malformed_pem(self):
        from atlasent_v2_preview import load_verify_keys

        malformed = (
            "-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----\n"
        )
        assert load_verify_keys([malformed]) == []
