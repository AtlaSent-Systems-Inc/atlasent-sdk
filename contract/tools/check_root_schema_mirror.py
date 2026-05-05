#!/usr/bin/env python3
"""Cross-repo schema-mirror check for approval_artifact.v1.

The wire schema is published in two places:

  atlasent-sdk/contract/schemas/approval-artifact.schema.json   (canonical)
  atlasent/schemas/v1_1/approval-artifact.schema.json           (mirror)

Producers (signing services) and verifiers (Deno edge functions in
atlasent-console / atlasent-api) read the same shape. A drift between
the two files is silent — both repos still build, but a producer
written against one schema and a verifier written against the other
will disagree on what fields are required.

This script asserts that the *normative* slice of the two files is
identical: top-level $id is allowed to differ (different host
namespaces), but title, type, required, properties, and additionalProperties
must match byte-for-byte after canonical JSON normalization.

Usage:
  python contract/tools/check_root_schema_mirror.py \\
      --root /path/to/atlasent

Exits 0 on parity, 1 on drift. Designed for cross-repo CI: the
atlasent-sdk repo cannot import files from the atlasent repo at
import time, so we take the path explicitly.

The atlasent-sdk-side test (typescript/test/approval-artifact-vectors.test.ts)
covers schema-against-fixtures drift; this script covers schema-
against-schema drift.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SDK_SCHEMA = REPO_ROOT / "contract" / "schemas" / "approval-artifact.schema.json"

# Fields that may legitimately differ between the two files.
#   $id          — different host namespaces (atlasent.io vs schemas.atlasent.io)
#   description  — wordsmithing across repos; not normative
#   $comment     — JSON Schema's documentation slot; not normative
# Everything else (type, required, properties, additionalProperties,
# enum, const, pattern, minLength/maxLength, items, format) IS
# normative and must agree.
NON_NORMATIVE_KEYS = {"$id", "description", "$comment"}


def canonical_normative_slice(schema: dict) -> dict:
    """Strip non-normative keys + sort recursively for stable diff."""
    out: dict = {}
    for k, v in schema.items():
        if k in NON_NORMATIVE_KEYS:
            continue
        if isinstance(v, dict):
            out[k] = canonical_normative_slice(v)
        else:
            out[k] = v
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        required=True,
        help="Path to a checkout of the atlasent (root) repo.",
    )
    args = parser.parse_args()

    root_schema_path = (
        Path(args.root).resolve()
        / "schemas"
        / "v1_1"
        / "approval-artifact.schema.json"
    )

    if not SDK_SCHEMA.exists():
        print(f"ERROR: SDK schema missing: {SDK_SCHEMA}", file=sys.stderr)
        return 1
    if not root_schema_path.exists():
        print(f"ERROR: root schema missing: {root_schema_path}", file=sys.stderr)
        return 1

    sdk = json.loads(SDK_SCHEMA.read_text(encoding="utf-8"))
    root = json.loads(root_schema_path.read_text(encoding="utf-8"))

    sdk_norm = canonical_normative_slice(sdk)
    root_norm = canonical_normative_slice(root)

    if sdk_norm != root_norm:
        print("DRIFT: approval-artifact schemas differ.", file=sys.stderr)
        print(
            "  sdk:  " + json.dumps(sdk_norm, sort_keys=True, indent=2),
            file=sys.stderr,
        )
        print(
            "  root: " + json.dumps(root_norm, sort_keys=True, indent=2),
            file=sys.stderr,
        )
        return 1

    print(f"OK: {SDK_SCHEMA.relative_to(REPO_ROOT)} == {root_schema_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
