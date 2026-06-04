"""Reference *builder* for AtlaSent evidence bundles — the producer half that
pairs with ``evidence_bundle_verifier``.

Given record content + an Ed25519 issuing key, assembles a spec §4 bundle
(entry_hash chain, chain_context anchors, RFC 6962 summary_hash) and signs it,
so the reference verifier accepts it. This is a reference / test utility, NOT
the production assembly service — the server-side assembly milestone must
reproduce this exact hashing and sign with a real issuing key whose certificate
chains to a published root (see the key-management runbook). The two stay in
lockstep by reusing the verifier's primitives here.
"""

from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import datetime, timezone
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .evidence_bundle_verifier import canonical_json, merkle_root_hex, record_entry_hash

GENESIS_PREV_HASH = "00" * 32  # 32 zero bytes


def generate_issuing_key(
    key_id: str = "evidence-issuing-test",
) -> tuple[Ed25519PrivateKey, dict[str, Any]]:
    """Generate an Ed25519 issuing key + a single-key key set for it."""
    sk = Ed25519PrivateKey.generate()
    pub_b64 = base64.b64encode(sk.public_key().public_bytes_raw()).decode()
    key_set = {
        "issuing_keys": [
            {"key_id": key_id, "alg": "Ed25519", "public_key_b64": pub_b64}
        ]
    }
    return sk, key_set


def build_evidence_bundle(
    records: list[dict[str, Any]],
    signing_key: Ed25519PrivateKey,
    key_id: str,
    *,
    first_prev_hash: str = GENESIS_PREV_HASH,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble + sign an evidence bundle. The reference verifier accepts it.

    ``records`` are the record contents WITHOUT entry_hash/prev_hash.
    """
    meta = meta or {}
    if not records:
        raise ValueError("build_evidence_bundle: at least one record is required")

    prev = first_prev_hash
    chained: list[dict[str, Any]] = []
    for content in records:
        rec = dict(content)
        rec["prev_hash"] = prev
        rec["entry_hash"] = record_entry_hash(rec)
        chained.append(rec)
        prev = rec["entry_hash"]

    entry_hashes = [r["entry_hash"] for r in chained]
    unsigned: dict[str, Any] = {
        "$schema": "https://atlasent.io/schemas/evidence-bundle/v1.json",
        "bundle_id": meta.get("bundle_id") or str(uuid.uuid4()),
        "bundle_version": "1",
        "issued_at": meta.get("issued_at")
        or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "issued_by": meta.get("issued_by")
        or {"issuer_kind": "atlasent-sdk", "issuer_version": "0"},
        "chain_context": {
            "chain_id": meta.get("chain_id", "org-default"),
            "first_entry_hash": entry_hashes[0],
            "first_prev_hash": first_prev_hash,
            "last_entry_hash": entry_hashes[-1],
            "entry_count": len(chained),
        },
        "records": chained,
        "summary_hash": merkle_root_hex(entry_hashes),
    }
    if meta.get("scope"):
        unsigned["scope"] = meta["scope"]

    digest = hashlib.sha256(canonical_json(unsigned).encode("utf-8")).digest()
    signature_b64 = base64.b64encode(signing_key.sign(digest)).decode()

    return {
        **unsigned,
        "signature": {
            "alg": "Ed25519",
            "key_id": key_id,
            "key_set_url": meta.get(
                "key_set_url", "https://trust.atlasent.io/keys/evidence-bundles.json"
            ),
            "signature_b64": signature_b64,
        },
    }
