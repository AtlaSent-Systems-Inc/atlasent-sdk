"""Regenerate the v2 proof-bundle contract fixtures.

Produces ``contract/vectors/v2/proof-bundles/*.json`` — the golden
inputs both v2-preview SDKs' proof verifiers consume. The fixtures are
checked in; this script exists so regen stays reproducible.

Reference contract: ``contract/schemas/v2/proof.schema.json``. The
Ed25519 signature covers canonical JSON of the 16-field subset of the
Proof envelope (declaration order, excluding ``signature`` and
``signing_key_id``) — see the signed-envelope convention documented in
the TS / Python replay harnesses (PRs #64 / #65) and the open contract
question on PR #61.

Ed25519 signatures are deterministic per RFC 8032, so baking a fixed
seed into the generator yields byte-identical fixtures on rerun —
matching the approach taken for the v1 audit bundles
(``gen_audit_bundles.py``).

Run:  ``python contract/tools/gen_proof_bundles.py``
"""

from __future__ import annotations

import json
from base64 import urlsafe_b64encode
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

# 32 bytes — raw Ed25519 seed. Anything fixed will do; using an obvious
# non-secret string documents that these keys are test-only.
_ACTIVE_SEED = b"ATLASENT-V2-PROOF-ACTIVE-SEED-!!"[:32]
_OTHER_SEED = b"ATLASENT-V2-PROOF-OTHER-SEED-!!!"[:32]

_ACTIVE_KEY_ID = "v2-proof-key-active"
_RETIRED_KEY_ID = "v2-proof-key-retired"
_OTHER_KEY_ID = "v2-proof-key-other"

# Declaration order from contract/schemas/v2/proof.schema.json, minus
# signature + signing_key_id (which can't be inside the bytes they
# cover). Keep this list and SDK-side SIGNED_ENVELOPE_FIELDS in lockstep.
SIGNED_FIELDS: tuple[str, ...] = (
    "proof_id",
    "permit_id",
    "org_id",
    "agent",
    "action",
    "target",
    "payload_hash",
    "policy_version",
    "decision",
    "execution_status",
    "execution_hash",
    "audit_hash",
    "previous_hash",
    "chain_hash",
    "issued_at",
    "consumed_at",
)

GENESIS_HASH = "0" * 64


