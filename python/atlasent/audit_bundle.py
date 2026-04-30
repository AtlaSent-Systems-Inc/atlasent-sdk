"""Offline verification for audit export bundles.

Mirrors ``atlasent-api/supabase/functions/v1-audit/verify.ts``. The
reference verifier is the source of truth; this file must stay
byte-identical with it on the canonicalization + signing path so a
bundle that verifies in the backend verifies here (and vice versa).

Public entry point:

    from atlasent import verify_bundle
    result = verify_bundle("export.json", public_keys_pem=[pem])

``public_keys_pem`` takes one or more SPKI-PEM strings — the active
set from ``GET /v1-signing-keys``. When omitted, verification still
runs the chain integrity check but ``signature_valid`` is False with
a descriptive ``reason``.
"""

from __future__ import annotations

import hashlib
import json
from base64 import urlsafe_b64decode
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def _require_crypto():  # type: ignore[return]
    """Import cryptography at call-time; raise a clear error if absent."""
    try:
        from cryptography.exceptions import InvalidSignature  # noqa: PLC0415
        from cryptography.hazmat.primitives import serialization  # noqa: PLC0415
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (  # noqa: PLC0415
            Ed25519PublicKey,
        )
        return InvalidSignature, serialization, Ed25519PublicKey
    except ImportError as exc:
        raise ImportError(
            "atlasent[verify] is required for audit-bundle verification. "
            "Install it with: pip install 'atlasent[verify]'"
        ) from exc

GENESIS_HASH = "0" * 64


@dataclass
class VerifyKey:
    """A public key the verifier will try, tagged with its registry id."""

    key_id: str
    public_key: Ed25519PublicKey


@dataclass
class BundleVerificationResult:
    """Outcome of verifying an audit export bundle.

    ``chain_integrity_ok`` is the AND of three checks: adjacency (each
    event's ``previous_hash`` equals the prior event's ``hash``),
    per-event hash recomputation from the canonical payload, and
    ``chain_head_hash`` matching the last event's stored hash.
    ``signature_valid`` is independent — a tampered bundle can have a
    valid signature over its original bytes, and vice versa.
    """

    chain_integrity_ok: bool
    signature_valid: bool
    head_hash_matches: bool
    tampered_event_ids: list[str] = field(default_factory=list)
    matched_key_id: str | None = None
    reason: str | None = None

    @property
    def verified(self) -> bool:
        """Convenience: everything passed."""

        return self.chain_integrity_ok and self.signature_valid


# ─── Canonicalization ────────────────────────────────────────────────


def canonical_json(value: Any) -> str:
    """RFC 8785-ish canonical JSON.

    Reproduces ``_shared/rules.ts::canonicalJSON`` byte-for-byte:
      * object keys sorted at every depth
      * no whitespace
      * ``None``, ``NaN``, ``+inf``, ``-inf`` all render as ``null``
      * strings use the same escapes as ``json.dumps`` with
        ``ensure_ascii=False``
    """

    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return json.dumps(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return "null"
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = []
        for k in sorted(value.keys()):
            parts.append(
                json.dumps(k, ensure_ascii=False) + ":" + canonical_json(value[k])
            )
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"cannot canonicalize {type(value).__name__}")


def _sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


# ─── Envelope reconstruction ─────────────────────────────────────────


def signed_bytes_for(bundle: dict) -> bytes:
    """Recreate the exact bytes ``handleExport`` signed.

    Key order is load-bearing — must match the object literal in
    ``v1-audit/index.ts::handleExport``. Python dicts preserve
    insertion order since 3.7, so the explicit construction below is
    the same wire output as V8/Deno's ``JSON.stringify``.
    """

    envelope = {
        "export_id": bundle.get("export_id"),
        "org_id": bundle.get("org_id"),
        "chain_head_hash": bundle.get("chain_head_hash"),
        "event_count": bundle.get("event_count"),
        "signed_at": bundle.get("signed_at"),
        "events": bundle.get("events"),
    }
    return json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


# ─── Chain verification ──────────────────────────────────────────────


