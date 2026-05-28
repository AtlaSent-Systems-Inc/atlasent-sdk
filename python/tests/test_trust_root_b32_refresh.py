"""B3.2 — Refresh integration test.

Verifies that _do_refresh_inner() against a mock HTTP server updates the
in-memory snapshot: valid_until / keys / revoked_keys all reflect the mock
response, and failures are silent (snapshot preserved).
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from atlasent.trust_root import (
    TrustRootManager,
    TrustRootSnapshot,
    _set_global_trust_root_manager_for_tests,
)


def _make_snap(**overrides) -> TrustRootSnapshot:
    return TrustRootSnapshot(
        valid_until=overrides.get("valid_until", "2026-06-01T00:00:00Z"),
        issued_at=overrides.get("issued_at", "2026-01-01T00:00:00Z"),
        keys=overrides.get("keys", []),
        revoked_keys=overrides.get("revoked_keys", []),
        revoked_identities=overrides.get("revoked_identities", []),
    )


class _MockResponse:
    """Minimal context-manager fake for urllib.request.urlopen."""

    def __init__(self, data: dict) -> None:
        self._data = json.dumps(data).encode()

    def read(self) -> bytes:
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


def _make_urlopen_fn(
    valid_until: str = "2030-01-01T00:00:00Z",
    issued_at: str = "2026-01-01T00:00:00Z",
    keys: list | None = None,
    revoked_keys: list | None = None,
):
    if keys is None:
        keys = [
            {
                "kid": "refreshed-key",
                "role": "R3_audit",
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "x": "abc",
            }
        ]
    if revoked_keys is None:
        revoked_keys = []

    responses: dict[str, dict] = {
        "atlasent-trust-root.json": {"valid_until": valid_until, "issued_at": issued_at},
        "atlasent-verifier-keys.json": {"keys": keys},
        "atlasent-revocations.json": {"revoked_keys": revoked_keys, "revoked_identities": []},
    }

    def mock_urlopen(url: str, timeout: int = 10):
        last_part = url.split("/")[-1]
        return _MockResponse(responses.get(last_part, {}))

    return mock_urlopen


@pytest.fixture(autouse=True)
def reset_global_manager():
    _set_global_trust_root_manager_for_tests(None)
    yield
    _set_global_trust_root_manager_for_tests(None)


class TestB32RefreshIntegration:
    def test_do_refresh_updates_valid_until(self):
        mgr = TrustRootManager(_make_snap(valid_until="2026-06-01T00:00:00Z"), disable_refresh=True)
        with patch("urllib.request.urlopen", new=_make_urlopen_fn(valid_until="2030-01-01T00:00:00Z")):
            mgr._do_refresh_inner()
        assert mgr.get_snapshot().valid_until == "2030-01-01T00:00:00Z"

    def test_do_refresh_updates_keys(self):
        mgr = TrustRootManager(_make_snap(), disable_refresh=True)
        new_keys = [
            {
                "kid": "new-key",
                "role": "R3_audit",
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "x": "xyz",
            }
        ]
        with patch("urllib.request.urlopen", new=_make_urlopen_fn(keys=new_keys)):
            mgr._do_refresh_inner()
        keys = mgr.get_snapshot().keys
        assert len(keys) == 1
        assert keys[0].kid == "new-key"

    def test_do_refresh_updates_revoked_keys(self):
        mgr = TrustRootManager(_make_snap(), disable_refresh=True)
        revoked = [{"kid": "bad-key", "revoked_at": "2026-01-01T00:00:00Z", "reason": "compromise"}]
        with patch("urllib.request.urlopen", new=_make_urlopen_fn(revoked_keys=revoked)):
            mgr._do_refresh_inner()
        assert mgr.is_revoked("bad-key")

    def test_do_refresh_silent_on_network_error(self):
        original_snap = _make_snap(valid_until="2026-06-01T00:00:00Z")
        mgr = TrustRootManager(original_snap, disable_refresh=True)

        def raise_oserror(url, timeout=10):
            raise OSError("network failure")

        with patch("urllib.request.urlopen", new=raise_oserror):
            mgr._do_refresh()  # wraps _do_refresh_inner in try/except
        assert mgr.get_snapshot().valid_until == "2026-06-01T00:00:00Z"

    def test_do_refresh_silent_on_missing_valid_until(self):
        original_snap = _make_snap(valid_until="2026-06-01T00:00:00Z")
        mgr = TrustRootManager(original_snap, disable_refresh=True)

        responses: dict[str, dict] = {
            "atlasent-trust-root.json": {},  # missing valid_until — early return
            "atlasent-verifier-keys.json": {"keys": []},
            "atlasent-revocations.json": {"revoked_keys": [], "revoked_identities": []},
        }

        def mock_urlopen(url: str, timeout: int = 10):
            last_part = url.split("/")[-1]
            return _MockResponse(responses.get(last_part, {}))

        with patch("urllib.request.urlopen", new=mock_urlopen):
            mgr._do_refresh_inner()
        # Snapshot unchanged (missing valid_until causes early return)
        assert mgr.get_snapshot().valid_until == "2026-06-01T00:00:00Z"
