"""Validate the trust-root test vectors in contract/vectors/trust-root/.

Checks:
- Every .jsonl file is valid JSON (single-line format).
- Required top-level fields: description, bundle, expected.
- expected semantics:
    throws path  → throws == "BundleVerificationError", reason in VALID_REASONS
    return path  → verified is a bool
- Reason-specific field presence (advisory, not hard error):
    trust_snapshot_expired → snapshotValidUntil recommended
    key_revoked / key_role_mismatch → kid recommended
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS_DIR = REPO_ROOT / "contract" / "vectors" / "trust-root"

VALID_REASONS = frozenset(
    ["trust_snapshot_expired", "key_revoked", "key_role_mismatch"]
)


def _validate_file(path: Path) -> list[str]:
    errors: list[str] = []
    name = path.name

    raw = path.read_text().strip()
    lines = [l for l in raw.splitlines() if l.strip()]
    if not lines:
        errors.append(f"{name}: file is empty")
        return errors
    if len(lines) > 1:
        errors.append(f"{name}: expected single JSON line, got {len(lines)} lines")

    try:
        vec: dict[str, Any] = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        errors.append(f"{name}: invalid JSON — {exc}")
        return errors

    for field in ("description", "bundle", "expected"):
        if field not in vec:
            errors.append(f"{name}: missing required field '{field}'")

    if not isinstance(vec.get("bundle"), dict):
        errors.append(f"{name}: 'bundle' must be an object")

    expected = vec.get("expected")
    if not isinstance(expected, dict):
        errors.append(f"{name}: 'expected' must be an object")
        return errors

    if "throws" in expected:
        if expected["throws"] != "BundleVerificationError":
            errors.append(
                f"{name}: expected.throws must be 'BundleVerificationError', "
                f"got {expected['throws']!r}"
            )
        reason = expected.get("reason")
        if reason is None:
            errors.append(f"{name}: expected.throws path requires 'reason'")
        elif reason not in VALID_REASONS:
            errors.append(
                f"{name}: unknown reason {reason!r} — "
                f"valid: {sorted(VALID_REASONS)}"
            )
        else:
            if reason == "trust_snapshot_expired" and "snapshotValidUntil" not in expected:
                print(
                    f"  warn  {name}: reason=trust_snapshot_expired "
                    "without snapshotValidUntil"
                )
            if reason in ("key_revoked", "key_role_mismatch") and "kid" not in expected:
                print(f"  warn  {name}: reason={reason} without kid")
    elif "verified" in expected:
        if not isinstance(expected["verified"], bool):
            errors.append(f"{name}: expected.verified must be a bool")
    else:
        errors.append(
            f"{name}: 'expected' must have either 'throws' or 'verified'"
        )

    return errors


def main() -> int:
    if not VECTORS_DIR.is_dir():
        print(f"Trust-root vectors directory not found: {VECTORS_DIR}")
        return 1

    vector_files = sorted(VECTORS_DIR.glob("*.jsonl"))
    if not vector_files:
        print("No .jsonl files found — nothing to validate.")
        return 0

    all_errors: list[str] = []
    for path in vector_files:
        all_errors.extend(_validate_file(path))

    if all_errors:
        print("Trust-root vector validation FAILED:")
        for e in all_errors:
            print(f"  ✗ {e}")
        return 1

    print(f"All {len(vector_files)} trust-root vector(s) valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
