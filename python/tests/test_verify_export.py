"""Offline audit-export verifier tests.

Generates a real Ed25519-signed envelope using the same canonicalize
the server uses, then verifies it. Also covers tamper + trust-anchor
paths. Requires the ``cryptography`` optional extra (installed via
``pip install 'atlasent[verify]'`` or the ``dev`` extra).
"""

from __future__ import annotations

import base64
import json
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from atlasent import ExportVerifyResult, verify_bundle
from atlasent.canonical import canonicalize, sha256_hex


def _build_envelope() -> tuple[dict[str, Any], str, Ed25519PrivateKey]:
    """Produce a signed two-row execution chain with an empty admin chain."""
    priv = Ed25519PrivateKey.generate()
    pub_pem = (
        priv.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode("utf-8")
    )

    org = "org-1"
    row1_payload = (
        f"v2|{org}|ac-1|req-1|ci|allow||ctxh|pth|b-1|1|rh||"
        f"2026-04-16T10:00:00.000000Z|GENESIS"
    )
    row1_hash = sha256_hex(row1_payload)
    row2_payload = (
        f"v2|{org}|ac-1|req-2|ci|allow||ctxh|pth|b-1|1|rh||"
        f"2026-04-16T10:01:00.000000Z|{row1_hash}"
    )
    row2_hash = sha256_hex(row2_payload)

    envelope: dict[str, Any] = {
        "version": 1,
        "org_id": org,
        "generated_at": "2026-04-16T10:05:00.000Z",
        "range": {"since": None, "until": None, "limit": 10000},
        "evaluations": [
            {
                "id": "e-1",
                "canonical_payload": row1_payload,
                "entry_hash": row1_hash,
                "prev_hash": None,
            },
            {
                "id": "e-2",
                "canonical_payload": row2_payload,
                "entry_hash": row2_hash,
                "prev_hash": row1_hash,
            },
        ],
        "execution_head": {"id": "e-2", "entry_hash": row2_hash},
        "admin_log": [],
        "admin_head": None,
        "public_key_pem": pub_pem,
    }
    canonical_bytes = canonicalize(envelope).encode("utf-8")
    envelope["signature"] = base64.b64encode(priv.sign(canonical_bytes)).decode("ascii")
    return envelope, pub_pem, priv


def test_happy_path():
    envelope, trusted_pem, _ = _build_envelope()
    result = verify_bundle(envelope, trusted_public_key_pem=trusted_pem)
    assert result.errors == []
    assert result.chain_ok is True
    assert result.signature_ok is True
    assert result.trusted_key_ok is True
    assert result.ok is True


def test_without_trust_anchor_self_verifies_only():
    envelope, _, _ = _build_envelope()
    result = verify_bundle(envelope)
    assert result.chain_ok is True
    assert result.signature_ok is True
    assert result.trusted_key_ok is None
    assert result.ok is True


def test_detects_tampered_canonical_payload():
    envelope, trusted_pem, _ = _build_envelope()
    orig = envelope["evaluations"][0]["canonical_payload"]
    envelope["evaluations"][0]["canonical_payload"] = orig.replace("allow", "deny", 1)

    result = verify_bundle(envelope, trusted_public_key_pem=trusted_pem)
    assert result.chain_ok is False
    assert any("sha256" in e for e in result.errors)


def test_detects_broken_prev_pointer():
    envelope, trusted_pem, priv = _build_envelope()
    envelope["evaluations"].reverse()
    env_minus_sig = {k: v for k, v in envelope.items() if k != "signature"}
    envelope["signature"] = base64.b64encode(
        priv.sign(canonicalize(env_minus_sig).encode("utf-8"))
    ).decode("ascii")

    result = verify_bundle(envelope, trusted_public_key_pem=trusted_pem)
    assert result.chain_ok is False
    assert any("prev" in e for e in result.errors)


def test_detects_claimed_head_mismatch():
    envelope, trusted_pem, priv = _build_envelope()
    envelope["execution_head"] = {"id": "e-bogus", "entry_hash": "deadbeef"}
    env_minus_sig = {k: v for k, v in envelope.items() if k != "signature"}
    envelope["signature"] = base64.b64encode(
        priv.sign(canonicalize(env_minus_sig).encode("utf-8"))
    ).decode("ascii")

    result = verify_bundle(envelope, trusted_public_key_pem=trusted_pem)
    assert result.chain_ok is False
    assert any("claimed head" in e for e in result.errors)


