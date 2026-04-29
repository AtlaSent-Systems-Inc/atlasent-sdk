#!/usr/bin/env python3
"""enforce-no-bypass — static lint for the atlasent-enforce package.

Rejects any Python source file that:
  1. Imports from atlasent directly (disallowed inside the enforce package source)
  2. Calls .evaluate( on a client instance directly (bypassing Enforce.run)

Usage:
    python scripts/enforce_no_bypass.py [file ...]

Exit codes:
    0 — no violations
    1 — one or more violations found

In CI, run against the enforce package:
    python scripts/enforce_no_bypass.py python/atlasent_enforce/atlasent_enforce/*.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

RULE_NAME = "enforce-no-bypass"

PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"from\s+atlasent\s+import|import\s+atlasent\b"),
        "Direct import from atlasent (v1 SDK) is not allowed inside the atlasent_enforce package. "
        "Use EnforceCompatibleClient protocol instead.",
    ),
    (
        re.compile(r"\bAtlasentClient\b"),
        "Direct use of AtlasentClient is not allowed inside the atlasent_enforce package source. "
        "Inject via EnforceCompatibleClient.",
    ),
    (
        re.compile(r"\.evaluate\s*\("),
        "Direct call to .evaluate() is not allowed outside the Enforce wrapper. "
        "Route all evaluation through Enforce.run().",
    ),
]


def lint_file(path: Path) -> list[str]:
    violations = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        return [f"[{RULE_NAME}] Cannot read file {path}: {exc}"]

    for i, line in enumerate(lines, start=1):
        # Pragma on this line OR the preceding line silences the check.
        prev = lines[i - 2] if i >= 2 else ""
        if "enforce-no-bypass: allow" in line or "enforce-no-bypass: allow" in prev:
            continue
        for pattern, message in PATTERNS:
            if pattern.search(line):
                violations.append(
                    f"[{RULE_NAME}] {path}:{i}: {message}\n  > {line.strip()}"
                )

    return violations


def main() -> None:
    files = sys.argv[1:]
    if not files:
        print(
            f"[{RULE_NAME}] No files specified. Pass one or more file paths as arguments.",
            file=sys.stderr,
        )
        sys.exit(1)

    all_violations: list[str] = []
    for raw in files:
        all_violations.extend(lint_file(Path(raw)))

    if all_violations:
        for v in all_violations:
            print(v, file=sys.stderr)
        print(
            f"\n[{RULE_NAME}] {len(all_violations)} violation(s) found. Fix them before merging.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"[{RULE_NAME}] OK — no violations found in {len(files)} file(s).")
    sys.exit(0)


if __name__ == "__main__":
    main()
