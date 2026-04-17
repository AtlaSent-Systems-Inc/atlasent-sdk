"""Validate that every test vector matches the contract schemas.

Keeps the vectors honest: a vector whose wire_request or wire_response
drifts from its schema would silently mislead every SDK test suite that
consumes it. This tool runs in CI before drift + lint.
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

    if errors:
        print("Vector validation FAILED:")
        for e in errors:
            print(f"  x {e}")
        return 1
    print("All vectors conform to their schemas.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
