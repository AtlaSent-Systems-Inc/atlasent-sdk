"""Contract drift detector.

Compares each SDK's wire-format shape to the shared contract schemas
in ``contract/schemas/``. Fails (exit 1) on mismatch.

What it checks, per endpoint:
  v1 (/v1-evaluate, /v1-verify-permit, /v1-api-key-self):
    1. Required request fields match the schema. (Skipped for GET
       endpoints like /v1-api-key-self that have no request body.)
    2. Allowed request fields match the schema (no extras).
    3. Required response fields match the schema.

  v2 (/v2/evaluate:batch, /v2/permits/:id/consume,
       /v2/proofs/:id/verify, /v2/permits:bulk-revoke):
    Same three checks against ``contract/schemas/v2/`` JSON Schemas.

Languages covered:
  * Python SDK: imported directly, pydantic ``model_fields`` + aliases
    are introspected.
  * TypeScript SDK: the body literal and the wire interfaces in
    ``typescript/src/client.ts`` (v1) /
    ``typescript/packages/v2-alpha/src/`` (v2) are parsed with a
    deliberately narrow regex. Any stylistic drift in those files
    will be caught here.

Run:  ``python contract/tools/drift.py``
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_DIR = REPO_ROOT / "contract"
SCHEMAS = CONTRACT_DIR / "schemas"
PYTHON_SRC = REPO_ROOT / "python"
TS_CLIENT = REPO_ROOT / "typescript" / "src" / "client.ts"
TS_V2_CLIENT = REPO_ROOT / "typescript" / "packages" / "v2-alpha" / "src" / "client.ts"
TS_V2_TYPES = REPO_ROOT / "typescript" / "packages" / "v2-alpha" / "src" / "types.ts"
PYTHON_V2_SRC = REPO_ROOT / "python" / "atlasent_v2_alpha"


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


def _python_sdk_wire_fields() -> dict[str, dict[str, set[str]]]:
    """Return {endpoint: {'request_keys': {...}, 'response_keys': {...}}}.

    We import the SDK in-process; the Python SDK is the source of truth
    for what gets serialized (pydantic uses aliases when
    model_dump(by_alias=True)).
    """
    sys.path.insert(0, str(PYTHON_SRC))
    try:
        from atlasent.models import (  # type: ignore[import-not-found]
            ApiKeySelfResult,
            EvaluateRequest,
            EvaluateResult,
            VerifyRequest,
            VerifyResult,
        )
    finally:
        sys.path.pop(0)

    def _aliases(model: type) -> set[str]:
        out: set[str] = set()
        for name, field_info in model.model_fields.items():
            alias = field_info.alias or name
            out.add(alias)
        return out

    # Fields the SDK attaches after parsing the wire (e.g. `rate_limit`
    # is populated from X-RateLimit-* headers, not the body). Drop them
    # before comparing to the JSON-Schema, otherwise they'd show up as
    # "extras that aren't on the wire."
    non_wire = {"rate_limit"}

    def _wire_aliases(model: type) -> set[str]:
        return _aliases(model) - non_wire

    return {
        "/v1-evaluate": {
            "request_keys": _aliases(EvaluateRequest),
            "response_keys": _wire_aliases(EvaluateResult),
        },
        "/v1-verify-permit": {
            "request_keys": _aliases(VerifyRequest),
            "response_keys": _wire_aliases(VerifyResult),
        },
        # GET endpoint — no request body, only a response.
        "/v1-api-key-self": {
            "request_keys": None,
            "response_keys": _wire_aliases(ApiKeySelfResult),
        },
    }


# ── TypeScript SDK introspection ──────────────────────────────────────


# Matches `key:` style AND bare shorthand properties (`key,` / `key\n`)
# in object literals. The shorthand form catches `{ requests, api_key: x }`.
_BODY_KEY_RE = re.compile(r"(?m)^\s*([a-z_][a-z0-9_]*)(?:\s*:|(?=[,\s\n]))")

_INTERFACE_RE = re.compile(
    r"interface\s+(?P<name>\w+)\s*\{(?P<body>[^}]*)\}",
    re.DOTALL,
)
_INTERFACE_FIELD_RE = re.compile(
    r"(?m)^\s*([a-z_][a-z0-9_]*)(\?)?:",
)


def _extract_object_literal(src: str, start: int) -> str:
    """Return the content between the opening `{` at/after `start` and
    its matching `}`. Brace-aware; ignores braces inside strings."""
    i = src.index("{", start)
    depth = 0
    in_str: str | None = None
    out = []
    while i < len(src):
        ch = src[i]
        if in_str:
            out.append(ch)
            if ch == "\\" and i + 1 < len(src):
                out.append(src[i + 1])
                i += 2
                continue
            if ch == in_str:
                in_str = None
        else:
            if ch in ("'", '"', "`"):
                in_str = ch
                out.append(ch)
            elif ch == "{":
                depth += 1
                if depth > 1:
                    out.append(ch)
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return "".join(out)
                out.append(ch)
            else:
                out.append(ch)
        i += 1
    raise RuntimeError("Unterminated object literal")


def _typescript_sdk_wire_fields() -> dict[str, dict[str, set[str]]]:
    if not TS_CLIENT.exists():
        raise FileNotFoundError(f"TypeScript client not found at {TS_CLIENT}")
    src = TS_CLIENT.read_text()

    def _body_keys_in_method(method_name: str) -> set[str]:
        # Find `async <method>(` — case-sensitive — then the FIRST
        # `const body = {` after it.
        m = re.search(rf"async\s+{re.escape(method_name)}\s*\(", src)
        if not m:
            raise RuntimeError(f"Could not locate method '{method_name}' in client.ts")
        body_marker = src.find("const body", m.end())
        if body_marker == -1:
            raise RuntimeError(f"No `const body = {{...}}` in method '{method_name}'")
        literal = _extract_object_literal(src, body_marker)
        return set(_BODY_KEY_RE.findall(literal))

    def _wire_interface_keys(name: str) -> set[str]:
        for m in _INTERFACE_RE.finditer(src):
            if m.group("name") == name:
                return {
                    match[0] for match in _INTERFACE_FIELD_RE.findall(m.group("body"))
                }
        raise RuntimeError(f"Could not locate interface '{name}' in client.ts")

    return {
        "/v1-evaluate": {
            "request_keys": _body_keys_in_method("evaluate"),
            "response_keys": _wire_interface_keys("EvaluateWire"),
        },
        "/v1-verify-permit": {
            "request_keys": _body_keys_in_method("verifyPermit"),
            "response_keys": _wire_interface_keys("VerifyPermitWire"),
        },
        # GET endpoint — no request body, only a response. The wire
        # shape lives on the `ApiKeySelfWire` interface in client.ts.
        "/v1-api-key-self": {
            "request_keys": None,
            "response_keys": _wire_interface_keys("ApiKeySelfWire"),
        },
    }


# ── v2 Python SDK introspection ──────────────────────────────────────


def _python_v2_sdk_wire_fields() -> dict[str, dict[str, set[str] | None]]:
    """Return v2 endpoint wire fields by importing atlasent_v2_alpha types."""
    sys.path.insert(0, str(PYTHON_V2_SRC))
    try:
        from atlasent_v2_alpha.types import (  # type: ignore[import-not-found]
            BulkRevokeRequest,
            BulkRevokeResponse,
            ConsumeRequest,
            ConsumeResponse,
            EvaluateBatchRequest,
            EvaluateBatchResponse,
            ProofVerificationResult,
        )
    finally:
        sys.path.pop(0)

    def _aliases(model: type) -> set[str]:
        out: set[str] = set()
        for name, field_info in model.model_fields.items():
            alias = field_info.alias or name
            out.add(alias)
        return out

    return {
        "/v2/evaluate:batch": {
            "request_keys": _aliases(EvaluateBatchRequest),
            "response_keys": _aliases(EvaluateBatchResponse),
        },
        "/v2/permits/:id/consume": {
            "request_keys": _aliases(ConsumeRequest),
            "response_keys": _aliases(ConsumeResponse),
        },
        # POST path param only; no request body schema — just check response.
        "/v2/proofs/:id/verify": {
            "request_keys": None,
            "response_keys": _aliases(ProofVerificationResult),
        },
        "/v2/permits:bulk-revoke": {
            "request_keys": _aliases(BulkRevokeRequest),
            "response_keys": _aliases(BulkRevokeResponse),
        },
    }


# ── v2 TypeScript SDK introspection ──────────────────────────────────


def _typescript_v2_sdk_wire_fields() -> dict[str, dict[str, set[str] | None]]:
    """Parse v2-alpha client.ts body literals and types.ts interfaces."""
    if not TS_V2_CLIENT.exists():
        raise FileNotFoundError(f"v2 TypeScript client not found at {TS_V2_CLIENT}")
    if not TS_V2_TYPES.exists():
        raise FileNotFoundError(f"v2 TypeScript types not found at {TS_V2_TYPES}")
    src_client = TS_V2_CLIENT.read_text()
    src_types = TS_V2_TYPES.read_text()

    def _body_keys_in_method(method_name: str) -> set[str]:
        m = re.search(rf"async\s+{re.escape(method_name)}\s*\(", src_client)
        if not m:
            raise RuntimeError(
                f"Could not locate method '{method_name}' in v2 client.ts"
            )
        body_marker = src_client.find("const body", m.end())
        if body_marker == -1:
            raise RuntimeError(
                f"No `const body = {{...}}` in v2 method '{method_name}'"
            )
        literal = _extract_object_literal(src_client, body_marker)
        return set(_BODY_KEY_RE.findall(literal))

    def _interface_keys(name: str) -> set[str]:
        for m in _INTERFACE_RE.finditer(src_types):
            if m.group("name") == name:
                return {
                    match[0] for match in _INTERFACE_FIELD_RE.findall(m.group("body"))
                }
        raise RuntimeError(
            f"Could not locate interface '{name}' in v2 types.ts"
        )

    return {
        "/v2/evaluate:batch": {
            "request_keys": _body_keys_in_method("evaluateBatch"),
            "response_keys": _interface_keys("EvaluateBatchResponse"),
        },
        "/v2/permits/:id/consume": {
            "request_keys": _body_keys_in_method("consume"),
            "response_keys": _interface_keys("ConsumeResponse"),
        },
        # verifyProof sends only `{ api_key }` — no request body schema.
        "/v2/proofs/:id/verify": {
            "request_keys": None,
            "response_keys": _interface_keys("ProofVerificationResult"),
        },
        "/v2/permits:bulk-revoke": {
            "request_keys": _body_keys_in_method("bulkRevoke"),
            "response_keys": _interface_keys("BulkRevokeResponse"),
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
    sdk_keys: set[str],
    schema: dict[str, Any],
    report: DriftReport,
) -> None:
    required, allowed, extras_allowed = _schema_field_sets(schema)
    missing = required - sdk_keys
    unknown = sdk_keys - allowed

    if missing:
        report.fail(
            f"[{sdk}] {endpoint} {direction}: missing required fields "
            f"{sorted(missing)}"
        )
    if unknown and not extras_allowed:
        report.fail(
            f"[{sdk}] {endpoint} {direction}: unknown fields "
            f"{sorted(unknown)} (schema forbids additionalProperties)"
        )
    elif unknown:
        report.warn(
            f"[{sdk}] {endpoint} {direction}: extra fields {sorted(unknown)} "
            f"(schema allows additionalProperties, but consider adding them)"
        )


def run() -> DriftReport:
    report = DriftReport()

    def _load_v2(name: str) -> dict[str, Any]:
        return json.loads((SCHEMAS / "v2" / name).read_text())

    v1_schemas: dict[str, dict[str, dict[str, Any]]] = {
        "/v1-evaluate": {
            "request": _load_schema("evaluate-request.schema.json"),
            "response": _load_schema("evaluate-response.schema.json"),
        },
        "/v1-verify-permit": {
            "request": _load_schema("verify-permit-request.schema.json"),
            "response": _load_schema("verify-permit-response.schema.json"),
        },
        # GET endpoint — response-only, no request schema.
        "/v1-api-key-self": {
            "response": _load_schema("api-key-self.schema.json"),
        },
    }

    v2_schemas: dict[str, dict[str, dict[str, Any]]] = {
        "/v2/evaluate:batch": {
            "request": _load_v2("evaluate-batch-request.schema.json"),
            "response": _load_v2("evaluate-batch-response.schema.json"),
        },
        "/v2/permits/:id/consume": {
            "request": _load_v2("consume-request.schema.json"),
            "response": _load_v2("consume-response.schema.json"),
        },
        # POST with path param only — no request body schema.
        "/v2/proofs/:id/verify": {
            "response": _load_v2("proof-verification-result.schema.json"),
        },
        "/v2/permits:bulk-revoke": {
            "request": _load_v2("bulk-revoke-request.schema.json"),
            "response": _load_v2("bulk-revoke-response.schema.json"),
        },
    }

    def _check_all(
        sdk_name: str,
        getter: Any,
        schemas: dict[str, dict[str, dict[str, Any]]],
    ) -> None:
        try:
            sdk_wire = getter()
        except Exception as exc:
            report.fail(f"[{sdk_name}] introspection failed: {exc}")
            return
        for endpoint, pair in sdk_wire.items():
            if pair["request_keys"] is not None and "request" in schemas[endpoint]:
                _compare(
                    sdk_name,
                    endpoint,
                    "request",
                    pair["request_keys"],
                    schemas[endpoint]["request"],
                    report,
                )
            _compare(
                sdk_name,
                endpoint,
                "response",
                pair["response_keys"],
                schemas[endpoint]["response"],
                report,
            )

    for sdk_name, getter in (
        ("python", _python_sdk_wire_fields),
        ("typescript", _typescript_sdk_wire_fields),
    ):
        _check_all(sdk_name, getter, v1_schemas)

    for sdk_name, getter in (
        ("python-v2", _python_v2_sdk_wire_fields),
        ("typescript-v2", _typescript_v2_sdk_wire_fields),
    ):
        _check_all(sdk_name, getter, v2_schemas)

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
