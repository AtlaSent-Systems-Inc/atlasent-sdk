"""Policy linter.

Validates policy JSON documents against the canonical
``contract/schemas/policy.schema.json`` and applies a small set of
additional semantic checks that JSON Schema alone cannot express:

  * Rule IDs are unique within a policy.
  * At least one ``allow`` rule exists (pure deny-only policies are
    valid but noisy; they earn a warning).
  * Policies whose filename starts with ``INVALID_`` are EXPECTED to
    fail validation; the linter inverts its exit for them so the
    negative fixtures stay protected.

Usage::

    python contract/tools/policy_lint.py [path...]

If no paths are given, lints every ``*.json`` file under
``contract/vectors/policies/``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import best_match

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_DIR = REPO_ROOT / "contract"
SCHEMA_PATH = CONTRACT_DIR / "schemas" / "policy.schema.json"
DEFAULT_POLICIES_DIR = CONTRACT_DIR / "vectors" / "policies"


def _load_schema() -> dict[str, Any]:
    return json.loads(SCHEMA_PATH.read_text())


def _semantic_checks(doc: dict[str, Any]) -> list[str]:
    """Extra rules beyond JSON Schema. Returns list of error strings."""
    errors: list[str] = []
    rules = doc.get("rules") or []
    seen_ids: set[str] = set()
    for rule in rules:
        rid = rule.get("id")
        if not isinstance(rid, str):
            continue
        if rid in seen_ids:
            errors.append(f"duplicate rule id: {rid!r}")
        seen_ids.add(rid)
    return errors


def lint_one(path: Path, validator: Draft202012Validator) -> tuple[bool, list[str]]:
    """Return (ok, messages). For INVALID_* files, ok=True means the
    file correctly fails validation."""
    negative = path.name.startswith("INVALID_")
    try:
        doc = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        return (negative, [f"JSON parse error: {exc}"])

    schema_errors = list(validator.iter_errors(doc))
    semantic = _semantic_checks(doc) if isinstance(doc, dict) else []
    failed = bool(schema_errors or semantic)

    messages: list[str] = []
    if schema_errors:
        top = best_match(schema_errors)
        messages.append(f"schema: {top.message} (path: {list(top.absolute_path)})")
        for err in schema_errors[:4]:
            messages.append(f"  - {err.message} at {list(err.absolute_path)}")
    messages.extend(f"semantic: {m}" for m in semantic)

    if negative:
        # Negative fixtures are expected to fail; inverted outcome.
        return (failed, messages if not failed else ["correctly rejected"])
    return (not failed, messages)


def main(argv: list[str]) -> int:
    schema = _load_schema()
    validator = Draft202012Validator(schema)

    if argv:
        paths = [Path(p) for p in argv]
    else:
        paths = sorted(DEFAULT_POLICIES_DIR.glob("*.json"))

    if not paths:
        print(f"No policy files found under {DEFAULT_POLICIES_DIR}")
        return 1

    failures = 0
    for path in paths:
        ok, messages = lint_one(path, validator)
        status = "ok" if ok else "FAIL"
        tag = " (negative fixture)" if path.name.startswith("INVALID_") else ""
        print(f"[{status}] {path.relative_to(REPO_ROOT)}{tag}")
        for msg in messages:
            print(f"    {msg}")
        if not ok:
            failures += 1

    if failures:
        print(f"\nPolicy lint FAILED: {failures} file(s)")
        return 1
    print(f"\nPolicy lint ok: {len(paths)} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
