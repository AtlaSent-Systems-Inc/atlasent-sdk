"""Tests for atlasent.compliance_evidence."""

from __future__ import annotations

import pytest

from atlasent.compliance_evidence import (
    ComplianceEvidenceRun,
    EvidenceControl,
    EvidenceRunSummary,
    evidence_run_passes,
    non_passing_controls,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_control(control_id: str, status: str) -> EvidenceControl:
    return EvidenceControl(
        control_id=control_id,
        title=f"{control_id} title",
        status=status,  # type: ignore[arg-type]
        evidence=["some evidence"],
    )


def make_run(
    status: str = "completed",
    controls: list[EvidenceControl] | None = None,
) -> ComplianceEvidenceRun:
    return ComplianceEvidenceRun(
        id="cev_01",
        org_id="org_01",
        framework="soc2",
        status=status,  # type: ignore[arg-type]
        controls=controls or [],
    )


# ---------------------------------------------------------------------------
# evidence_run_passes
# ---------------------------------------------------------------------------


class TestEvidenceRunPasses:
    def test_all_pass_returns_true(self) -> None:
        run = make_run(controls=[
            make_control("CC6.1", "pass"),
            make_control("CC6.3", "pass"),
        ])
        assert evidence_run_passes(run) is True

    def test_any_finding_returns_false(self) -> None:
        run = make_run(controls=[
            make_control("CC6.1", "pass"),
            make_control("CC7.2", "finding"),
        ])
        assert evidence_run_passes(run) is False

    def test_gap_without_finding_returns_true(self) -> None:
        """Gaps are advisory; only findings block a passing result."""
        run = make_run(controls=[
            make_control("CC6.1", "pass"),
            make_control("CC7.2", "gap"),
        ])
        assert evidence_run_passes(run) is True

    def test_non_completed_status_returns_false(self) -> None:
        run = make_run(status="running", controls=[
            make_control("CC6.1", "pass"),
        ])
        assert evidence_run_passes(run) is False

    def test_failed_status_returns_false(self) -> None:
        run = make_run(status="failed")
        assert evidence_run_passes(run) is False

    def test_empty_controls_completed_returns_true(self) -> None:
        run = make_run(controls=[])
        assert evidence_run_passes(run) is True


# ---------------------------------------------------------------------------
# non_passing_controls
# ---------------------------------------------------------------------------


class TestNonPassingControls:
    def test_returns_empty_when_all_pass(self) -> None:
        run = make_run(controls=[
            make_control("CC6.1", "pass"),
            make_control("CC6.3", "pass"),
        ])
        assert non_passing_controls(run) == []

    def test_returns_findings_and_gaps(self) -> None:
        run = make_run(controls=[
            make_control("CC6.1", "pass"),
            make_control("CC7.2", "gap"),
            make_control("CC8.1", "finding"),
        ])
        result = non_passing_controls(run)
        assert len(result) == 2

    def test_findings_before_gaps(self) -> None:
        """Findings must appear before gaps regardless of input order."""
        run = make_run(controls=[
            make_control("CC7.2", "gap"),
            make_control("CC8.1", "finding"),
            make_control("CC3.2", "gap"),
        ])
        result = non_passing_controls(run)
        assert result[0].status == "finding"
        assert result[1].status == "gap"
        assert result[2].status == "gap"

    def test_control_ids_preserved(self) -> None:
        run = make_run(controls=[
            make_control("CC6.1", "finding"),
            make_control("CC7.2", "gap"),
        ])
        ids = [c.control_id for c in non_passing_controls(run)]
        assert "CC6.1" in ids
        assert "CC7.2" in ids

    def test_excludes_passing_controls(self) -> None:
        run = make_run(controls=[
            make_control("CC6.1", "pass"),
            make_control("CC6.3", "gap"),
        ])
        result = non_passing_controls(run)
        ids = [c.control_id for c in result]
        assert "CC6.1" not in ids
        assert "CC6.3" in ids


# ---------------------------------------------------------------------------
# ComplianceEvidenceRun model
# ---------------------------------------------------------------------------


class TestComplianceEvidenceRun:
    def test_round_trips_from_dict(self) -> None:
        data = {
            "id": "cev_01",
            "org_id": "org_01",
            "framework": "soc2",
            "status": "completed",
            "controls": [
                {
                    "control_id": "CC6.1",
                    "title": "Logical Access",
                    "status": "pass",
                    "evidence": ["847 evaluations"],
                }
            ],
            "summary": {"pass": 1, "gap": 0, "finding": 0, "total_controls": 1},
            "created_at": "2026-05-07T00:00:00Z",
            "completed_at": "2026-05-07T00:00:04Z",
        }
        run = ComplianceEvidenceRun.model_validate(data)
        assert run.status == "completed"
        assert len(run.controls) == 1
        assert run.controls[0].control_id == "CC6.1"
        assert run.summary is not None
        assert run.summary.gap == 0

    def test_summary_pass_alias(self) -> None:
        """EvidenceRunSummary.pass_ maps to the wire field 'pass'."""
        s = EvidenceRunSummary.model_validate(
            {"pass": 4, "gap": 1, "finding": 0, "total_controls": 5}
        )
        assert s.pass_ == 4

    def test_controls_default_empty(self) -> None:
        run = ComplianceEvidenceRun.model_validate({
            "id": "cev_02",
            "org_id": "org_01",
            "framework": "soc2",
            "status": "running",
        })
        assert run.controls == []
        assert run.summary is None

    def test_extra_fields_allowed(self) -> None:
        run = ComplianceEvidenceRun.model_validate({
            "id": "cev_03",
            "org_id": "org_01",
            "framework": "soc2",
            "status": "pending",
            "future_field": True,
        })
        assert run.id == "cev_03"
