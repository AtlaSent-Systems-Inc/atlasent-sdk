#!/usr/bin/env python3
"""Deterministic fixture generator for the evidence-bundle reference verifiers.

Uses the verifier's own canonicalization/hash primitives so fixtures and
verifier can never disagree. Run from the repo root:
    python3 contract/vectors/evidence-bundles/_generate.py
"""
import base64, json, hashlib, copy, sys, os
import importlib.util as _ilu
_vp = os.path.join(os.path.dirname(__file__), "..", "..", "..", "python", "atlasent", "evidence_bundle_verifier.py")
_spec = _ilu.spec_from_file_location("evb_verifier", _vp)
_m = _ilu.module_from_spec(_spec); sys.modules['evb_verifier']=_m; _spec.loader.exec_module(_m)
canonical_json, record_entry_hash, merkle_root_hex = _m.canonical_json, _m.record_entry_hash, _m.merkle_root_hex
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402

OUT = os.path.dirname(__file__)
KEY_ID = "evidence-issuing-2026-06"
SEED = bytes(range(32))  # fixed → reproducible fixtures
sk = Ed25519PrivateKey.from_private_bytes(SEED)
pub_b64 = base64.b64encode(
    sk.public_key().public_bytes_raw()
).decode()

key_set = {"issuing_keys": [{"key_id": KEY_ID, "alg": "Ed25519", "public_key_b64": pub_b64}]}

def build_records():
    raw = [
        {"decision_id": "0190a1b2-0001-7000-8000-000000000001",
         "decision": {"action": "production.deploy", "outcome": "permit", "actor": "agent:ci"}},
        {"decision_id": "0190a1b2-0002-7000-8000-000000000002",
         "decision": {"action": "vendor.payment.release", "outcome": "deny", "actor": "user:ap"}},
        {"decision_id": "0190a1b2-0003-7000-8000-000000000003",
         "decision": {"action": "customer.export", "outcome": "escalate", "actor": "user:dpo"}},
    ]
    records, prev = [], "00" * 32  # genesis prev for the first in-scope record
    for r in raw:
        rec = dict(r)
        rec["prev_hash"] = prev
        rec["entry_hash"] = record_entry_hash(rec)
        records.append(rec)
        prev = rec["entry_hash"]
    return records

def sign(bundle):
    signing_input = {k: v for k, v in bundle.items() if k != "signature"}
    digest = hashlib.sha256(canonical_json(signing_input).encode()).digest()
    return base64.b64encode(sk.sign(digest)).decode()

def base_bundle():
    records = build_records()
    b = {
        "$schema": "https://atlasent.io/schemas/evidence-bundle/v1.json",
        "bundle_id": "0190a1b2-9999-7000-8000-000000000099",
        "bundle_version": "1",
        "issued_at": "2026-06-04T00:00:00Z",
        "issued_by": {"org_id": "0190a1b2-aaaa-7000-8000-0000000000aa",
                      "issuer_kind": "atlasent-api", "issuer_version": "1.0.0"},
        "scope": {"kind": "decision-window", "from": "2026-06-01T00:00:00Z",
                  "to": "2026-06-04T00:00:00Z"},
        "chain_context": {"chain_id": "org-default",
                          "first_entry_hash": records[0]["entry_hash"],
                          "first_prev_hash": records[0]["prev_hash"],
                          "last_entry_hash": records[-1]["entry_hash"],
                          "entry_count": len(records)},
        "records": records,
        "summary_hash": merkle_root_hex([r["entry_hash"] for r in records]),
    }
    b["signature"] = {"alg": "Ed25519", "key_id": KEY_ID,
                      "key_set_url": "https://trust.atlasent.io/keys/evidence-bundles.json",
                      "signature_b64": sign(b)}
    return b

def write(name, obj):
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write("\n")
    print("wrote", name)

valid = base_bundle()
write("key-set.json", key_set)
write("valid-3-records.json", valid)

tampered = copy.deepcopy(valid)
raw = bytearray(base64.b64decode(tampered["signature"]["signature_b64"]))
raw[0] ^= 0x01
tampered["signature"]["signature_b64"] = base64.b64encode(bytes(raw)).decode()
write("tampered-signature.json", tampered)

broken = copy.deepcopy(valid)
broken["records"][1]["prev_hash"] = "ff" * 32  # breaks the link (sig re-signed so only chain fails)
broken["signature"]["signature_b64"] = sign(broken)
write("broken-chain.json", broken)

unknown = copy.deepcopy(valid)
unknown["signature"]["key_id"] = "some-unknown-key"
write("unknown-key.json", unknown)

# Validly-signed but internally-inconsistent bundles (exercise post-signature checks).
anchor = copy.deepcopy(base_bundle())
anchor["chain_context"]["last_entry_hash"] = "ab" * 32
anchor["signature"]["signature_b64"] = sign(anchor)
write("anchor-mismatch.json", anchor)

summary = copy.deepcopy(base_bundle())
summary["summary_hash"] = "cd" * 32
summary["signature"]["signature_b64"] = sign(summary)
write("summary-mismatch.json", summary)

entry = copy.deepcopy(base_bundle())
entry["records"][2]["decision"]["outcome"] = "permit"  # mutate content, keep entry_hash
entry["signature"]["signature_b64"] = sign(entry)
write("entry-tampered.json", entry)
