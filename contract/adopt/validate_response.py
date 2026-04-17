"""Adopter-side contract validator.

Single-file CLI that lets any repo (engine, downstream SDK, test
harness) validate a JSON body against one of the AtlaSent contract's
response schemas — without needing to know how the contract is
organized internally. Drop this file on ``$PATH`` or vendor it and
call it from a test runner.

Usage::

    # Validate a file on disk
    python validate_response.py evaluate-response path/to/body.json

    # Validate stdin (handy for curl | python -)
    curl -s $ENGINE/v1-evaluate -d @req.json | \
        python validate_response.py evaluate-response -

Exit codes::

    0 — body conforms to the named schema
    1 — schema violation (diagnostic printed to stderr)
    2 — usage error (unknown endpoint, missing file, bad JSON)

Supported endpoint names (same keys as the schemas in ``schemas/``)::

    evaluate-request
    evaluate-response
    verify-permit-request
    verify-permit-response
    error-response
    policy

The script expects ``jsonschema>=4.21`` to be installed. If this file
is copied into an adopter repo, vendor ``contract/schemas/`` alongside
it (or point ``ATLASENT_CONTRACT_SCHEMAS`` at the schemas directory).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ModuleNotFoundError:
    sys.stderr.write(
        "validate_response.py requires `jsonschema>=4.21.0`. "
        "Install it with: pip install jsonschema\n"
    )
    sys.exit(2)

ENDPOINTS = {
    "evaluate-request": "evaluate-request.schema.json",
    "evaluate-response": "evaluate-response.schema.json",
    "verify-permit-request": "verify-permit-request.schema.json",
    "verify-permit-response": "verify-permit-response.schema.json",
    "error-response": "error-response.schema.json",
    "policy": "policy.schema.json",
}


def _schemas_dir() -> Path:
    """Find the contract/schemas/ directory.

    Resolution order:
      1. $ATLASENT_CONTRACT_SCHEMAS (explicit override).
      2. ../schemas/ next to this file (works when vendored as
         contract/adopt/validate_response.py).
      3. ../schemas/ relative to the repo root walking up.
    """
    env = os.environ.get("ATLASENT_CONTRACT_SCHEMAS")
    if env:
        p = Path(env)
        if (p / "evaluate-response.schema.json").exists():
            return p
        sys.stderr.write(
            f"$ATLASENT_CONTRACT_SCHEMAS points at {env!r} but no "
            f"evaluate-response.schema.json is present there.\n"
        )
        sys.exit(2)

    here = Path(__file__).resolve()
    sibling = here.parent.parent / "schemas"
    if (sibling / "evaluate-response.schema.json").exists():
        return sibling

    for ancestor in here.parents:
        candidate = ancestor / "contract" / "schemas"
        if (candidate / "evaluate-response.schema.json").exists():
            return candidate

    sys.stderr.write(
        "Could not locate contract schemas. Either vendor "
        "contract/schemas/ alongside this file, or set "
        "$ATLASENT_CONTRACT_SCHEMAS to its absolute path.\n"
    )
    sys.exit(2)


def _read_json(source: str) -> object:
    if source == "-":
        raw = sys.stdin.read()
    else:
        p = Path(source)
        if not p.exists():
            sys.stderr.write(f"Input file not found: {source}\n")
            sys.exit(2)
        raw = p.read_text()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"Input is not valid JSON: {exc}\n")
        sys.exit(2)


def validate(endpoint: str, body: object) -> list[str]:
    """Return a list of human-readable error strings; empty = valid."""
    if endpoint not in ENDPOINTS:
        valid = ", ".join(sorted(ENDPOINTS))
        sys.stderr.write(
            f"Unknown endpoint {endpoint!r}. "
            f"Supported: {valid}\n"
        )
        sys.exit(2)
    schema_path = _schemas_dir() / ENDPOINTS[endpoint]
    schema = json.loads(schema_path.read_text())
    validator = Draft202012Validator(schema)
    errors = []
    for err in validator.iter_errors(body):
        path = list(err.absolute_path) or ["<root>"]
        errors.append(f"{err.message} (at {path})")
    return errors


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write(
            "usage: validate_response.py <endpoint> <file|->\n"
            f"endpoints: {', '.join(sorted(ENDPOINTS))}\n"
        )
        return 2
    endpoint, source = argv
    body = _read_json(source)
    errors = validate(endpoint, body)
    if errors:
        sys.stderr.write(f"[FAIL] {endpoint}: {len(errors)} error(s)\n")
        for e in errors:
            sys.stderr.write(f"  - {e}\n")
        return 1
    sys.stdout.write(f"[OK] {endpoint}: body conforms to contract\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
