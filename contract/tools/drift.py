"""Contract drift detector.

Compares each SDK's wire-format shape to the shared contract schemas in
``contract/schemas/``. Fails (exit 1) on mismatch.

What it checks, per endpoint (/v1-evaluate, /v1-verify-permit):
  1. Required request fields declared in the SDK match the schema.
  2. SDK request fields are allowed by the schema (no extras when
     `additionalProperties: false`).
  3. Required response fields declared in the SDK match the schema.

Canonical SDK locations:
  * Python SDK -- ``atlasent-sdk/python/atlasent/models.py`` (this repo).
    Pydantic ``model_fields`` are introspected directly.
  * TypeScript SDK -- ``@atlasent/types/src/index.ts`` in the ``atlasent``
    monorepo (sibling checkout). Override the path via
    ``ATLASENT_TS_TYPES`` if the monorepo lives elsewhere. Fields are
    extracted from the ``interface EvaluateRequest``, ``EvaluateResponse``,
    ``VerifyPermitRequest``, ``VerifyPermitResponse`` declarations.

Run:  ``python contract/tools/drift.py``
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import json

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_DIR = REPO_ROOT / "contract"
SCHEMAS = CONTRACT_DIR / "schemas"
PYTHON_SRC = REPO_ROOT / "python"

DEFAULT_TS_TYPES = REPO_ROOT.parent / "atlasent" / "packages" / "types" / "src" / "index.ts"


# ── schema helpers ────────────────────────────────────────────────────


def _load_schema(name: str) -> dict[str, Any]:
    return json.loads((SCHEMAS / name).read_text())


def _schema_field_sets(schema: dict[str, Any]) -> tuple[set[str], set[str], bool]:
    """Return (required, allowed, additional_properties_allowed)."""
    required = set(schema.get("required", []))
    allowed = set(schema.get("properties", {}).keys())
    extra_ok = schema.get("additionalProperties", True) is not False
    return required, allowed, extra_ok


# ── Python SDK introspection ──────────────────────────────────────────


def _python_sdk_wire_fields() -> dict[str, dict[str, tuple[set[str], set[str]]]]:
    """Return {endpoint: {'request': (required, all), 'response': (required, all)}}."""
    sys.path.insert(0, str(PYTHON_SRC))
    try:
        from atlasent.models import (  # type: ignore[import-not-found]
            EvaluateRequest,
            EvaluateResponse,
            VerifyPermitRequest,
            VerifyPermitResponse,
        )
    finally:
        sys.path.pop(0)

    def _fields(model: type) -> tuple[set[str], set[str]]:
        required: set[str] = set()
        allowed: set[str] = set()
        for name, info in model.model_fields.items():
            allowed.add(name)
            if info.is_required():
                required.add(name)
        return required, allowed

    return {
        "/v1-evaluate": {
            "request": _fields(EvaluateRequest),
            "response": _fields(EvaluateResponse),
        },
        "/v1-verify-permit": {
            "request": _fields(VerifyPermitRequest),
            "response": _fields(VerifyPermitResponse),
        },
    }


# ── TypeScript SDK introspection ──────────────────────────────────────


_INTERFACE_RE = re.compile(
    r"export\s+interface\s+(?P<name>\w+)\s*\{(?P<body>[^}]*)\}",
    re.DOTALL,
)
# Match lines like `  foo: Type;`, `  foo?: Type;`, with optional leading
# comment/doc prefix. Skip `//` comments.
_FIELD_RE = re.compile(
    r"(?m)^\s*(?P<name>[a-z_][a-z0-9_]*)\s*(?P<optional>\??)\s*:",
)


def _ts_interface_fields(src: str, name: str) -> tuple[set[str], set[str]]:
    for m in _INTERFACE_RE.finditer(src):
        if m.group("name") != name:
            continue
        body = m.group("body")
        # Strip line comments.
        body = re.sub(r"(?m)^\s*//.*$", "", body)
        required: set[str] = set()
        allowed: set[str] = set()
        for fm in _FIELD_RE.finditer(body):
            fname = fm.group("name")
            allowed.add(fname)
            if fm.group("optional") != "?":
                required.add(fname)
        return required, allowed
    raise RuntimeError(f"Could not find `export interface {name}` in TS types source")


def _typescript_sdk_wire_fields(
    path: Path,
) -> dict[str, dict[str, tuple[set[str], set[str]]]]:
    if not path.exists():
        raise FileNotFoundError(
            f"@atlasent/types source not found at {path}. "
            "Check out the `atlasent` monorepo next to `atlasent-sdk`, or set ATLASENT_TS_TYPES."
        )
    src = path.read_text()
    return {
        "/v1-evaluate": {
            "request": _ts_interface_fields(src, "EvaluateRequest"),
            "response": _ts_interface_fields(src, "EvaluateResponse"),
        },
        "/v1-verify-permit": {
            "request": _ts_interface_fields(src, "VerifyPermitRequest"),
            "response": _ts_interface_fields(src, "VerifyPermitResponse"),
        },
    }


# ── drift check ───────────────────────────────────────────────────────


@dataclass
class DriftReport:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def fail(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    @property
    def ok(self) -> bool:
        return not self.errors


def _compare(
    sdk: str,
    endpoint: str,
    direction: str,
    sdk_required: set[str],
    sdk_allowed: set[str],
    schema: dict[str, Any],
    report: DriftReport,
) -> None:
    schema_required, schema_allowed, extras_allowed = _schema_field_sets(schema)
    missing_required = schema_required - sdk_required
    extra_required = sdk_required - schema_required
    unknown = sdk_allowed - schema_allowed

    if missing_required:
        report.fail(
            f"[{sdk}] {endpoint} {direction}: SDK does not require schema-required "
            f"fields {sorted(missing_required)}"
        )
    if extra_required:
        report.fail(
            f"[{sdk}] {endpoint} {direction}: SDK requires fields not marked required "
            f"in schema: {sorted(extra_required)}"
        )
    if unknown and not extras_allowed:
        report.fail(
            f"[{sdk}] {endpoint} {direction}: SDK declares fields {sorted(unknown)} "
            f"not allowed by schema (additionalProperties: false)"
        )
    elif unknown:
        report.warn(
            f"[{sdk}] {endpoint} {direction}: extra fields {sorted(unknown)} "
            f"(schema allows additionalProperties)"
        )


def run() -> DriftReport:
    report = DriftReport()

    schemas = {
        "/v1-evaluate": {
            "request": _load_schema("evaluate-request.schema.json"),
            "response": _load_schema("evaluate-response.schema.json"),
        },
        "/v1-verify-permit": {
            "request": _load_schema("verify-permit-request.schema.json"),
            "response": _load_schema("verify-permit-response.schema.json"),
        },
    }

    ts_path = Path(os.environ.get("ATLASENT_TS_TYPES") or DEFAULT_TS_TYPES)

    sdks: list[tuple[str, Any]] = [
        ("python", _python_sdk_wire_fields),
        ("typescript", lambda: _typescript_sdk_wire_fields(ts_path)),
    ]

    for sdk_name, getter in sdks:
        try:
            sdk_wire = getter()
        except FileNotFoundError as exc:
            # TS types checkout is optional for Python-only CI.
            report.warn(f"[{sdk_name}] introspection skipped: {exc}")
            continue
        except Exception as exc:
            report.fail(f"[{sdk_name}] introspection failed: {exc}")
            continue
        for endpoint, per_direction in sdk_wire.items():
            for direction in ("request", "response"):
                sdk_required, sdk_allowed = per_direction[direction]
                _compare(
                    sdk_name,
                    endpoint,
                    direction,
                    sdk_required,
                    sdk_allowed,
                    schemas[endpoint][direction],
                    report,
                )

    return report


def main() -> int:
    report = run()
    if report.warnings:
        print("Drift warnings:")
        for w in report.warnings:
            print(f"  ! {w}")
    if report.errors:
        print("Drift errors:")
        for e in report.errors:
            print(f"  x {e}")
        print(f"\nDRIFT DETECTED ({len(report.errors)} errors)")
        return 1
    print("No drift. All SDK wire shapes match the contract.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
