"""Pillar 9 — replay the shared proof-bundle fixtures.

Loads each fixture from ``contract/vectors/v2/proof-bundles/`` and
runs them through ``replay_proof_bundle``, asserting the verdict
matches the fixture's documented ``expected`` block.

This is the same end-to-end flow the consumer test in
``tests/test_fixtures.py`` exercises, just without the test runner —
auditors / CI dashboards can run it directly.

Run:  python examples/02_verify_shared_fixtures.py
"""

import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from atlasent_v2_preview import VerifyKey, replay_proof_bundle

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES_DIR = REPO_ROOT / "contract" / "vectors" / "v2" / "proof-bundles"


def _load_key(filename: str, key_id: str) -> VerifyKey:
    pem = (FIXTURES_DIR / filename).read_bytes()
    pub = serialization.load_pem_public_key(pem)
    assert isinstance(pub, Ed25519PublicKey), "expected Ed25519 public key"
    return VerifyKey(key_id=key_id, public_key=pub)


def _load_fixture(name: str) -> dict:
    return json.loads((FIXTURES_DIR / f"{name}.json").read_text())


def main() -> None:
    active = _load_key("signing-key.pub.pem", "v2-proof-key-active")
    other = _load_key("other-key.pub.pem", "v2-proof-key-other")

    # Each fixture, run with the appropriate key set.
    fixtures = [
        ("valid", [active], "non_strict", "all 3 proofs valid"),
        ("tampered-payload", [active], "non_strict", "proof[1] signature fails"),
        ("broken-chain", [active], "non_strict", "proof[1] chain_link fails"),
        ("pending", [active], "non_strict", "proof[1] incomplete"),
        ("pending", [active], "strict", "proof[1] invalid (strict mode)"),
        ("wrong-key", [active], "non_strict", "all 3 fail signature under active"),
        ("wrong-key", [other], "non_strict", "all 3 verify under OTHER (rotation)"),
        ("rotated-key", [active], "non_strict", "all 3 valid (rotation fallback)"),
        ("rotated-key", [other], "non_strict", "all 3 retired_signing_key"),
    ]

    for name, keys, mode, summary in fixtures:
        fixture = _load_fixture(name)
        result = replay_proof_bundle(
            fixture["proofs"],
            keys,
            strict=(mode == "strict"),
        )
        keylabel = ", ".join(k.key_id for k in keys)
        print(
            f"  {name:22s} keys=[{keylabel}] mode={mode:11s} "
            f"-> passed={result.passed} failed={result.failed} "
            f"incomplete={result.incomplete}  ({summary})"
        )


if __name__ == "__main__":
    main()
