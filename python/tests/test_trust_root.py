"""TrustRootManager unit tests + trust-root vector suite.

Covers ADR-005 D2 (refresh scheduling), D3 (fail-closed expiry),
and D4 (revocation + role checks).  The test vectors in
contract/vectors/trust-root/ are shared with the TypeScript SDK.

Note: B2.4 changed verify_audit_bundle to RAISE BundleVerificationError
on expiry/revocation/role-mismatch instead of returning a falsy result.
The vector tests below assert that behaviour.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from atlasent.exceptions import BundleVerificationError
from atlasent.trust_root import (
    TrustRootKey,
    TrustRootManager,
    TrustRootRevocationEntry,
    TrustRootSnapshot,
    _set_global_trust_root_manager_for_tests,
    get_global_trust_root_manager,
)
from atlasent.audit_bundle import VerifyKey, verify_audit_bundle

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS_DIR = REPO_ROOT / "contract" / "vectors" / "trust-root"
FIXTURES_DIR = REPO_ROOT / "contract" / "vectors" / "audit-bundles"
PUBLIC_PEM = (FIXTURES_DIR / "signing-key.pub.pem").read_text() if FIXTURES_DIR.exists() else ""

try:
    from atlasent.audit_bundle import _require_crypto
    _require_crypto()
    _CRYPTO_OK = True
except BaseException:
    _CRYPTO_OK = False

pytestmark = pytest.mark.skipif(
    not FIXTURES_DIR.exists() or not _CRYPTO_OK,
    reason="contract/vectors/audit-bundles/ not present or cryptography unavailable",
)


# ─── Helpers ────────────────────────────────────────────────────────────────────────

def _make_snapshot(**overrides: Any) -> TrustRootSnapshot:
    defaults = dict(
        valid_until="2099-01-01T00:00:00Z",
        issued_at="2026-01-01T00:00:00Z",
        keys=[
            TrustRootKey(kid="test-key", role="R3_audit", kty="OKP", alg="EdDSA",
                         crv="Ed25519", x="uCfAGR92U9gKXqMmGs4MCoaTq-LmzoRe_aiwZE6UcnQ"),
            TrustRootKey(kid="permit-kid", role="R2_permit", kty="OKP", alg="EdDSA",
                         crv="Ed25519", x="uCfAGR92U9gKXqMmGs4MCoaTq-LmzoRe_aiwZE6UcnQ"),
            TrustRootKey(kid="revoked-kid", role="R3_audit", kty="OKP", alg="EdDSA",
                         crv="Ed25519", x="uCfAGR92U9gKXqMmGs4MCoaTq-LmzoRe_aiwZE6UcnQ",
                         revoked=True),
        ],
        revoked_keys=[
            TrustRootRevocationEntry(kid="revoked-kid", revoked_at="2026-05-01T12:00:00Z",
                                     role="R3_audit", reason="test revocation for SDK test vectors"),
        ],
        revoked_identities=[],
    )
    defaults.update(overrides)
    return TrustRootSnapshot(**defaults)


def _load_vector(filename: str) -> dict:
    line = (VECTORS_DIR / filename).read_text().strip().split("\n")[0]
    return json.loads(line)


def _load_verify_key(pem: str) -> VerifyKey:
    from cryptography.hazmat.primitives import serialization
    key = serialization.load_pem_public_key(pem.encode())
    return VerifyKey(key_id="pem_0", public_key=key)  # type: ignore[arg-type]


# ─── TrustRootManager unit tests ──────────────────────────────────────────────────


def test_get_snapshot_returns_initial() -> None:
    snap = _make_snapshot()
    mgr = TrustRootManager(snap, disable_refresh=True)
    assert mgr.get_snapshot() is snap


def test_check_expiry_ok_for_future_valid_until() -> None:
    mgr = TrustRootManager(_make_snapshot(), disable_refresh=True)
    assert mgr.check_expiry() == "ok"


def test_check_expiry_expired_for_past_valid_until() -> None:
    snap = _make_snapshot(valid_until="2020-01-01T00:00:00Z", issued_at="2019-01-01T00:00:00Z")
    mgr = TrustRootManager(snap, disable_refresh=True)
    assert mgr.check_expiry() == "expired"


def test_check_expiry_half_life_past_midpoint() -> None:
    now = datetime.now(timezone.utc)
    issued = (now - timedelta(days=366)).isoformat().replace("+00:00", "Z")
    until = (now + timedelta(days=364)).isoformat().replace("+00:00", "Z")
    snap = _make_snapshot(issued_at=issued, valid_until=until)
    mgr = TrustRootManager(snap, disable_refresh=True)
    assert mgr.check_expiry() == "half_life"


def test_lookup_key_finds_by_kid() -> None:
    mgr = TrustRootManager(_make_snapshot(), disable_refresh=True)
    k = mgr.lookup_key("test-key")
    assert k is not None
    assert k.role == "R3_audit"


def test_lookup_key_returns_none_for_unknown() -> None:
    mgr = TrustRootManager(_make_snapshot(), disable_refresh=True)
    assert mgr.lookup_key("nonexistent") is None


def test_is_revoked_true_for_revoked_kid() -> None:
    mgr = TrustRootManager(_make_snapshot(), disable_refresh=True)
    assert mgr.is_revoked("revoked-kid") is True


def test_is_revoked_false_for_valid_kid() -> None:
    mgr = TrustRootManager(_make_snapshot(), disable_refresh=True)
    assert mgr.is_revoked("test-key") is False


def test_replace_snapshot_swaps_active_snapshot() -> None:
    mgr = TrustRootManager(_make_snapshot(), disable_refresh=True)
    new_snap = _make_snapshot(valid_until="2030-01-01T00:00:00Z")
    mgr.replace_snapshot(new_snap)
    assert mgr.get_snapshot().valid_until == "2030-01-01T00:00:00Z"


def test_refresh_interval_floor_enforced() -> None:
    # 1-second interval is below 5-minute floor — should clamp silently
    mgr = TrustRootManager(_make_snapshot(), disable_refresh=False,
                            refresh_interval_seconds=1)
    mgr.stop_refresh()


def test_stop_refresh_idempotent() -> None:
    mgr = TrustRootManager(_make_snapshot(), disable_refresh=False)
    mgr.stop_refresh()
    mgr.stop_refresh()  # second call is a no-op


# ─── Refresh behaviour ─────────────────────────────────────────────────────────────────


def test_refresh_silent_on_network_failure() -> None:
    snap = _make_snapshot()
    mgr = TrustRootManager(snap, disable_refresh=True)
    with patch("urllib.request.urlopen", side_effect=OSError("network error")):
        mgr._do_refresh()
    assert mgr.get_snapshot() is snap


def test_refresh_replaces_snapshot_on_success() -> None:
    snap = _make_snapshot()
    mgr = TrustRootManager(snap, disable_refresh=True)

    new_index = {"valid_until": "2030-01-01T00:00:00Z", "issued_at": "2026-06-01T00:00:00Z"}
    new_keys = {"keys": [k.__dict__ for k in snap.keys]}
    new_revoc = {"revoked_keys": [], "revoked_identities": []}

    def mock_urlopen(url: str, timeout: int = 10):  # noqa: ARG001
        resp = MagicMock()
        if "trust-root" in url:
            resp.read.return_value = json.dumps(new_index).encode()
        elif "verifier-keys" in url:
            resp.read.return_value = json.dumps(new_keys).encode()
        else:
            resp.read.return_value = json.dumps(new_revoc).encode()
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    with patch("urllib.request.urlopen", side_effect=mock_urlopen):
        mgr._do_refresh()

    assert mgr.get_snapshot().valid_until == "2030-01-01T00:00:00Z"


# ─── Global manager ───────────────────────────────────────────────────────────────────


def test_get_global_manager_returns_valid_snapshot() -> None:
    _set_global_trust_root_manager_for_tests(None)
    try:
        mgr = get_global_trust_root_manager(disable_refresh=True)
        snap = mgr.get_snapshot()
        assert snap.valid_until
    finally:
        _set_global_trust_root_manager_for_tests(None)


def test_get_global_manager_same_instance_on_repeat() -> None:
    _set_global_trust_root_manager_for_tests(None)
    try:
        a = get_global_trust_root_manager(disable_refresh=True)
        b = get_global_trust_root_manager(disable_refresh=True)
        assert a is b
    finally:
        _set_global_trust_root_manager_for_tests(None)


# ─── Trust-root vector suite (B2.4: raises BundleVerificationError) ──────────────────


def test_vector_revoked_kid() -> None:
    vec = _load_vector("bundle_revoked_kid.jsonl")
    bundle = vec["bundle"]
    trust_root = _make_snapshot()
    key = _load_verify_key(PUBLIC_PEM)

    with pytest.raises(BundleVerificationError) as exc_info:
        verify_audit_bundle(bundle, [key], trust_root=trust_root)
    assert exc_info.value.reason == "key_revoked"


def test_vector_expired_snapshot() -> None:
    vec = _load_vector("bundle_expired_snapshot.jsonl")
    bundle = vec["bundle"]
    stale = vec["stale_snapshot"]
    trust_root = _make_snapshot(
        valid_until=stale["valid_until"], issued_at=stale["issued_at"]
    )
    key = _load_verify_key(PUBLIC_PEM)

    with pytest.raises(BundleVerificationError) as exc_info:
        verify_audit_bundle(bundle, [key], trust_root=trust_root)
    assert exc_info.value.reason == "trust_snapshot_expired"


def test_vector_allow_expired() -> None:
    vec = _load_vector("bundle_allow_expired.jsonl")
    bundle = vec["bundle"]
    stale = vec["stale_snapshot"]
    trust_root = _make_snapshot(
        valid_until=stale["valid_until"], issued_at=stale["issued_at"]
    )
    key = _load_verify_key(PUBLIC_PEM)

    r = verify_audit_bundle(bundle, [key], trust_root=trust_root, allow_expired_snapshot=True)
    assert r.verified


def test_vector_role_mismatch() -> None:
    vec = _load_vector("bundle_role_mismatch.jsonl")
    bundle = vec["bundle"]
    trust_root = _make_snapshot()
    key = _load_verify_key(PUBLIC_PEM)

    with pytest.raises(BundleVerificationError) as exc_info:
        verify_audit_bundle(bundle, [key], trust_root=trust_root)
    assert exc_info.value.reason == "key_role_mismatch"
