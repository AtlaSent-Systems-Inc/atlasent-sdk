"""Validate that every test vector matches the contract schemas.

Keeps the vectors honest: a vector whose wire_request or wire_response
drifts from its schema would silently mislead every SDK test suite that
consumes it. This tool runs in CI before drift + lint.

Supports two vector shapes:
  1. Single round-trip: `wire_request` + `wire_response` at vector top level
     (evaluate.json, verify.json).
  2. Composed call with multiple round-trips: `wire_calls` array of
     `{path, request, response}` entries (gate.json, authorize.json).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_DIR = REPO_ROOT / "contract"
SCHEMAS = CONTRACT_DIR / "schemas"
VECTORS = CONTRACT_DIR / "vectors"

# Wire path → (request-schema, response-schema) validators, resolved lazily.
_PATH_SCHEMAS: dict[str, tuple[str, str]] = {
    "/v1-evaluate": ("evaluate-request.schema.json", "evaluate-response.schema.json"),
    "/v1-verify-permit": (
        "verify-permit-request.schema.json",
        "verify-permit-response.schema.json",
    ),
}


def _schema(name: str) -> Draft202012Validator:
    return Draft202012Validator(json.loads((SCHEMAS / name).read_text()))


def _load(name: str) -> dict[str, Any]:
    return json.loads((VECTORS / name).read_text())


def _validate(
    vectors: list[dict[str, Any]],
    *,
    request_validator: Draft202012Validator,
    response_validator: Draft202012Validator,
    source: str,
) -> list[str]:
    errors: list[str] = []
    for v in vectors:
        name = v.get("name", "<unnamed>")
        req = v.get("wire_request")
        if req is not None:
            for e in request_validator.iter_errors(req):
                errors.append(f"{source}::{name} request: {e.message} at {list(e.absolute_path)}")
        resp = v.get("wire_response")
        if resp is not None and "sdk_error" not in v:
            for e in response_validator.iter_errors(resp):
                errors.append(f"{source}::{name} response: {e.message} at {list(e.absolute_path)}")
    return errors


def _validate_composed(
    vectors: list[dict[str, Any]],
    *,
    source: str,
    validators: dict[str, tuple[Draft202012Validator, Draft202012Validator]],
) -> list[str]:
    """Validate vectors that carry a `wire_calls` array of composed HTTP calls."""
    errors: list[str] = []
    for v in vectors:
        name = v.get("name", "<unnamed>")
        calls = v.get("wire_calls", [])
        if not isinstance(calls, list) or not calls:
            errors.append(f"{source}::{name}: missing or empty `wire_calls` array")
            continue
        for i, call in enumerate(calls):
            path = call.get("path")
            if path not in validators:
                errors.append(
                    f"{source}::{name}::call[{i}]: unknown path {path!r}; expected one of {sorted(validators)}"
                )
                continue
            req_v, resp_v = validators[path]
            req = call.get("request")
            if req is None:
                errors.append(f"{source}::{name}::call[{i}]: missing `request`")
            else:
                for e in req_v.iter_errors(req):
                    errors.append(
                        f"{source}::{name}::call[{i}] request: {e.message} at {list(e.absolute_path)}"
                    )
            resp = call.get("response")
            if resp is None:
                errors.append(f"{source}::{name}::call[{i}]: missing `response`")
            else:
                for e in resp_v.iter_errors(resp):
                    errors.append(
                        f"{source}::{name}::call[{i}] response: {e.message} at {list(e.absolute_path)}"
                    )
    return errors


def main() -> int:
    errors: list[str] = []

    evaluate = _load("evaluate.json")
    errors.extend(
        _validate(
            evaluate.get("vectors", []),
            request_validator=_schema("evaluate-request.schema.json"),
            response_validator=_schema("evaluate-response.schema.json"),
            source="evaluate.json",
        )
    )

    verify = _load("verify.json")
    errors.extend(
        _validate(
            verify.get("vectors", []),
            request_validator=_schema("verify-permit-request.schema.json"),
            response_validator=_schema("verify-permit-response.schema.json"),
            source="verify.json",
        )
    )

    # Composed-call vectors share a path→validator lookup.
    composed_validators = {
        path: (_schema(req_name), _schema(resp_name))
        for path, (req_name, resp_name) in _PATH_SCHEMAS.items()
    }
    for composed_file in ("gate.json", "authorize.json"):
        if not (VECTORS / composed_file).exists():
            continue
        data = _load(composed_file)
        errors.extend(
            _validate_composed(
                data.get("vectors", []),
                source=composed_file,
                validators=composed_validators,
            )
        )

    if errors:
        print("Vector validation FAILED:")
        for e in errors:
            print(f"  x {e}")
        return 1
    print("All vectors conform to their schemas.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
