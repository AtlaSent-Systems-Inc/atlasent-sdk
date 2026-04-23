"""Tests for atlasent.audit.verify_bundle."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from atlasent.audit import verify_bundle
from atlasent.exceptions import AtlaSentError

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

cryptography = pytest.importorskip(
    "cryptography",
    reason="cryptography package required for audit tests",
)


def _make_bundle(events: list[dict], *, tamper: bool = False) -> dict:
    """Generate a signed bundle using a fresh Ed25519 key pair."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    pub_bytes = public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)

    canonical = json.dumps(events, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )
    if tamper:
        canonical = canonical + b"x"

    sig_bytes = private_key.sign(canonical)

    return {
        "version": "1",
        "events": events,
        "public_key": pub_bytes.hex(),
        "signature": sig_bytes.hex(),
    }


def _write_bundle(bundle: dict) -> Path:
    f = tempfile.NamedTemporaryFile(
        mode="w", suffix=".bundle.json", delete=False
    )
    json.dump(bundle, f)
    f.close()
    return Path(f.name)


EVENTS = [
    {
        "event_id": "evt_001",
        "action": "modify_patient_record",
        "actor_id": "agent-1",
        "timestamp": "2025-01-15T12:00:00Z",
        "decision_id": "dec_abc",
        "permitted": True,
        "audit_hash": "h_001",
    },
    {
        "event_id": "evt_002",
        "action": "read_phi",
        "actor_id": "agent-2",
        "timestamp": "2025-01-15T12:01:00Z",
        "decision_id": "dec_def",
        "permitted": True,
        "audit_hash": "h_002",
    },
]


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestVerifyBundleValid:
    def test_valid_bundle_returns_true(self):
        bundle = _make_bundle(EVENTS)
        path = _write_bundle(bundle)
        result = verify_bundle(path)
        assert result.valid is True
        assert result.event_count == 2
        assert result.error == ""
        assert result.public_key == bundle["public_key"]

    def test_single_event_bundle(self):
        bundle = _make_bundle(EVENTS[:1])
        path = _write_bundle(bundle)
        result = verify_bundle(path)
        assert result.valid is True
        assert result.event_count == 1

    def test_empty_event_list(self):
        bundle = _make_bundle([])
        path = _write_bundle(bundle)
        result = verify_bundle(path)
        assert result.valid is True
        assert result.event_count == 0

    def test_path_as_string(self):
        bundle = _make_bundle(EVENTS)
        path = _write_bundle(bundle)
        result = verify_bundle(str(path))
        assert result.valid is True


# ---------------------------------------------------------------------------
# Tampered / invalid bundles
# ---------------------------------------------------------------------------


class TestVerifyBundleInvalid:
    def test_tampered_events_returns_false(self):
        bundle = _make_bundle(EVENTS)
        bundle["events"][0]["permitted"] = False  # tamper
        path = _write_bundle(bundle)
        result = verify_bundle(path)
        assert result.valid is False
        assert result.error != ""

    def test_wrong_signature_returns_false(self):
        bundle = _make_bundle(EVENTS)
        bundle["signature"] = "00" * 64  # wrong sig
        path = _write_bundle(bundle)
        result = verify_bundle(path)
        assert result.valid is False

    def test_wrong_public_key_returns_false(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        bundle = _make_bundle(EVENTS)
        # Replace public key with one from a different key pair
        other_pub = (
            Ed25519PrivateKey.generate()
            .public_key()
            .public_bytes(Encoding.Raw, PublicFormat.Raw)
        )
        bundle["public_key"] = other_pub.hex()
        path = _write_bundle(bundle)
        result = verify_bundle(path)
        assert result.valid is False


# ---------------------------------------------------------------------------
# Error cases
# ---------------------------------------------------------------------------


class TestVerifyBundleErrors:
    def test_missing_file_raises(self):
        with pytest.raises(AtlaSentError) as exc_info:
            verify_bundle("/nonexistent/path/bundle.json")
        assert exc_info.value.code == "bad_request"

    def test_invalid_json_raises(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            f.write("not json {{{")
            path = f.name
        with pytest.raises(AtlaSentError) as exc_info:
            verify_bundle(path)
        assert exc_info.value.code == "bad_response"

    def test_missing_events_field_raises(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump({"public_key": "aa" * 32, "signature": "bb" * 64}, f)
            path = f.name
        with pytest.raises(AtlaSentError):
            verify_bundle(path)

    def test_missing_public_key_raises(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump({"events": [], "signature": "bb" * 64}, f)
            path = f.name
        with pytest.raises(AtlaSentError):
            verify_bundle(path)

    def test_invalid_public_key_hex_returns_false(self):
        bundle = _make_bundle(EVENTS)
        bundle["public_key"] = "not-hex"
        path = _write_bundle(bundle)
        result = verify_bundle(path)
        assert result.valid is False
        assert "hex" in result.error.lower()

    def test_invalid_signature_hex_returns_false(self):
        bundle = _make_bundle(EVENTS)
        bundle["signature"] = "not-hex"
        path = _write_bundle(bundle)
        result = verify_bundle(path)
        assert result.valid is False
        assert "hex" in result.error.lower()