def canonical_json(value: object) -> str:
    """Same canonicalizer as v1's `gen_audit_bundles.py`."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (
            value != value or value in (float("inf"), float("-inf"))
        ):
            return "null"
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = [
            json.dumps(k, ensure_ascii=False) + ":" + canonical_json(value[k])
            for k in sorted(value.keys())
        ]
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"cannot canonicalize {type(value).__name__}")


def b64url(data: bytes) -> str:
    return urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign_proof(priv: Ed25519PrivateKey, proof: dict) -> str:
    """Produce the base64url Ed25519 signature over a proof's signed envelope.

    Follows the SDK-side ``signedBytesForProof`` / ``signed_bytes_for_proof``
    convention: 16 fields in schema declaration order, canonicalized,
    then signed.
    """
    envelope = {field: proof.get(field) for field in SIGNED_FIELDS}
    return b64url(priv.sign(canonical_json(envelope).encode("utf-8")))


def _base_proof(
    *,
    index: int,
    previous_hash: str,
    signing_key_id: str = _ACTIVE_KEY_ID,
    **overrides,
) -> dict:
    """Synthesize a plausible proof at ``index`` in a chain.

    ``chain_hash`` is a synthetic hex that differs per proof; for the
    contract fixtures the *shape* matters more than cryptographic
    derivation, so we don't recompute SHA-256(previous || payload)
    here. That keeps the fixture compact and the generator free of
    payload hashing mechanics that the SDKs re-derive at verify time.
    """
    proof: dict = {
        "proof_id": f"proof-{index:02d}-0000-0000-0000-000000000000"[:36],
        "permit_id": f"dec_{index:04x}",
        "org_id": "org-v2-proof-fixture",
        "agent": "fixture-agent",
        "action": "fixture.action",
        "target": f"target-{index}",
        "payload_hash": f"{index:02x}" * 32,
        "policy_version": "policy-v2-fixture-1",
        "decision": "allow",
        "execution_status": "executed",
        "execution_hash": None,
        "audit_hash": f"{(index + 0x80):02x}" * 32,
        "previous_hash": previous_hash,
        "chain_hash": f"{(index + 0xc0):02x}" * 32,
        "signing_key_id": signing_key_id,
        "signature": "",
        "issued_at": f"2026-04-24T12:{index:02d}:00Z",
        "consumed_at": f"2026-04-24T12:{index:02d}:01Z",
    }
    proof.update(overrides)
    return proof


def _chain_of(
    priv: Ed25519PrivateKey,
    n: int,
    *,
    signing_key_id: str = _ACTIVE_KEY_ID,
) -> list[dict]:
    chain: list[dict] = []
    prev = GENESIS_HASH
    for i in range(n):
        proof = _base_proof(
            index=i,
            previous_hash=prev,
            signing_key_id=signing_key_id,
        )
        proof["signature"] = sign_proof(priv, proof)
        chain.append(proof)
        prev = proof["chain_hash"]
    return chain


def _pem_spki_public(priv: Ed25519PrivateKey) -> str:
    return priv.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")


def _write(target: Path, payload: dict) -> None:
    # Pretty-printed with a trailing newline — matches the v1 audit
    # fixtures so diffs stay reviewable.
    target.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    out = Path(__file__).resolve().parents[1] / "vectors" / "v2" / "proof-bundles"
    out.mkdir(parents=True, exist_ok=True)

    active = Ed25519PrivateKey.from_private_bytes(_ACTIVE_SEED)
    other = Ed25519PrivateKey.from_private_bytes(_OTHER_SEED)

    # Public key of the active signer — this is the "audit-export-pub.pem"
    # auditors and CI jobs load into replayProofBundle(..., { keys: [...] }).
    (out / "signing-key.pub.pem").write_text(_pem_spki_public(active))

    # Also write the "wrong" key so the wrong-key fixture has a
    # matching public key for reproducible failure scenarios.
    (out / "other-key.pub.pem").write_text(_pem_spki_public(other))

    # ── Fixture 1: valid bundle ──────────────────────────────────────
    valid_bundle = {
        "description": (
            "3-proof chain signed by v2-proof-key-active. All checks pass."
        ),
        "expected": {
            "passed": 3,
            "failed": 0,
            "incomplete": 0,
        },
        "proofs": _chain_of(active, 3),
    }
    _write(out / "valid.json", valid_bundle)

    # ── Fixture 2: tampered payload hash ─────────────────────────────
    tampered = _chain_of(active, 3)
    tampered[1]["payload_hash"] = "f" * 64  # tamper AFTER signing; sig invalid
    tampered_bundle = {
        "description": (
            "Bundle where proofs[1].payload_hash was mutated after signing. "
            "signature check on proofs[1] fails with invalid_signature; "
            "other proofs still pass."
        ),
        "expected": {
            "passed": 2,
            "failed": 1,
            "incomplete": 0,
            "failed_indices": [1],
            "failed_reason": "invalid_signature",
        },
        "proofs": tampered,
    }
    _write(out / "tampered-payload.json", tampered_bundle)

    # ── Fixture 3: broken chain link ─────────────────────────────────
    broken = _chain_of(active, 3)
    broken[1]["previous_hash"] = "e" * 64
    # Re-sign so signature still verifies — only chain_link should fail.
    broken[1]["signature"] = sign_proof(active, broken[1])
    broken_bundle = {
        "description": (
            "Bundle where proofs[1].previous_hash was pointed at a bogus "
            "value and the signature was recomputed over the mutated "
            "envelope. chain_link check on proofs[1] fails with "
            "broken_chain; signature check still passes."
        ),
        "expected": {
            "passed": 2,
            "failed": 1,
            "incomplete": 0,
            "failed_indices": [1],
            "failed_reason": "broken_chain",
        },
        "proofs": broken,
    }
    _write(out / "broken-chain.json", broken_bundle)

    # ── Fixture 4: pending execution ─────────────────────────────────
    pending = _chain_of(active, 3)
    pending[1]["execution_status"] = "pending"
    pending[1]["consumed_at"] = None
    pending[1]["signature"] = sign_proof(active, pending[1])
    pending_bundle = {
        "description": (
            "Bundle where proofs[1] is still pending. In non-strict mode "
            "that proof is 'incomplete'; in strict mode it is 'invalid' "
            "with reason execution_not_consumed."
        ),
        "expected": {
            "non_strict": {"passed": 2, "failed": 0, "incomplete": 1},
            "strict": {"passed": 2, "failed": 1, "incomplete": 0},
        },
        "proofs": pending,
    }
    _write(out / "pending.json", pending_bundle)

    # ── Fixture 5: wrong key ─────────────────────────────────────────
    wrong_signed = _chain_of(other, 3, signing_key_id=_ACTIVE_KEY_ID)
    wrong_bundle = {
        "description": (
            "3-proof chain signed by v2-proof-key-OTHER while advertising "
            "signing_key_id='v2-proof-key-active'. Verifying with only "
            "the active public key produces 3 signature failures."
        ),
        "expected": {
            "passed": 0,
            "failed": 3,
            "incomplete": 0,
            "failed_reason": "invalid_signature",
        },
        "proofs": wrong_signed,
    }
    _write(out / "wrong-key.json", wrong_bundle)

    # ── Fixture 6: rotated / retired signing key hint ────────────────
    rotated = _chain_of(active, 3, signing_key_id=_RETIRED_KEY_ID)
    rotated_bundle = {
        "description": (
            "Chain signed by the active key but advertising "
            "signing_key_id='v2-proof-key-retired'. Verifier MUST still "
            "succeed — rotation fallback trying the active key next. "
            "Loaders that only pass the retired key id in should report "
            "retired_signing_key."
        ),
        "expected": {
            "with_active_key": {"passed": 3, "failed": 0, "incomplete": 0},
            "with_only_retired_keyid": {
                "passed": 0,
                "failed": 3,
                "failed_reason": "retired_signing_key",
            },
        },
        "proofs": rotated,
    }
    _write(out / "rotated-key.json", rotated_bundle)

    print(f"wrote fixtures under {out}")


if __name__ == "__main__":
    main()
