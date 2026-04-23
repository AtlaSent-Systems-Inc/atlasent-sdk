"""Regenerate the audit-bundle contract fixtures.

Produces `contract/vectors/audit-bundles/*.json` — the golden inputs
both SDKs' verifiers consume. The fixtures are checked in; this script
exists so regen stays reproducible.

Reference: `atlasent-api/supabase/functions/v1-audit/verify.ts`. The
canonical envelope is

    { export_id, org_id, chain_head_hash, event_count, signed_at, events }

serialized with V8/Deno's object-insertion-order `JSON.stringify`
(equivalent to Python `json.dumps(..., separators=(",", ":"))` when
the dict is built in that exact key order). Per-event hashes are
`SHA-256(prev_hash || canonicalJSON(payload))` where `canonicalJSON`
sorts object keys at every depth.

Ed25519 signatures are deterministic (RFC 8032), so baking a fixed
seed into the generator yields byte-identical fixtures on rerun.
"""

from __future__ import annotations

import hashlib
import json
from base64 import urlsafe_b64encode
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

# 32 bytes — raw Ed25519 seed. Anything fixed will do; using an obvious
# non-secret string documents that these keys are test-only.
_SEED = b"ATLASENT-TEST-ONLY-SEED-DO-NOT-USE"[:32]


def canonical_json(value: object) -> str:
    """RFC 8785-ish canonical JSON: sorted keys, no whitespace.

    Mirrors `_shared/rules.ts::canonicalJSON` — `None` and non-finite
    numbers both serialize to ``null``; object keys sort lexicographically;
    arrays preserve order.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (
            value != value or value in (float("inf"), float("-inf"))
        ):
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


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def b64url(data: bytes) -> str:
    return urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _envelope_bytes(bundle: dict) -> bytes:
    """Re-serialize envelope with the exact key order the backend signs.

    `v1-audit/index.ts:185` lists the keys as
    `export_id, org_id, chain_head_hash, event_count, signed_at, events`.
    `signedBytesFor` reconstructs the same object and calls JSON.stringify
    — which is byte-equivalent to Python json.dumps with no separators,
    provided the dict preserves insertion order (Python 3.7+ does).
    """
    envelope = {
        "export_id": bundle["export_id"],
        "org_id": bundle["org_id"],
        "chain_head_hash": bundle["chain_head_hash"],
        "event_count": bundle["event_count"],
        "signed_at": bundle["signed_at"],
        "events": bundle["events"],
    }
    return json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def _make_chain(org_id: str) -> list[dict]:
    """Three events whose hashes form a valid chain (prev_hash=0..0 → head)."""
    payloads = [
        {"action": "create", "target": "policy-1"},
        {"action": "publish", "target": "policy-1", "version": 2},
        {"action": "revoke", "target": "permit-abc"},
    ]
    events: list[dict] = []
    prev_hash = "0" * 64
    for i, payload in enumerate(payloads):
        canonical = canonical_json(payload)
        this_hash = sha256_hex(prev_hash + canonical)
        events.append(
            {
                "id": f"evt-{i + 1}",
                "org_id": org_id,
                "sequence": i + 1,
                "type": "policy.event",
                "decision": None,
                "actor_id": "actor-1",
                "resource_type": "policy",
                "resource_id": "policy-1",
                "payload": payload,
                "hash": this_hash,
                "previous_hash": prev_hash,
                "occurred_at": f"2026-04-21T00:00:0{i}.000Z",
                "created_at": f"2026-04-21T00:00:0{i}.000Z",
            }
        )
        prev_hash = this_hash
    return events


def _sign(private_key: Ed25519PrivateKey, envelope_bytes: bytes) -> str:
    return b64url(private_key.sign(envelope_bytes))


def main() -> None:
    out_dir = Path(__file__).resolve().parents[1] / "vectors" / "audit-bundles"
    out_dir.mkdir(parents=True, exist_ok=True)

    private_key = Ed25519PrivateKey.from_private_bytes(_SEED)
    public_key = private_key.public_key()
    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")

    (out_dir / "signing-key.pub.pem").write_text(public_pem)

    # ── valid bundle ──────────────────────────────────────────────
    events = _make_chain("org-1")
    base_bundle = {
        "export_id": "export-1",
        "org_id": "org-1",
        "chain_head_hash": events[-1]["hash"],
        "event_count": len(events),
        "signed_at": "2026-04-21T00:00:00.000Z",
        "events": events,
    }
    signature = _sign(private_key, _envelope_bytes(base_bundle))
    valid = {**base_bundle, "signature": signature, "signing_key_id": "test-key"}
    _write(
        out_dir / "valid.json",
        valid,
        "A chain of three events, signed by the test key; every check passes.",
    )

    # ── tampered-event bundle ─────────────────────────────────────
    tampered_events = [dict(e) for e in events]
    tampered_events[1] = {
        **tampered_events[1],
        "payload": {"action": "publish", "target": "policy-1", "version": 9999},
    }
    tampered = {
        **base_bundle,
        "events": tampered_events,
        "signature": signature,
        "signing_key_id": "test-key",
    }
    _write(
        out_dir / "tampered-event.json",
        tampered,
        "Second event's payload rewritten after signing. Signature still matches the envelope "
        "text that was signed (because we reuse `signature`), so signature_valid=false (envelope "
        "bytes differ) and tampered_event_ids=['evt-2'].",
    )

    # ── bad signature bundle ──────────────────────────────────────
    sig_bytes = bytearray(private_key.sign(_envelope_bytes(base_bundle)))
    sig_bytes[0] ^= 0x01  # flip one bit
    bad_sig = {
        **base_bundle,
        "signature": b64url(bytes(sig_bytes)),
        "signing_key_id": "test-key",
    }
    _write(
        out_dir / "bad-signature.json",
        bad_sig,
        "Valid chain, but the signature has one flipped bit — signature_valid=false, chain_integrity_ok=true.",
    )

    # ── wrong-key bundle (signed by a different keypair) ──────────
    other_private = Ed25519PrivateKey.from_private_bytes(
        b"SECOND-SEED-SAME-LENGTH-32B!!!!!"[:32]
    )
    wrong_key_sig = _sign(other_private, _envelope_bytes(base_bundle))
    wrong_key = {
        **base_bundle,
        "signature": wrong_key_sig,
        "signing_key_id": "unknown-key",
    }
    _write(
        out_dir / "wrong-key.json",
        wrong_key,
        "Signed by a key that isn't in the trust set — signature_valid=false with reason citing the key count.",
    )

    # ── broken-chain bundle ───────────────────────────────────────
    chain_events = [dict(e) for e in events]
    chain_events[1] = {**chain_events[1], "previous_hash": "f" * 64}
    broken = {
        **base_bundle,
        "events": chain_events,
        "signature": signature,
        "signing_key_id": "test-key",
    }
    _write(
        out_dir / "broken-chain.json",
        broken,
        "Second event's previous_hash points at nothing in the chain — adjacency fails, chain_integrity_ok=false.",
    )


def _write(path: Path, bundle: dict, description: str) -> None:
    out = {"description": description, "bundle": bundle}
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
