"""Contract-level tests for trust-root vectors.

Validates every .jsonl file in contract/vectors/trust-root/ against both
format rules and SDK behaviour.  These tests run in contract-ci.yml and
act as the canonical cross-SDK gate: if a vector says it should throw, the
Python SDK must throw; if it says verified=true, it must return verified.

The TypeScript SDK's equivalent gate is trust-root.test.ts.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS_DIR = REPO_ROOT / "contract" / "vectors" / "trust-root"
FIXTURES_DIR = REPO_ROOT / "contract" / "vectors" / "audit-bundles"

PUBLIC_PEM = (
    (FIXTURES_DIR / "signing-key.pub.pem").read_text()
    if (FIXTURES_DIR / "signing-key.pub.pem").exists()
    else ""
)

VALID_REASONS = frozenset(
    ["trust_snapshot_expired", "key_revoked", "key_role_mismatch"]
)

try:
    from atlasent.audit_bundle import _require_crypto  # type: ignore[attr-defined]

    _require_crypto()
    HAS_CRYPTO = True
except Exception:
    HAS_CRYPTO = False


def _load_vectors() -> list[tuple[str, dict[str, Any]]]:
    if not VECTORS_DIR.is_dir():
        return []
    results = []
    for path in sorted(VECTORS_DIR.glob("*.jsonl")):
        raw = path.read_text().strip().splitlines()
        vec = json.loads(raw[0])
        results.append((path.name, vec))
    return results


# ─── Format validation ────────────────────────────────────────────────────────


@pytest.mark.parametrize("name,vec", _load_vectors())
def test_vector_has_required_fields(name: str, vec: dict[str, Any]) -> None:
    assert "description" in vec, f"{name}: missing 'description'"
    assert isinstance(vec["description"], str), f"{name}: description must be str"
    assert "bundle" in vec, f"{name}: missing 'bundle'"
    assert isinstance(vec["bundle"], dict), f"{name}: bundle must be object"
    assert "expected" in vec, f"{name}: missing 'expected'"
    assert isinstance(vec["expected"], dict), f"{name}: expected must be object"


@pytest.mark.parametrize("name,vec", _load_vectors())
def test_vector_expected_semantics(name: str, vec: dict[str, Any]) -> None:
    expected = vec.get("expected", {})
    if "throws" in expected:
        assert expected["throws"] == "BundleVerificationError", (
            f"{name}: expected.throws must be 'BundleVerificationError'"
        )
        assert "reason" in expected, f"{name}: throw path requires reason"
        assert expected["reason"] in VALID_REASONS, (
            f"{name}: unknown reason {expected['reason']!r}"
        )
    else:
        assert "verified" in expected, (
            f"{name}: expected must have 'throws' or 'verified'"
        )
        assert isinstance(expected["verified"], bool), (
            f"{name}: expected.verified must be bool"
        )


# ─── SDK behaviour gate ───────────────────────────────────────────────────────


def _make_snapshot(
    valid_until: str = "2099-01-01T00:00:00Z",
    issued_at: str = "2026-01-01T00:00:00Z",
    keys: list[dict[str, Any]] | None = None,
    revoked_keys: list[dict[str, Any]] | None = None,
) -> Any:
    from atlasent.trust_root import TrustRootKey, TrustRootRevocationEntry, TrustRootSnapshot

    default_keys = [
        TrustRootKey(
            kid="test-key",
            role="R3_audit",
            kty="OKP",
            crv="Ed25519",
            alg="EdDSA",
            x="uCfAGR92U9gKXqMmGs4MCoaTq-LmzoRe_aiwZE6UcnQ",
            valid_from="2026-01-01T00:00:00Z",
            valid_until="2099-01-01T00:00:00Z",
            replaced_by=None,
            revoked=False,
            tenant=None,
        ),
        TrustRootKey(
            kid="permit-kid",
            role="R2_permit",
            kty="OKP",
            crv="Ed25519",
            alg="EdDSA",
            x="uCfAGR92U9gKXqMmGs4MCoaTq-LmzoRe_aiwZE6UcnQ",
            valid_from="2026-01-01T00:00:00Z",
            valid_until="2099-01-01T00:00:00Z",
            replaced_by=None,
            revoked=False,
            tenant=None,
        ),
        TrustRootKey(
            kid="revoked-kid",
            role="R3_audit",
            kty="OKP",
            crv="Ed25519",
            alg="EdDSA",
            x="uCfAGR92U9gKXqMmGs4MCoaTq-LmzoRe_aiwZE6UcnQ",
            valid_from="2026-01-01T00:00:00Z",
            valid_until="2099-01-01T00:00:00Z",
            replaced_by=None,
            revoked=True,
            tenant=None,
        ),
    ]
    return TrustRootSnapshot(
        valid_until=valid_until,
        issued_at=issued_at,
        keys=keys if keys is not None else default_keys,
        revoked_keys=revoked_keys if revoked_keys is not None else [
            TrustRootRevocationEntry(
                kid="revoked-kid",
                role="R3_audit",
                revoked_at="2026-05-01T12:00:00Z",
                reason="test revocation for SDK test vectors",
            )
        ],
        revoked_identities=[],
    )


def _build_trust_root_for_vector(vec: dict[str, Any]) -> Any:
    if "fresh_snapshot" in vec:
        fs = vec["fresh_snapshot"]
        from atlasent.trust_root import TrustRootKey, TrustRootRevocationEntry, TrustRootSnapshot

        raw_keys = fs.get("keys", [])
        keys = [
            TrustRootKey(
                kid=k["kid"],
                role=k["role"],
                kty=k.get("kty", "OKP"),
                crv=k.get("crv", "Ed25519"),
                alg=k.get("alg", "EdDSA"),
                x=k["x"],
                valid_from=k.get("valid_from", "2026-01-01T00:00:00Z"),
                valid_until=k.get("valid_until", "2099-01-01T00:00:00Z"),
                replaced_by=k.get("replaced_by"),
                revoked=k.get("revoked", False),
                tenant=k.get("tenant"),
            )
            for k in raw_keys
        ]
        return TrustRootSnapshot(
            valid_until=fs["valid_until"],
            issued_at=fs.get("issued_at", "2026-01-01T00:00:00Z"),
            keys=keys,
            revoked_keys=[],
            revoked_identities=[],
        )
    if "stale_snapshot" in vec:
        ss = vec["stale_snapshot"]
        return _make_snapshot(
            valid_until=ss["valid_until"],
            issued_at=ss.get("issued_at", "2020-01-01T00:00:00Z"),
        )
    return _make_snapshot()


@pytest.mark.parametrize("name,vec", _load_vectors())
@pytest.mark.skipif(not PUBLIC_PEM, reason="signing-key.pub.pem not present")
@pytest.mark.skipif(not HAS_CRYPTO, reason="cryptography library not available")
def test_vector_sdk_behaviour(name: str, vec: dict[str, Any]) -> None:
    from atlasent.audit_bundle import VerifyKey, verify_audit_bundle
    from atlasent.exceptions import BundleVerificationError

    bundle = vec["bundle"]
    expected = vec["expected"]
    trust_root = _build_trust_root_for_vector(vec)
    options = vec.get("options", {})
    allow_expired = options.get("allow_expired_snapshot", False)

    from cryptography.hazmat.primitives import serialization

    pub_key = serialization.load_pem_public_key(PUBLIC_PEM.encode())
    key = VerifyKey(key_id="pem_0", public_key=pub_key)  # type: ignore[arg-type]
    verify_keys = [key]

    if "throws" in expected:
        with pytest.raises(BundleVerificationError) as exc_info:
            verify_audit_bundle(
                bundle,
                verify_keys,
                trust_root=trust_root,
                allow_expired_snapshot=allow_expired,
            )
        assert exc_info.value.reason == expected["reason"], (
            f"{name}: expected reason={expected['reason']!r}, "
            f"got {exc_info.value.reason!r}"
        )
    else:
        result = verify_audit_bundle(
            bundle,
            verify_keys,
            trust_root=trust_root,
            allow_expired_snapshot=allow_expired,
        )
        assert result.verified == expected["verified"], (
            f"{name}: expected verified={expected['verified']}, "
            f"got {result.verified}"
        )
