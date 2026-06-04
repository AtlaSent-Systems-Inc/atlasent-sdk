"""Offline reference verifier for AtlaSent evidence bundles.

Implements the verification path of
``atlasent-docs/architecture/evidence-bundles-spec.md`` §4–§5 (v1):

  1. Ed25519 signature over ``SHA-256(canonical-JSON, signature omitted)``.
  2. Audit-chain binding (per-record ``entry_hash`` / ``prev_hash`` links and
     the ``chain_context`` anchors).
  3. ``summary_hash`` = RFC 6962 Merkle root over the record ``entry_hash`` leaves.

Offline by design: given a *pinned* key set (the issuing keys' public
components) it needs no network. This is the Python half of the
reference-implementation pair (see ``evidence-bundle-verifier.ts``); the two
MUST stay behaviourally identical and agree byte-for-byte on canonicalization.

Pinned canonicalization decisions (resolving spec ambiguities for v1 — see
spec §4.1 / §5.3 notes added alongside this implementation):

  * Canonical JSON = recursively key-sorted, compact (no insignificant
    whitespace), ASCII content. This is the reference rule; full RFC 8785
    number canonicalization is a documented follow-up — bundles use string /
    integer / boolean scalars only.
  * ``entry_hash`` = ``sha256_hex(canonical(record without entry_hash/prev_hash))``.
  * ``summary_hash`` = RFC 6962 Merkle root (hex) over leaves = the raw bytes
    of each record's ``entry_hash``.
"""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# Stable failure reasons (mirror the TS verifier's BundleVerificationError.reason).
REASON_BAD_FORMAT = "bad_format"
REASON_UNKNOWN_KEY_ID = "unknown_key_id"
REASON_SIGNATURE_INVALID = "signature_invalid"
REASON_CHAIN_BROKEN = "chain_broken"
REASON_CHAIN_ANCHOR_MISMATCH = "chain_anchor_mismatch"
REASON_SUMMARY_HASH_MISMATCH = "summary_hash_mismatch"


class BundleVerificationError(Exception):
    """Raised when a bundle fails verification. ``reason`` is a stable code."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(f"{reason}: {message}")
        self.reason = reason


# ─── Canonicalization + hashing primitives ───────────────────────────────────


def canonical_json(value: Any) -> str:
    """Recursively key-sorted, compact JSON. Byte-identical to the TS twin."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        # json.dumps gives RFC 8259 string escaping; ensure_ascii keeps the
        # byte stream identical to JSON.stringify for ASCII content.
        import json

        return json.dumps(value, ensure_ascii=True)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):  # pragma: no cover - bundles avoid floats in v1
        raise BundleVerificationError(
            REASON_BAD_FORMAT, "floating-point values are not canonicalizable in v1"
        )
    if isinstance(value, Sequence):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, Mapping):
        items = (f"{canonical_json(str(k))}:{canonical_json(value[k])}" for k in sorted(value))
        return "{" + ",".join(items) + "}"
    raise BundleVerificationError(  # pragma: no cover
        REASON_BAD_FORMAT, f"uncanonicalizable type: {type(value).__name__}"
    )


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def record_entry_hash(record: Mapping[str, Any]) -> str:
    """entry_hash = sha256_hex(canonical(record minus entry_hash/prev_hash))."""
    content = {k: v for k, v in record.items() if k not in ("entry_hash", "prev_hash")}
    return sha256_hex(canonical_json(content).encode("utf-8"))


def merkle_root_hex(leaf_hexes: Sequence[str]) -> str:
    """RFC 6962 Merkle root (hex) over the given leaves (each a hex string)."""
    if not leaf_hexes:
        return sha256_hex(b"")
    level = [hashlib.sha256(b"\x00" + bytes.fromhex(h)).digest() for h in leaf_hexes]
    while len(level) > 1:
        nxt: list[bytes] = []
        for i in range(0, len(level), 2):
            if i + 1 < len(level):
                nxt.append(hashlib.sha256(b"\x01" + level[i] + level[i + 1]).digest())
            else:
                nxt.append(level[i])  # odd node promoted
        level = nxt
    return level[0].hex()


# ─── Key set ─────────────────────────────────────────────────────────────────


