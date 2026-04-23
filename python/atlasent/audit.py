"""Offline audit bundle verifier.

Validates an Ed25519-signed audit export bundle produced by the
AtlaSent API without making any network calls.

Requires the ``cryptography`` package::

    pip install "atlasent[audit]"

Usage::

    from atlasent.audit import verify_bundle

    result = verify_bundle("/path/to/export.bundle.json")
    if result.valid:
        print(f"Bundle OK — {result.event_count} events")
    else:
        print(f"Tampered or wrong key: {result.error}")
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .models import BundleVerifyResult


def verify_bundle(path: str | Path) -> BundleVerifyResult:
    """Verify an Ed25519-signed AtlaSent audit export bundle.

    Reads the bundle at *path*, reconstructs the canonical payload
    (sorted-key JSON of the ``events`` array), and verifies the
    Ed25519 signature in the bundle header.

    Args:
        path: Filesystem path to the ``.bundle.json`` file.

    Returns:
        :class:`BundleVerifyResult` — check ``.valid`` to see whether
        the bundle is intact.

    Raises:
        AtlaSentError: The file is missing, not valid JSON, or lacks
            required fields (``events``, ``public_key``, ``signature``).

    Example::

        result = verify_bundle("export-2024-01-01.bundle.json")
        assert result.valid, f"Audit bundle tampered: {result.error}"
    """
    from .exceptions import AtlaSentError

    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise AtlaSentError(
            f"Cannot read audit bundle at {path}: {exc}",
            code="bad_request",
        ) from exc

    try:
        bundle: dict[str, Any] = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AtlaSentError(
            f"Audit bundle at {path} is not valid JSON: {exc}",
            code="bad_response",
        ) from exc

    for field in ("events", "public_key", "signature"):
        if field not in bundle:
            raise AtlaSentError(
                f"Audit bundle missing required field: {field!r}",
                code="bad_response",
            )

    events: list[Any] = bundle["events"]
    public_key_hex: str = bundle["public_key"]
    signature_hex: str = bundle["signature"]

    # Canonical payload: sorted-key JSON of the events list.
    canonical = json.dumps(events, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )

    valid, error = _ed25519_verify(canonical, public_key_hex, signature_hex)
    return BundleVerifyResult(
        valid=valid,
        event_count=len(events),
        public_key=public_key_hex,
        error=error,
    )


def _ed25519_verify(
    message: bytes, public_key_hex: str, signature_hex: str
) -> tuple[bool, str]:
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:
        return (
            False,
            "cryptography package not installed — run: pip install 'atlasent[audit]'",
        )

    try:
        pub_bytes = bytes.fromhex(public_key_hex)
    except ValueError as exc:
        return False, f"Invalid public_key hex: {exc}"

    try:
        sig_bytes = bytes.fromhex(signature_hex)
    except ValueError as exc:
        return False, f"Invalid signature hex: {exc}"

    try:
        pub_key = Ed25519PublicKey.from_public_bytes(pub_bytes)
        pub_key.verify(sig_bytes, message)
        return True, ""
    except InvalidSignature:
        return False, "Signature verification failed — bundle may be tampered"
    except Exception as exc:  # noqa: BLE001
        return False, f"Verification error: {exc}"
