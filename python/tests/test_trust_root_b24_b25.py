"""B2.4 + B2.5 targeted tests.

Covers: BundleVerificationError (raise, not return), permit_signing_key_revoked
outcome, half-life / expiry logging.warning once-per-process (ADR-005 D3),
and global trust-root auto-inject into verify_bundle (B2.3 wire-in).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from atlasent.audit_bundle import verify_audit_bundle, verify_bundle
from atlasent.exceptions import (
    AtlaSentDeniedError,
    AtlaSentError,
    BundleVerificationError,
    _normalize_permit_outcome,
)
from atlasent.trust_root import (
    TrustRootManager,
    TrustRootSnapshot,
    _set_global_trust_root_manager_for_tests,
    get_global_trust_root_manager,
)

# ─── Helpers ────────────────────────────────────────────────────────────────────────


def _make_snap(**overrides: Any) -> TrustRootSnapshot:
    defaults: dict[str, Any] = dict(
        valid_until="2099-01-01T00:00:00Z",
        issued_at="2026-01-01T00:00:00Z",
        keys=[],
        revoked_keys=[],
        revoked_identities=[],
    )
    defaults.update(overrides)
    return TrustRootSnapshot(**defaults)


def _expired_snap() -> TrustRootSnapshot:
    return _make_snap(
        valid_until="2020-01-01T00:00:00Z",
        issued_at="2019-01-01T00:00:00Z",
    )


def _half_life_snap() -> TrustRootSnapshot:
    now = datetime.now(timezone.utc)
    return _make_snap(
        issued_at=(now - timedelta(hours=7)).isoformat().replace("+00:00", "Z"),
        valid_until=(now + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
    )


EMPTY_BUNDLE: dict[str, Any] = {
    "export_id": "test",
    "org_id": "org-1",
    "chain_head_hash": "0" * 64,
    "event_count": 0,
    "signed_at": "2026-01-01T00:00:00Z",
    "events": [],
}


# ─── BundleVerificationError class ────────────────────────────────────────────────────


class TestBundleVerificationError:
    def test_message_includes_reason(self) -> None:
        err = BundleVerificationError(bundle_reason="trust_snapshot_expired")
        assert "trust_snapshot_expired" in str(err)

    def test_carries_all_fields(self) -> None:
        err = BundleVerificationError(
            bundle_reason="key_revoked",
            snapshot_valid_until="2020-01-01T00:00:00Z",
            snapshot_fetched_at="2019-01-01T00:00:00Z",
            snapshot_source="pinned",
            kid="kid-abc",
        )
        assert err.bundle_reason == "key_revoked"
        assert err.snapshot_valid_until == "2020-01-01T00:00:00Z"
        assert err.snapshot_fetched_at == "2019-01-01T00:00:00Z"
        assert err.snapshot_source == "pinned"
        assert err.kid == "kid-abc"

    def test_is_instance_of_atlasent_error(self) -> None:
        err = BundleVerificationError(bundle_reason="key_role_mismatch")
        assert isinstance(err, Exception)
        assert isinstance(err, AtlaSentError)
        assert isinstance(err, BundleVerificationError)


# ─── permit_signing_key_revoked outcome ───────────────────────────────────────────────


class TestPermitSigningKeyRevoked:
    def test_normalize_recognises_new_outcome(self) -> None:
        assert (
            _normalize_permit_outcome("permit_signing_key_revoked")
            == "permit_signing_key_revoked"
        )

    def test_normalize_returns_none_for_unknown(self) -> None:
        assert _normalize_permit_outcome("unknown_outcome") is None
        assert _normalize_permit_outcome("") is None
        assert _normalize_permit_outcome(None) is None

    def test_is_signing_key_revoked_true(self) -> None:
        err = AtlaSentDeniedError(
            evaluation_id="eval-1",
            outcome="permit_signing_key_revoked",
        )
        assert err.is_signing_key_revoked is True
        assert err.is_revoked is False
        assert err.is_expired is False
        assert err.is_consumed is False

    def test_is_signing_key_revoked_false_for_other_outcomes(self) -> None:
        err = AtlaSentDeniedError(evaluation_id="eval-2", outcome="permit_revoked")
        assert err.is_signing_key_revoked is False

    def test_is_signing_key_revoked_false_when_no_outcome(self) -> None:
        err = AtlaSentDeniedError(evaluation_id="eval-3")
        assert err.is_signing_key_revoked is False


# ─── check_expiry once-per-process warnings (ADR-005 D3) ─────────────────────────────


class TestCheckExpiryWarnings:
    def setup_method(self) -> None:
        # Also resets _half_life_warning_emitted / _expired_warning_emitted
        _set_global_trust_root_manager_for_tests(None)

    def teardown_method(self) -> None:
        _set_global_trust_root_manager_for_tests(None)

    def test_emits_warning_on_expired(self, caplog: pytest.LogCaptureFixture) -> None:
        mgr = TrustRootManager(_expired_snap(), disable_refresh=True)
        with caplog.at_level(logging.WARNING, logger="atlasent.trust_root"):
            result = mgr.check_expiry()
        assert result == "expired"
        assert any("expired" in r.message for r in caplog.records)

    def test_expired_warning_emitted_only_once(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        mgr = TrustRootManager(_expired_snap(), disable_refresh=True)
        with caplog.at_level(logging.WARNING, logger="atlasent.trust_root"):
            mgr.check_expiry()
            mgr.check_expiry()
            mgr.check_expiry()
        expiry_warnings = [r for r in caplog.records if "expired" in r.message]
        assert len(expiry_warnings) == 1

    def test_emits_warning_at_half_life(self, caplog: pytest.LogCaptureFixture) -> None:
        mgr = TrustRootManager(_half_life_snap(), disable_refresh=True)
        with caplog.at_level(logging.WARNING, logger="atlasent.trust_root"):
            result = mgr.check_expiry()
        assert result == "half_life"
        assert any("half-life" in r.message for r in caplog.records)

    def test_half_life_warning_emitted_only_once(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        mgr = TrustRootManager(_half_life_snap(), disable_refresh=True)
        with caplog.at_level(logging.WARNING, logger="atlasent.trust_root"):
            mgr.check_expiry()
            mgr.check_expiry()
        half_life_warnings = [r for r in caplog.records if "half-life" in r.message]
        assert len(half_life_warnings) == 1

    def test_no_warning_when_fresh(self, caplog: pytest.LogCaptureFixture) -> None:
        mgr = TrustRootManager(_make_snap(), disable_refresh=True)
        with caplog.at_level(logging.WARNING, logger="atlasent.trust_root"):
            mgr.check_expiry()
        assert len(caplog.records) == 0

    def test_reset_allows_second_warning(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        mgr = TrustRootManager(_expired_snap(), disable_refresh=True)
        with caplog.at_level(logging.WARNING, logger="atlasent.trust_root"):
            mgr.check_expiry()  # first warning
            _set_global_trust_root_manager_for_tests(None)  # reset flags
            mgr.check_expiry()  # second warning
        expiry_warnings = [r for r in caplog.records if "expired" in r.message]
        assert len(expiry_warnings) == 2


# ─── verify_audit_bundle fail-closed expiry ───────────────────────────────────────────


class TestVerifyAuditBundleFailClosed:
    def test_raises_bundle_verification_error_on_expired_snapshot(self) -> None:
        with pytest.raises(BundleVerificationError) as exc_info:
            verify_audit_bundle(EMPTY_BUNDLE, [], trust_root=_expired_snap())
        assert exc_info.value.reason == "trust_snapshot_expired"
        assert exc_info.value.snapshot_valid_until == "2020-01-01T00:00:00Z"

    def test_error_is_instance_of_bundle_verification_error(self) -> None:
        with pytest.raises(BundleVerificationError):
            verify_audit_bundle(EMPTY_BUNDLE, [], trust_root=_expired_snap())

    def test_does_not_raise_when_allow_expired(self) -> None:
        result = verify_audit_bundle(
            EMPTY_BUNDLE, [], trust_root=_expired_snap(), allow_expired_snapshot=True
        )
        assert result is not None  # no raise; verification proceeds normally

    def test_does_not_raise_for_valid_snapshot(self) -> None:
        result = verify_audit_bundle(EMPTY_BUNDLE, [], trust_root=_make_snap())
        assert result is not None


# ─── verify_bundle → global trust-root auto-inject (B2.3) ─────────────────────────────


class TestVerifyBundleGlobalAutoInject:
    def setup_method(self) -> None:
        _set_global_trust_root_manager_for_tests(None)

    def teardown_method(self) -> None:
        _set_global_trust_root_manager_for_tests(None)

    def test_picks_up_expired_global_manager_and_raises(self, tmp_path: Path) -> None:
        expired_mgr = TrustRootManager(_expired_snap(), disable_refresh=True)
        _set_global_trust_root_manager_for_tests(expired_mgr)

        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(EMPTY_BUNDLE))

        with pytest.raises(BundleVerificationError) as exc_info:
            verify_bundle(bundle_file)
        assert exc_info.value.reason == "trust_snapshot_expired"

    def test_explicit_trust_root_overrides_global(self, tmp_path: Path) -> None:
        # Global is expired, but explicit trust_root is valid — no raise expected
        expired_mgr = TrustRootManager(_expired_snap(), disable_refresh=True)
        _set_global_trust_root_manager_for_tests(expired_mgr)

        bundle_file = tmp_path / "bundle.json"
        bundle_file.write_text(json.dumps(EMPTY_BUNDLE))

        result = verify_bundle(bundle_file, trust_root=_make_snap())
        assert result is not None  # no raise

    def test_global_manager_lazy_init(self) -> None:
        mgr = get_global_trust_root_manager(disable_refresh=True)
        assert mgr is not None
        assert mgr.get_snapshot().valid_until
