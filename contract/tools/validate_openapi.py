#!/usr/bin/env python3
"""Validate contract/openapi.yaml.

Two jobs:

1. **Parse + spec-validate** the file against OpenAPI 3.1 using
   ``openapi-spec-validator`` when available. If the library isn't
   installed, fall back to structural checks (YAML parses, required
   top-level keys present). The fallback keeps the tool useful in
   minimal environments; CI installs the full validator.

2. **Contract-sync check** — assert the OpenAPI schemas under
   ``components.schemas`` stay in sync with ``contract/schemas/*.json``.
   The JSON Schemas are the canonical source of truth for the SDK
   drift detector; if the OpenAPI doc drifts from them, downstream
   consumers (pydantic codegen, @atlasent/types, adopters) see the
   wrong shapes.

Exits 0 on success, 1 on failure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

CONTRACT_ROOT = Path(__file__).resolve().parent.parent
OPENAPI_PATH = CONTRACT_ROOT / "openapi.yaml"
SCHEMAS_DIR = CONTRACT_ROOT / "schemas"

# Map the OpenAPI component schema name to the JSON Schema file name
# whose contents it must mirror. When adding a new endpoint, add the
# new schema JSON under contract/schemas/ AND its OpenAPI mirror here.
SCHEMA_SYNC: dict[str, str] = {
    "EvaluateRequest": "evaluate-request.schema.json",
    "EvaluateResponse": "evaluate-response.schema.json",
    "VerifyPermitRequest": "verify-permit-request.schema.json",
    "VerifyPermitResponse": "verify-permit-response.schema.json",
    "ErrorResponse": "error-response.schema.json",
}

# Field-level keys we require to match between the two representations.
# Keep minimal — description text is hand-maintained in both files and
# diverges on purpose when the OpenAPI prose adds API-level context.
COMPARED_KEYS = {"type", "required", "additionalProperties"}


def _load_yaml(path: Path) -> dict[str, Any]:
    try:
        import yaml  # noqa: PLC0415
    except ImportError:
        print(
            "error: PyYAML is required. "
            "Install via `pip install -r contract/requirements.txt`.",
            file=sys.stderr,
        )
        sys.exit(2)
    with path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _spec_validate(doc: dict[str, Any]) -> list[str]:
    """Run openapi-spec-validator if present, else fall back to
    structural checks. Returns a list of human-readable errors; empty
    list means the doc is valid.
    """
    errors: list[str] = []
    try:
        from openapi_spec_validator import validate  # noqa: PLC0415
    except ImportError:
        # Fallback: require top-level keys that any OpenAPI 3.x doc
        # MUST have. Good enough to catch the kind of typos a human
        # would make; the real validation runs in CI with the library
        # installed.
        for key in ("openapi", "info", "paths"):
            if key not in doc:
                errors.append(f"missing top-level key: {key!r}")
        openapi_ver = doc.get("openapi", "")
        if not isinstance(openapi_ver, str) or not openapi_ver.startswith("3."):
            errors.append(
                f"openapi field must be a 3.x version string, got {openapi_ver!r}"
            )
        return errors

    try:
        validate(doc)
    except Exception as exc:  # noqa: BLE001 — library exposes many subclasses
        errors.append(str(exc))
    return errors


def _check_schema_sync(doc: dict[str, Any]) -> list[str]:
    """Assert components.schemas mirror contract/schemas/*.json on the
    comparison keys defined above."""
    errors: list[str] = []
    components = doc.get("components", {})
    oas_schemas = components.get("schemas", {})

    for oas_name, json_filename in SCHEMA_SYNC.items():
        oas = oas_schemas.get(oas_name)
        if oas is None:
            errors.append(f"{oas_name}: missing from components.schemas")
            continue
        json_path = SCHEMAS_DIR / json_filename
        if not json_path.exists():
            errors.append(
                f"{oas_name}: referenced JSON Schema {json_filename} not found"
            )
            continue
        with json_path.open("r", encoding="utf-8") as fh:
            js = json.load(fh)

        # Top-level comparisons.
        for key in COMPARED_KEYS:
            if oas.get(key) != js.get(key):
                errors.append(
                    f"{oas_name}.{key}: OpenAPI has {oas.get(key)!r}, "
                    f"JSON Schema has {js.get(key)!r}"
                )

        # Required property sets must match exactly (order-insensitive).
        oas_req = set(oas.get("required", []))
        js_req = set(js.get("required", []))
        if oas_req != js_req:
            missing = js_req - oas_req
            extra = oas_req - js_req
            details: list[str] = []
            if missing:
                details.append(f"missing from OpenAPI: {sorted(missing)}")
            if extra:
                details.append(f"extra in OpenAPI: {sorted(extra)}")
            errors.append(f"{oas_name}.required mismatch ({'; '.join(details)})")

        # Property name set must match exactly — a missing or extra
        # property is a wire-shape change and should fail CI.
        oas_props = set((oas.get("properties") or {}).keys())
        js_props = set((js.get("properties") or {}).keys())
        if oas_props != js_props:
            missing = js_props - oas_props
            extra = oas_props - js_props
            details = []
            if missing:
                details.append(f"missing from OpenAPI: {sorted(missing)}")
            if extra:
                details.append(f"extra in OpenAPI: {sorted(extra)}")
            errors.append(
                f"{oas_name}.properties mismatch ({'; '.join(details)})"
            )

    return errors


def main() -> int:
    if not OPENAPI_PATH.exists():
        print(f"error: {OPENAPI_PATH} not found", file=sys.stderr)
        return 1

    doc = _load_yaml(OPENAPI_PATH)
    errors: list[str] = []
    errors.extend(_spec_validate(doc))
    errors.extend(_check_schema_sync(doc))

    if errors:
        print(f"OpenAPI validation FAILED with {len(errors)} error(s):")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(
        f"OpenAPI OK: {OPENAPI_PATH.name} valid + in sync with "
        f"{len(SCHEMA_SYNC)} JSON Schema(s)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
