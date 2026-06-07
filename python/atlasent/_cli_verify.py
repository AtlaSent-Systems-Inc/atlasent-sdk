"""CLI entry point for ``atlasent-verify-bundle``."""

from __future__ import annotations

import json
import sys


def main() -> None:
    if len(sys.argv) != 3:
        print(
            "Usage: atlasent-verify-bundle <bundle.json> <keyset.json>",
            file=sys.stderr,
        )
        print(
            "  bundle.json  — evidence bundle exported from /v1-export-audit-stream",
            file=sys.stderr,
        )
        print(
            "  keyset.json  — authority public key set (?pubkey=true on same endpoint)",
            file=sys.stderr,
        )
        sys.exit(2)

    bundle_path, keyset_path = sys.argv[1], sys.argv[2]

    try:
        with open(bundle_path) as f:
            bundle = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read bundle file: {exc}", file=sys.stderr)
        sys.exit(2)

    try:
        with open(keyset_path) as f:
            key_set = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read key set file: {exc}", file=sys.stderr)
        sys.exit(2)

    try:
        from atlasent.evidence_bundle_verifier import (
            BundleVerificationError,
            verify_evidence_bundle,
        )
    except ImportError:
        print(
            "error: the 'cryptography' package is required.\n"
            "       pip install 'atlasent[verify]'",
            file=sys.stderr,
        )
        sys.exit(2)

    try:
        result = verify_evidence_bundle(bundle, key_set)
    except BundleVerificationError as exc:
        print(f"FAIL  {exc}", file=sys.stderr)
        sys.exit(1)

    checks = ",".join(result.checks)
    print(
        f"ok    bundle_id={result.bundle_id!r}  "
        f"key_id={result.key_id!r}  "
        f"records={result.record_count}  "
        f"checks={checks}",
    )


if __name__ == "__main__":
    main()
