#!/usr/bin/env python3
"""Offline verification of an AtlaSent evidence bundle (Python).

Network-free and deterministic. Recomputes every hash, the Merkle summary,
and the Ed25519 signature against a published trust root. Nothing here
contacts AtlaSent — you are checking the math, not taking our word.

Usage:
    pip install 'atlasent[verify]'      # cryptography + stdlib only
    python verify.py [bundle.json] [trust-root.json]

Defaults to the bundle.json and trust-root.json next to this script.
Exit code 0 = PASS (every check passed). Non-zero = FAIL or error.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    bundle_path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "bundle.json"
    keyset_path = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "trust-root.json"

    try:
        from atlasent.evidence_bundle_verifier import (
            BundleVerificationError,
            verify_evidence_bundle,
        )
    except ImportError:
        print(
            "error: the 'atlasent' package with the 'verify' extra is required.\n"
            "       pip install 'atlasent[verify]'",
            file=sys.stderr,
        )
        return 2

    bundle = json.loads(bundle_path.read_text())
    key_set = json.loads(keyset_path.read_text())

    try:
        result = verify_evidence_bundle(bundle, key_set)
    except BundleVerificationError as exc:
        print(f"FAIL  {exc}")
        return 1

    print(
        f"PASS  bundle_id={result.bundle_id}  key_id={result.key_id}  "
        f"records={result.record_count}  checks={','.join(result.checks)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
