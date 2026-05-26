"""Tests for governance agent helper utilities."""

from __future__ import annotations

from atlasent.governance_agents import (
    GovernanceAgentFinding,
    highest_agent_finding_severity,
)


def _finding(severity: str) -> GovernanceAgentFinding:
    return GovernanceAgentFinding.model_validate(
        {
            "id": f"f_{severity}",
            "org_id": "org_1",
            "evaluation_id": "ev_1",
            "change_id": "chg_1",
            "agent_slug": "risk",
            "agent_version": "1.0.0",
            "finding_type": "policy",
            "severity": severity,
            "summary": "summary",
            "can_authorize": False,
            "created_at": "2026-05-08T00:00:00Z",
        }
    )


def test_highest_agent_finding_severity_empty_and_unknown() -> None:
    assert highest_agent_finding_severity([]) is None
    assert highest_agent_finding_severity([_finding("future_unknown")]) is None


def test_highest_agent_finding_severity_returns_highest_ranked() -> None:
    findings = [_finding("low"), _finding("medium"), _finding("blocker")]
    assert highest_agent_finding_severity(findings) == "blocker"