def _verify_chain(events: list[dict]) -> tuple[bool, list[str]]:
    tampered: list[str] = []
    adjacency_ok = True
    prev_hash = events[0].get("previous_hash", GENESIS_HASH) if events else GENESIS_HASH
    if not isinstance(prev_hash, str):
        prev_hash = GENESIS_HASH

    for i, e in enumerate(events):
        stored_hash = e.get("hash")
        stored_prev = e.get("previous_hash")
        if not isinstance(stored_hash, str) or not isinstance(stored_prev, str):
            tampered.append(str(e.get("id", f"index_{i}")))
            adjacency_ok = False
            continue
        if stored_prev != prev_hash:
            adjacency_ok = False

        canonical = canonical_json(e.get("payload") or {})
        recomputed = _sha256_hex(prev_hash + canonical)
        if recomputed != stored_hash:
            tampered.append(str(e.get("id")))

        prev_hash = stored_hash

    return adjacency_ok, tampered


# ─── Signature verification ──────────────────────────────────────────


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return urlsafe_b64decode(s + pad)


def _load_keys(public_keys_pem: Iterable[str] | None) -> list[VerifyKey]:
    if public_keys_pem is None:
        return []
    _, serialization, Ed25519PublicKey = _require_crypto()
    out: list[VerifyKey] = []
    for i, pem in enumerate(public_keys_pem):
        try:
            key = serialization.load_pem_public_key(pem.encode("utf-8"))
        except ValueError:
            continue
        if isinstance(key, Ed25519PublicKey):
            out.append(VerifyKey(key_id=f"pem_{i}", public_key=key))
    return out


def verify_audit_bundle(
    bundle: dict,
    keys: list[VerifyKey],
) -> BundleVerificationResult:
    """Verify a parsed bundle dict against a set of candidate public keys."""

    events = bundle.get("events") or []
    if not isinstance(events, list):
        events = []

    adjacency_ok, tampered = _verify_chain(events)

    if events and isinstance(events[-1].get("hash"), str):
        last_hash = events[-1]["hash"]
    else:
        last_hash = GENESIS_HASH
    head_hash_matches = bundle.get("chain_head_hash") == last_hash

    chain_integrity_ok = adjacency_ok and not tampered and head_hash_matches

    signature_valid = False
    matched_key_id: str | None = None
    reason: str | None = None

    signature = bundle.get("signature")
    if not keys:
        reason = (
            "no signing keys configured (signing_keys table empty and "
            "ATLASENT_EXPORT_SIGNING_KEY_PUBLIC unset)"
        )
    elif not isinstance(signature, str) or not signature:
        reason = "bundle carries no signature"
    else:
        try:
            sig_bytes = _b64url_decode(signature)
            envelope = signed_bytes_for(bundle)
            hint = (
                bundle.get("signing_key_id")
                if isinstance(bundle.get("signing_key_id"), str)
                else None
            )
            ordered = (
                [k for k in keys if k.key_id == hint]
                + [k for k in keys if k.key_id != hint]
                if hint
                else keys
            )
            InvalidSignature, _, __ = _require_crypto()
            for k in ordered:
                try:
                    k.public_key.verify(sig_bytes, envelope)
                except InvalidSignature:
                    continue
                signature_valid = True
                matched_key_id = k.key_id
                break
            if not signature_valid:
                reason = (
                    f"signature did not verify under any of "
                    f"{len(keys)} configured public key(s)"
                )
        except (ValueError, TypeError) as err:
            reason = f"signature check failed: {err}"

    if not chain_integrity_ok and reason is None:
        if tampered:
            reason = f"hash mismatch for {len(tampered)} event(s)"
        elif not adjacency_ok:
            reason = "chain adjacency broken"
        elif not head_hash_matches:
            reason = "chain_head_hash does not match last event"

    return BundleVerificationResult(
        chain_integrity_ok=chain_integrity_ok,
        signature_valid=signature_valid,
        head_hash_matches=head_hash_matches,
        tampered_event_ids=tampered,
        matched_key_id=matched_key_id,
        reason=reason,
    )


def verify_bundle(
    path: str | Path,
    public_keys_pem: Iterable[str] | None = None,
) -> BundleVerificationResult:
    """Load a JSON bundle from disk and verify it.

    ``public_keys_pem`` is the set of active SPKI-PEM strings from
    ``GET /v1-signing-keys``. When omitted, the chain check still runs
    but ``signature_valid`` is always False (with an explanatory
    ``reason``) — so callers that want a complete offline check MUST
    supply the trust set.
    """

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    # Some fixtures wrap the bundle: {"description": "...", "bundle": {...}}.
    # Both shapes are accepted for developer ergonomics.
    if isinstance(data, dict) and "bundle" in data and isinstance(data["bundle"], dict):
        data = data["bundle"]

    keys = _load_keys(public_keys_pem)
    return verify_audit_bundle(data, keys)