def test_detects_wrong_trust_anchor():
    envelope, _, _ = _build_envelope()
    other = Ed25519PrivateKey.generate()
    other_pem = (
        other.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode("utf-8")
    )
    result = verify_bundle(envelope, trusted_public_key_pem=other_pem)
    assert result.signature_ok is True
    assert result.trusted_key_ok is False
    assert result.ok is False
    assert any("trusted anchor" in e for e in result.errors)


def test_detects_tampered_signature():
    envelope, trusted_pem, _ = _build_envelope()
    sig = bytearray(base64.b64decode(envelope["signature"]))
    # XOR a bit — guaranteed to flip the value regardless of the original byte.
    sig[-1] ^= 0xFF
    envelope["signature"] = base64.b64encode(bytes(sig)).decode("ascii")

    result = verify_bundle(envelope, trusted_public_key_pem=trusted_pem)
    assert result.signature_ok is False
    assert result.ok is False


def test_handles_missing_signature_gracefully():
    envelope, _, _ = _build_envelope()
    del envelope["signature"]
    result = verify_bundle(envelope)
    assert result.signature_ok is False
    assert any("missing signature" in e for e in result.errors)


def test_handles_missing_public_key_gracefully():
    envelope, _, _ = _build_envelope()
    del envelope["public_key_pem"]
    result = verify_bundle(envelope)
    assert result.signature_ok is False
    assert any("missing signature" in e for e in result.errors)


def test_handles_malformed_pem():
    envelope, _, _ = _build_envelope()
    envelope["public_key_pem"] = "not a real key"
    result = verify_bundle(envelope)
    assert result.signature_ok is False
    assert any("public key" in e for e in result.errors)


def test_verify_from_file(tmp_path):
    envelope, trusted_pem, _ = _build_envelope()
    path = tmp_path / "export.json"
    path.write_text(json.dumps(envelope))

    result = verify_bundle(path, trusted_public_key_pem=trusted_pem)
    assert result.ok is True

    # Also accepts a string path.
    result2 = verify_bundle(str(path), trusted_public_key_pem=trusted_pem)
    assert result2.ok is True


def test_rejects_non_mapping_input():
    with pytest.raises(TypeError, match="must be a mapping"):
        verify_bundle(["not", "an", "envelope"])  # type: ignore[arg-type]


def test_result_ok_property():
    assert ExportVerifyResult(chain_ok=True, signature_ok=True).ok is True
    assert ExportVerifyResult(chain_ok=False, signature_ok=True).ok is False
    assert ExportVerifyResult(chain_ok=True, signature_ok=False).ok is False
    assert (
        ExportVerifyResult(
            chain_ok=True, signature_ok=True, trusted_key_ok=False
        ).ok
        is False
    )
    assert (
        ExportVerifyResult(
            chain_ok=True, signature_ok=True, trusted_key_ok=True
        ).ok
        is True
    )


def test_trusted_anchor_ignores_pem_whitespace():
    """PEM armour + whitespace must not affect the byte-equality check."""
    envelope, trusted_pem, _ = _build_envelope()
    mangled = trusted_pem.replace("\n", "\r\n") + "\n  "
    result = verify_bundle(envelope, trusted_public_key_pem=mangled)
    assert result.trusted_key_ok is True


def test_empty_chains_are_allowed():
    """A bundle with no rows is trivially chain-ok."""
    priv = Ed25519PrivateKey.generate()
    pub_pem = (
        priv.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode("utf-8")
    )
    envelope: dict[str, Any] = {
        "version": 1,
        "org_id": "org-1",
        "generated_at": "2026-04-16T10:00:00Z",
        "range": {"since": None, "until": None, "limit": 10000},
        "evaluations": [],
        "execution_head": None,
        "admin_log": [],
        "admin_head": None,
        "public_key_pem": pub_pem,
    }
    envelope["signature"] = base64.b64encode(
        priv.sign(canonicalize(envelope).encode("utf-8"))
    ).decode("ascii")

    result = verify_bundle(envelope, trusted_public_key_pem=pub_pem)
    assert result.ok is True
