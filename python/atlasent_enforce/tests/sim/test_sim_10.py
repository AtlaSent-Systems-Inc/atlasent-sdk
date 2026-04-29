from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from tests.sim.harness import load_fixture

fx = load_fixture("SIM-10")

REPO_ROOT = Path(__file__).parents[5]
LINT_SCRIPT = REPO_ROOT / "scripts" / "enforce_no_bypass.py"
BYPASS_FIXTURE = REPO_ROOT / fx["fixtures"]["python"]


def test_lint_rejects_bypass_fixture() -> None:
    result = subprocess.run(
        [sys.executable, str(LINT_SCRIPT), str(BYPASS_FIXTURE)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1, f"Expected lint to fail, got 0. Output:\n{result.stdout}{result.stderr}"
    combined = (result.stdout + result.stderr).lower()
    assert "enforce-no-bypass" in combined or "evaluate" in combined
