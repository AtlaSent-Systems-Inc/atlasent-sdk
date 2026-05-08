"""Cross-language parity test — Python side.

Reads the canonical fixture at ``compat/governance/fixtures/parity.json``
(the cross-language source of truth) and validates that the canonical
Python implementation produces the documented outputs.

The corresponding TypeScript test in
``typescript/test/governance/canonicalCompat.test.ts`` reads the same
fixture and validates the canonical TS implementation. Both tests MUST
pass for the cross-language equivalence guarantee to hold.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import get_args

import pytest

from atlasent.governance import (
    ROLE_WEIGHTS,
    AutonomousBoundsDenyCode,
    BudgetDenyCode,
    FinancialQuorumDenyCode,
    budget_utilization_severity,
    canonicalize_for_evidence,
    classify_risk_tier,
    compute_escalated_approval_count,
)
from atlasent.governance.financial_quorum import AmountThreshold

# Repo layout: python/tests/governance/test_compat_fixtures.py
# parents[0] = governance/, [1] = tests/, [2] = python/, [3] = repo root.
FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "compat"
    / "governance"
    / "fixtures"
    / "parity.json"
)


@pytest.fixture(scope="module")
def fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def test_canonical_for_evidence_cases(fixture: dict) -> None:
    for case in fixture["canonical_for_evidence"]:
        input_value = case["input"]
        expected = case["expected"]
        actual = canonicalize_for_evidence(input_value)
        assert actual == expected, (
            f"canonicalize_for_evidence({input_value!r}) returned {actual!r}, "
            f"expected {expected!r} (case: {case.get('description', '')})"
        )


def test_risk_tier_classification_cases(fixture: dict) -> None:
    for case in fixture["risk_tier_classification"]:
        actual = classify_risk_tier(case["value"])
        assert actual == case["expected"], (
            f"classify_risk_tier({case['value']}) returned {actual!r}, "
            f"expected {case['expected']!r}"
        )


def test_liability_role_weights_match_fixture(fixture: dict) -> None:
    expected_weights = fixture["liability_role_weights"]["weights"]
    for role, weight in expected_weights.items():
        assert ROLE_WEIGHTS[role] == weight, (
            f"ROLE_WEIGHTS[{role!r}] = {ROLE_WEIGHTS[role]}, "
            f"fixture says {weight}"
        )
    assert set(ROLE_WEIGHTS.keys()) == set(expected_weights.keys()), (
        "Role taxonomy in ROLE_WEIGHTS diverges from fixture; both must be updated together"
    )


def test_escalated_approval_count_cases(fixture: dict) -> None:
    for case in fixture["escalated_approval_count"]:
        thresholds = tuple(
            AmountThreshold(
                value=t["value"],
                currency="USD",
                additional_approvals=t["additional_approvals"],
            )
            for t in case["thresholds"]
        )
        actual = compute_escalated_approval_count(
            case["base_count"],
            case["action_value"],
            thresholds,
        )
        assert actual == case["expected"], (
            f"compute_escalated_approval_count({case['base_count']}, "
            f"{case['action_value']}, ...) returned {actual}, "
            f"expected {case['expected']}"
        )


def test_budget_severity_cases(fixture: dict) -> None:
    for case in fixture["budget_severity"]:
        actual = budget_utilization_severity(case["utilization_pct"])
        assert actual == case["expected"], (
            f"budget_utilization_severity({case['utilization_pct']}) "
            f"returned {actual!r}, expected {case['expected']!r}"
        )


def test_deny_code_taxonomy_matches_python_literals(fixture: dict) -> None:
    """The Literal types defined in atlasent.governance.enforcement MUST be
    exactly the set of codes documented in the cross-language fixture.

    Drift here means a deny code exists in Python but not in TypeScript
    (or vice versa), which would silently produce divergent enforcement
    error strings across SDKs.
    """
    fixture_codes = fixture["governance_deny_codes"]
    assert set(get_args(FinancialQuorumDenyCode)) == set(
        fixture_codes["financial_quorum"]
    ), "FinancialQuorumDenyCode diverges from fixture"
    assert set(get_args(BudgetDenyCode)) == set(
        fixture_codes["budget"]
    ), "BudgetDenyCode diverges from fixture"
    assert set(get_args(AutonomousBoundsDenyCode)) == set(
        fixture_codes["autonomous_bounds"]
    ), "AutonomousBoundsDenyCode diverges from fixture"
