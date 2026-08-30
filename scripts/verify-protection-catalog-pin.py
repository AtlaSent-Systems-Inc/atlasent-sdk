#!/usr/bin/env python3
"""Verify the SDK's exact canonical Protection Catalog mirror."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]
PIN = json.loads((ROOT / ".atlasent-protection-catalog-pin.json").read_text(encoding="utf-8"))


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    catalog_path = ROOT / PIN["catalog_path"]
    schema_path = ROOT / PIN["schema_path"]
    require(digest(catalog_path) == PIN["catalog_sha256"], "catalog SHA-256 does not match pin")
    require(digest(schema_path) == PIN["schema_sha256"], "schema SHA-256 does not match pin")
    require(PIN["canonical_repository"] == "AtlaSent-Systems-Inc/atlasent", "unexpected canonical source")
    require(len(PIN["canonical_commit"]) == 40, "canonical commit must be a full SHA")

    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    errors = sorted(Draft202012Validator(schema).iter_errors(catalog), key=lambda error: list(error.path))
    if errors:
        rendered = "\n".join(f"{list(error.path)}: {error.message}" for error in errors[:20])
        raise AssertionError(f"vendored catalog violates its canonical schema:\n{rendered}")

    require(len(catalog["actions"]) == 54, "expected 54 canonical actions")
    require(len(catalog["action_packs"]) == 2, "expected 2 Action Packs")
    require(len(catalog["future_capabilities"]) == 15, "expected 15 future capabilities")
    # source_manifest is intentionally reduced to a single entry in this public
    # mirror (see .atlasent-protection-catalog-pin.json's deviation field) —
    # the canonical repo's full manifest is not published here.
    require(len(catalog["generation_provenance"]["source_manifest"]) == 1, "expected 1 source entry")
    for future in catalog["future_capabilities"]:
        require(set(future["flags"].values()) == {False}, f"{future['capability_id']} became available")

    print("SDK Protection Catalog pin valid: exact canonical bytes and safety states preserved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
