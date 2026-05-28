"""B3.1 — Bootstrap smoke test.

Verifies that the vendor snapshot loads cleanly:
get_global_trust_root_manager().get_snapshot() returns a snapshot
with a valid_until that parses as an ISO-8601 date, non-empty issued_at,
and lists for keys / revoked_keys / revoked_identities.
No exceptions should be thrown.
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest import mock

import pytest

from atlasent.trust_root import (
    TrustRootManager,
    TrustRootSnapshot,
    _load_vendor_snapshot,
    _set_global_trust_root_manager_for_tests,
    get_global_trust_root_manager,
)


@pytest.fixture(autouse=True)
def reset_global_manager():
    _set_global_trust_root_manager_for_tests(None)
    yield
    _set_global_trust_root_manager_for_tests(None)


class TestB31BootstrapSmoke:
    def test_get_global_trust_root_manager_does_not_raise(self):
        mgr = get_global_trust_root_manager(disable_refresh=True)
        assert mgr is not None

    def test_vendor_snapshot_valid_until_is_parseable(self):
        mgr = get_global_trust_root_manager(disable_refresh=True)
        snap = mgr.get_snapshot()
        assert snap.valid_until
        parsed = datetime.fromisoformat(snap.valid_until.replace("Z", "+00:00"))
        assert isinstance(parsed, datetime)

    def test_vendor_snapshot_issued_at_is_parseable(self):
        mgr = get_global_trust_root_manager(disable_refresh=True)
        snap = mgr.get_snapshot()
        assert snap.issued_at
        parsed = datetime.fromisoformat(snap.issued_at.replace("Z", "+00:00"))
        assert isinstance(parsed, datetime)

    def test_vendor_snapshot_issued_at_is_in_the_past(self):
        mgr = get_global_trust_root_manager(disable_refresh=True)
        snap = mgr.get_snapshot()
        issued_at = datetime.fromisoformat(snap.issued_at.replace("Z", "+00:00"))
        assert issued_at < datetime.now(timezone.utc)

    def test_vendor_snapshot_has_list_fields(self):
        mgr = get_global_trust_root_manager(disable_refresh=True)
        snap = mgr.get_snapshot()
        assert isinstance(snap.keys, list)
        assert isinstance(snap.revoked_keys, list)
        assert isinstance(snap.revoked_identities, list)

    def test_vendor_snapshot_has_at_least_one_key(self):
        mgr = get_global_trust_root_manager(disable_refresh=True)
        snap = mgr.get_snapshot()
        assert len(snap.keys) > 0

    def test_each_key_has_required_fields(self):
        mgr = get_global_trust_root_manager(disable_refresh=True)
        for key in mgr.get_snapshot().keys:
            assert isinstance(key.kid, str)
            assert isinstance(key.role, str)
            assert isinstance(key.kty, str)
            assert isinstance(key.alg, str)

    def test_get_global_trust_root_manager_is_idempotent(self):
        m1 = get_global_trust_root_manager(disable_refresh=True)
        m2 = get_global_trust_root_manager(disable_refresh=True)
        assert m1 is m2
        m1.stop_refresh()

    def test_load_vendor_snapshot_returns_snapshot(self):
        snap = _load_vendor_snapshot()
        assert isinstance(snap, TrustRootSnapshot)
        assert snap.valid_until
        assert snap.issued_at


class TestTrustRootManagerCoverage:
    """Extra coverage for refresh machinery and lookup paths."""

    def setup_method(self):
        _set_global_trust_root_manager_for_tests(None)

    def teardown_method(self):
        _set_global_trust_root_manager_for_tests(None)

    def _make_snap(self) -> TrustRootSnapshot:
        return TrustRootSnapshot(
            valid_until="2099-01-01T00:00:00Z",
            issued_at="2026-01-01T00:00:00Z",
            keys=[],
            revoked_keys=[],
            revoked_identities=[],
        )

    def test_lookup_key_not_found_returns_none(self):
        mgr = TrustRootManager(self._make_snap(), disable_refresh=True)
        assert mgr.lookup_key("does-not-exist") is None

    def test_stop_refresh_cancels_and_clears_timer(self):
        with mock.patch("atlasent.trust_root.threading.Timer") as mock_timer_cls:
            mock_timer = mock.MagicMock()
            mock_timer_cls.return_value = mock_timer
            mgr = TrustRootManager(self._make_snap())
        mgr.stop_refresh()
        mock_timer.cancel.assert_called_once()
        assert mgr._timer is None

    def test_do_refresh_and_reschedule_calls_do_refresh_then_schedules(self):
        with mock.patch("atlasent.trust_root.threading.Timer") as mock_timer_cls:
            mock_timer_cls.return_value = mock.MagicMock()
            mgr = TrustRootManager(self._make_snap(), disable_refresh=True)
        with (
            mock.patch.object(mgr, "_do_refresh") as mock_refresh,
            mock.patch.object(mgr, "_schedule_refresh") as mock_schedule,
        ):
            mgr._do_refresh_and_reschedule()
        mock_refresh.assert_called_once()
        mock_schedule.assert_called_once()

    def test_load_vendor_snapshot_returns_fallback_on_error(self):
        with mock.patch("pathlib.Path.read_text", side_effect=OSError("no file")):
            snap = _load_vendor_snapshot()
        assert snap.valid_until == "2099-01-01T00:00:00Z"
        assert snap.keys == []
