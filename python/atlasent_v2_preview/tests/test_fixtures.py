"""Cross-language parity test — Python side.

Reads the shared proof-bundle vectors at
``contract/vectors/v2/proof-bundles/`` and runs each through the
v2-preview replay harness, asserting the verdict matches the
fixture's ``expected`` block.

The TypeScript sibling
(``typescript/packages/v2-preview/test/fixtures.test.ts``) consumes
the same fixtures with the same assertions. Any drift between
languages, between SDKs and the generator, or between SDKs and the
schemas surfaces here at CI time.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from atlasent_v2_preview import VerifyKey, replay_proof_bundle

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES_DIR = REPO_ROOT / "contract" / "vectors" / "v2" / "proof-bundles"


def _load_key(filename: str, key_id: str) -> VerifyKey:
    pem = (FIXTURES_DIR / filename).read_bytes()
    pub = serialization.load_pem_public_key(pem)
    assert isinstance(pub, Ed25519PublicKey)
    return VerifyKey(key_id=key_id, public_key=pub)


def _load_fixture(name: str) -> dict:
    return json.loads((FIXTURES_DIR / f"{name}.json").read_text())


@pytest.fixture(scope="module")
def active_key() -> VerifyKey:
    return _load_key("signing-key.pub.pem", "v2-proof-key-active")


@pytest.fixture(scope="module")
def other_key() -> VerifyKey:
    return _load_key("other-key.pub.pem", "v2-proof-key-other")


class TestProofBundleFixtures:
    def test_valid(self, active_key):
        fx = _load_fixture("valid")
        result = replay_proof_bundle(fx["proofs"], [active_key])
        assert result.passed == 3
        assert result.failed == 0
        assert result.incomplete == 0

    def test_tampered_payload(self, active_key):
        fx = _load_fixture("tampered-payload")
        result = replay_proof_bundle(fx["proofs"], [active_key])
        assert result.passed == 2
        assert result.failed == 1
        assert result.proofs[1].verification_status == "invalid"
        sig = next(c for c in result.proofs[1].checks if c.name == "signature")
        assert sig.passed is False
        assert sig.reason == "invalid_signature"

    def test_broken_chain(self, active_key):
        fx = _load_fixture("broken-chain")
        result = replay_proof_bundle(fx["proofs"], [active_key])
        assert result.passed == 2
        assert result.failed == 1
        link = next(c for c in result.proofs[1].checks if c.name == "chain_link")
        assert link.passed is False
        assert link.reason == "broken_chain"
        # Signature on the same proof should still pass — the generator
        # re-signed after mutating previous_hash.
        sig = next(c for c in result.proofs[1].checks if c.name == "signature")
        assert sig.passed is True

    def test_pending_non_strict(self, active_key):
        fx = _load_fixture("pending")
        result = replay_proof_bundle(fx["proofs"], [active_key])
        assert result.passed == 2
        assert result.failed == 0
        assert result.incomplete == 1
        assert result.proofs[1].verification_status == "incomplete"

    def test_pending_strict(self, active_key):
        fx = _load_fixture("pending")
        result = replay_proof_bundle(fx["proofs"], [active_key], strict=True)
        assert result.passed == 2
        assert result.failed == 1
        assert result.incomplete == 0
        exec_check = next(
            c for c in result.proofs[1].checks if c.name == "execution_coherence"
        )
        assert exec_check.reason == "execution_not_consumed"

    def test_wrong_key_under_active(self, active_key):
        # Bundle was signed by the OTHER key but advertises the active
        # key id. Verifying with only the active key in the trust set:
        # every signature fails with invalid_signature.
        fx = _load_fixture("wrong-key")
        result = replay_proof_bundle(fx["proofs"], [active_key])
        assert result.passed == 0
        assert result.failed == 3
        for entry in result.proofs:
            sig = next(c for c in entry.checks if c.name == "signature")
            assert sig.reason == "invalid_signature"

    def test_wrong_key_under_other_key(self, other_key):
        # Same bundle, but verified with only the OTHER key. The hint
        # ("v2-proof-key-active") doesn't match anything in the keyset,
        # so the verifier falls through to "any other key" — and the
        # OTHER key is exactly that. Demonstrates rotation semantics.
        fx = _load_fixture("wrong-key")
        result = replay_proof_bundle(fx["proofs"], [other_key])
        assert result.passed == 3
        assert result.failed == 0

    def test_rotated_key_with_active_key(self, active_key):
        # Bundle signed by the active key but advertises the retired
        # key id. With the active key in the trust set, rotation
        # fallback succeeds.
        fx = _load_fixture("rotated-key")
        result = replay_proof_bundle(fx["proofs"], [active_key])
        assert result.passed == 3
        assert result.failed == 0
        for entry in result.proofs:
            assert entry.signing_key_id == "v2-proof-key-active"

    def test_rotated_key_with_only_other_key(self, other_key):
        # No key in the trust set matches the actual signature, AND the
        # advertised retired key id isn't in the trust set either. The
        # verifier reports retired_signing_key (vs. invalid_signature)
        # so operators can tell "I rotated the key" from "the proof
        # is forged".
        fx = _load_fixture("rotated-key")
        result = replay_proof_bundle(fx["proofs"], [other_key])
        assert result.failed == 3
        for entry in result.proofs:
            sig = next(c for c in entry.checks if c.name == "signature")
            assert sig.reason == "retired_signing_key"