def _resolve_key(key_set: Mapping[str, Any], key_id: str) -> Ed25519PublicKey:
    for k in key_set.get("issuing_keys", []):
        if k.get("key_id") == key_id:
            if k.get("alg") != "Ed25519":
                raise BundleVerificationError(
                    REASON_SIGNATURE_INVALID, f"unsupported key alg: {k.get('alg')!r}"
                )
            return Ed25519PublicKey.from_public_bytes(base64.b64decode(k["public_key_b64"]))
    raise BundleVerificationError(REASON_UNKNOWN_KEY_ID, f"key_id not in key set: {key_id!r}")


# ─── Verification ────────────────────────────────────────────────────────────


@dataclass
class VerifyResult:
    ok: bool
    bundle_id: str | None = None
    key_id: str | None = None
    record_count: int = 0
    checks: list[str] = field(default_factory=list)


def _require(cond: bool, reason: str, message: str) -> None:
    if not cond:
        raise BundleVerificationError(reason, message)


def verify_evidence_bundle(bundle: Mapping[str, Any], key_set: Mapping[str, Any]) -> VerifyResult:
    """Verify an evidence bundle against a pinned key set.

    Raises ``BundleVerificationError`` on any failure; returns ``VerifyResult``
    on success. There is no partial-validity state (spec §5.3).
    """
    if not isinstance(bundle, Mapping):
        raise BundleVerificationError(REASON_BAD_FORMAT, "bundle is not an object")
    for required in ("records", "chain_context", "summary_hash", "signature"):
        _require(required in bundle, REASON_BAD_FORMAT, f"missing field: {required}")

    sig = bundle["signature"]
    _require(isinstance(sig, Mapping), REASON_BAD_FORMAT, "signature is not an object")
    _require(sig.get("alg") == "Ed25519", REASON_BAD_FORMAT, "unsupported signature alg")
    for required in ("key_id", "signature_b64"):
        _require(required in sig, REASON_BAD_FORMAT, f"missing signature.{required}")

    # 1. Signature over canonical bytes (signature field omitted), SHA-256 then Ed25519.
    pubkey = _resolve_key(key_set, sig["key_id"])
    signing_input = {k: v for k, v in bundle.items() if k != "signature"}
    digest = hashlib.sha256(canonical_json(signing_input).encode("utf-8")).digest()
    try:
        pubkey.verify(base64.b64decode(sig["signature_b64"]), digest)
    except (InvalidSignature, ValueError):
        raise BundleVerificationError(REASON_SIGNATURE_INVALID, "Ed25519 signature did not verify")

    # 2. Chain binding (spec §5.3).
    records = bundle["records"]
    chain = bundle["chain_context"]
    _require(isinstance(records, Sequence) and len(records) > 0, REASON_BAD_FORMAT, "no records")
    _require(
        chain.get("entry_count") == len(records),
        REASON_CHAIN_ANCHOR_MISMATCH,
        "chain_context.entry_count != number of records",
    )
    prev = chain.get("first_prev_hash")
    for i, rec in enumerate(records):
        _require(record_entry_hash(rec) == rec.get("entry_hash"), REASON_CHAIN_BROKEN,
                 f"record[{i}].entry_hash does not match recomputed content hash")
        _require(rec.get("prev_hash") == prev, REASON_CHAIN_BROKEN,
                 f"record[{i}].prev_hash does not link to the prior entry")
        prev = rec.get("entry_hash")
    _require(records[0].get("entry_hash") == chain.get("first_entry_hash"),
             REASON_CHAIN_ANCHOR_MISMATCH, "chain_context.first_entry_hash mismatch")
    _require(records[-1].get("entry_hash") == chain.get("last_entry_hash"),
             REASON_CHAIN_ANCHOR_MISMATCH, "chain_context.last_entry_hash mismatch")

    # 3. summary_hash = RFC 6962 Merkle root over record entry_hash leaves.
    expected_root = merkle_root_hex([r["entry_hash"] for r in records])
    _require(expected_root == bundle["summary_hash"], REASON_SUMMARY_HASH_MISMATCH,
             "recomputed Merkle root does not match summary_hash")

    return VerifyResult(
        ok=True,
        bundle_id=bundle.get("bundle_id"),
        key_id=sig["key_id"],
        record_count=len(records),
        checks=["signature", "chain_binding", "summary_hash"],
    )
