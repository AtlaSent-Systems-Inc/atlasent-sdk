"""Regression guard for the trust-root vendoring incident (see
trust_root.py's module docstring, and the "Fixed" CHANGELOG entry it
links to).

trust_root.py previously read ``vendor/trust-root/*.json`` from disk via
``Path(__file__).parent.parent.parent / "vendor" / "trust-root"`` at first
use -- a path that was unreachable in every real ``pip install`` (the
directory sits outside the packaged ``atlasent`` module, and the path
math itself pointed one level short of anywhere it could plausibly live).
The fix replaced the runtime file read with a build-time-embedded dict
literal (``vendored_trust_root.py``), so the vendor-loading code path in
trust_root.py now does no I/O of any kind.

This guard fails loudly if either file regains a filesystem read on the
vendor-snapshot path, so the defect can't quietly come back the same way
it arrived -- a seemingly-safe "just read this one extra vendor file" edit.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# Matches read_text()/open()/Path(...).read_bytes() style filesystem reads.
FILE_READ_RE = re.compile(r"\.read_text\(|\.read_bytes\(|\bopen\(")


def test_trust_root_module_does_no_file_io() -> None:
    source = (REPO_ROOT / "atlasent" / "trust_root.py").read_text()
    matches = FILE_READ_RE.findall(source)
    assert matches == []


def test_vendored_trust_root_module_does_no_file_io() -> None:
    source = (REPO_ROOT / "atlasent" / "vendored_trust_root.py").read_text()
    matches = FILE_READ_RE.findall(source)
    assert matches == []


def test_guard_itself_catches_a_real_file_read() -> None:
    mutated = 'data = Path("x").read_text()\n'
    assert FILE_READ_RE.findall(mutated) != []


def test_guard_tolerates_an_unrelated_line_no_false_positive() -> None:
    clean = (
        "from atlasent.vendored_trust_root import VENDORED_TRUST_ROOT_SNAPSHOT_DATA\n"
    )
    assert FILE_READ_RE.findall(clean) == []
