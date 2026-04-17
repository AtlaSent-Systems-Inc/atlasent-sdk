"""Pytest entry points for the contract tooling.

These are thin wrappers so `pytest contract/tests/` is the one command
CI (and humans) run to validate the shared contract.
"""

from __future__ import annotations

from pathlib import Path

from contract.tools import drift, policy_lint, validate_vectors


def test_vectors_match_schemas() -> None:
    assert validate_vectors.main() == 0


def test_no_sdk_drift() -> None:
    report = drift.run()
    assert report.ok, "\n".join(report.errors)


def test_policy_lint_passes_valid_and_rejects_invalid() -> None:
    policies_dir = Path(__file__).resolve().parents[1] / "vectors" / "policies"
    valid = sorted(p for p in policies_dir.glob("*.json") if not p.name.startswith("INVALID_"))
    invalid = sorted(policies_dir.glob("INVALID_*.json"))
    assert valid, "no positive policy fixtures"
    assert invalid, "no negative policy fixtures"
    assert policy_lint.main([str(p) for p in valid]) == 0
    assert policy_lint.main([str(p) for p in invalid]) == 0  # negatives expected to fail validation
