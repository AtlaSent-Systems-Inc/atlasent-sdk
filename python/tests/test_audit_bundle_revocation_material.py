"""ADR-005 revocation must be anchored to the key that ACTUALLY verified the
signature, not to the bundle's unsigned ``signing_key_id`` hint.

Regression for the Codex P1 on atlasent-sdk#519: with both a revoked key and
its successor loaded (the normal state during a rotation window), a bundle
signed by the revoked key but advertising the successor's kid used to verify
-- the revocation check only ever looked at the hint.

Test names mirror typescript/test/audit-bundle-revocation-material.test.ts.
"""

from __future__ import annotations

import json
from base64 import urlsafe_b64encode
from dataclasses import dataclass
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from atlasent.audit_bundle import VerifyKey, signed_bytes_for, verify_audit_bundle
from atlasent.exceptions import BundleVerificationError
from atlasent.trust_root import (
    TrustRootKey,
    TrustRootRevocationEntry,
    TrustRootSnapshot,
)

FIXTURES = (
    Path(__file__).resolve().parents[2] / "contract" / "vectors" / "audit-bundles"
)


def _b64url(b: bytes) -> str:
    return urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


@dataclass
class Signer:
    key_id: str
    x: str
    private: Ed25519PrivateKey
    verify_key: VerifyKey  # with raw material (what _load_keys produces)
    bare_key: VerifyKey  # without raw material (pre-2026-09-13 shape)


def _signer(key_id: str) -> Signer:
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key()
    raw = pub.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return Signer(
        key_id=key_id,
        x=_b64url(raw),
        private=priv,
        verify_key=VerifyKey(key_id=key_id, public_key=pub, public_key_raw=raw),
        bare_key=VerifyKey(key_id=key_id, public_key=pub),
    )


def _base_bundle() -> dict:
    raw = json.loads((FIXTURES / "valid.json").read_text())
    return dict(raw.get("bundle", raw))


def _signed_by(s: Signer, advertised_kid: str) -> dict:
    b = _base_bundle()
    b.pop("signature", None)
    b["signing_key_id"] = advertised_kid
    b["signature"] = _b64url(s.private.sign(signed_bytes_for(b)))
    return b


def _snapshot(live: Signer, revoked: Signer, permit: Signer) -> TrustRootSnapshot:
    def entry(s: Signer, kid: str, role: str, is_revoked: bool) -> TrustRootKey:
        return TrustRootKey(
            kid=kid,
            role=role,
            kty="OKP",
            alg="EdDSA",
            crv="Ed25519",
            x=s.x,
            revoked=is_revoked,
        )

    return TrustRootSnapshot(
        valid_until="2099-01-01T00:00:00Z",
        issued_at="2026-01-01T00:00:00Z",
        keys=[
            entry(live, "v1", "R3_audit", False),
            entry(revoked, "v2-old", "R3_audit", True),
            entry(permit, "permit-kid", "R2_permit", False),
        ],
        revoked_keys=[
            TrustRootRevocationEntry(
                kid="v2-old",
                role="R3_audit",
                revoked_at="2026-09-12T21:06:42Z",
                reason="rotated out",
            )
        ],
        revoked_identities=[],
    )


def test_bundle_signed_by_revoked_key_advertising_live_kid_is_key_revoked() -> None:
    live, revoked, permit = _signer("live"), _signer("revoked"), _signer("permit")
    bundle = _signed_by(revoked, "v1")
    snap = _snapshot(live, revoked, permit)
    for keys in (
        [revoked.verify_key, live.verify_key],
        [live.verify_key, revoked.verify_key],
    ):
        with pytest.raises(BundleVerificationError) as exc:
            verify_audit_bundle(bundle, keys, trust_root=snap)
        assert exc.value.reason == "key_revoked"
        assert exc.value.kid == "v2-old"


def test_bundle_signed_by_live_key_advertising_live_kid_verifies() -> None:
    live, revoked, permit = _signer("live"), _signer("revoked"), _signer("permit")
    bundle = _signed_by(live, "v1")
    r = verify_audit_bundle(
        bundle,
        [revoked.verify_key, live.verify_key],
        trust_root=_snapshot(live, revoked, permit),
    )
    assert r.signature_valid is True
    assert r.matched_key_id == "live"
    assert r.verified is True


def test_bundle_signed_by_permit_role_key_advertising_audit_kid_is_role_mismatch() -> (
    None
):
    live, revoked, permit = _signer("live"), _signer("revoked"), _signer("permit")
    bundle = _signed_by(permit, "v1")
    with pytest.raises(BundleVerificationError) as exc:
        verify_audit_bundle(
            bundle,
            [live.verify_key, permit.verify_key],
            trust_root=_snapshot(live, revoked, permit),
        )
    assert exc.value.reason == "key_role_mismatch"
    assert exc.value.kid == "permit-kid"


def test_advertising_a_revoked_kid_fails_even_when_signed_by_live_key() -> None:
    live, revoked, permit = _signer("live"), _signer("revoked"), _signer("permit")
    bundle = _signed_by(live, "v2-old")
    with pytest.raises(BundleVerificationError) as exc:
        verify_audit_bundle(
            bundle, [live.verify_key], trust_root=_snapshot(live, revoked, permit)
        )
    assert exc.value.reason == "key_revoked"
    assert exc.value.kid == "v2-old"


def test_keys_without_raw_material_fall_back_to_hint_only_check() -> None:
    # Documented limit, pinned: a caller-built VerifyKey with no material
    # gets the pre-fix semantics. Load keys via verify_bundle(public_keys_pem=...)
    # to get material matching.
    live, revoked, permit = _signer("live"), _signer("revoked"), _signer("permit")
    bundle = _signed_by(revoked, "v1")
    r = verify_audit_bundle(
        bundle,
        [revoked.bare_key, live.bare_key],
        trust_root=_snapshot(live, revoked, permit),
    )
    assert r.signature_valid is True
