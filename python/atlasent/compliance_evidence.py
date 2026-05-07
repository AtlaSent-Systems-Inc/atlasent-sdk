"""Compliance evidence run models and helper utilities.

Parity with ``typescript/src/complianceEvidence.ts``.

AtlaSent automatically derives SOC 2 evidence from live audit data.
Trigger a run via ``POST /v1/compliance-evidence`` and poll
``GET /v1/compliance-evidence/:id`` until the run is terminal
(``completed`` or ``failed``).

Quick start::

    from atlasent.compliance_evidence import (
        ComplianceEvidenceRun,
        evidence_run_passes,
        non_passing_controls,
    )

    run: ComplianceEvidenceRun = ...  # from API response

    if not evidence_run_passes(run):
        issues = non_passing_controls(run)
        for ctrl in issues:
            print(f"{ctrl.control_id}: {ctrl.status}")
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Literals
# ---------------------------------------------------------------------------

SOC2ControlId = Literal["CC6.1", "CC6.3", "CC7.2", "CC8.1", "CC3.2"]
"""SOC 2 Trust Services Criteria IDs covered by AtlaSent evidence runs."""

ControlStatus = Literal["pass", "gap", "finding"]
"""
Evidence status for a single control:

- ``"pass"`` — fully evidenced within the period.
- ``"gap"`` — partial evidence; remediation recommended.
- ``"finding"`` — insufficient or contradictory evidence; action required.
"""

EvidenceRunStatus = Literal["pending", "running", "completed", "failed"]

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class EvidenceControl(BaseModel):
    """Evidence result for a single SOC 2 control."""

    control_id: str
    title: str = ""
    status: ControlStatus
    evidence: list[str] = Field(default_factory=list)

    model_config = {"extra": "allow"}


class EvidenceRunSummary(BaseModel):
    """Aggregate counts from a completed evidence run."""

    total_controls: int = 0
    pass_: int = Field(0, alias="pass")
    gap: int = 0
    finding: int = 0

    model_config = {"extra": "allow", "populate_by_name": True}


class ComplianceEvidenceRun(BaseModel):
    """A compliance evidence collection run.

    Returned by ``POST /v1/compliance-evidence`` (status ``running``) and
    ``GET /v1/compliance-evidence/:id`` (any status).  ``controls`` is
    populated once the run reaches ``completed``.
    """

    id: str
    org_id: str
    framework: str
    period_start: str = ""
    period_end: str = ""
    status: EvidenceRunStatus
    controls: list[EvidenceControl] = Field(default_factory=list)
    summary: EvidenceRunSummary | None = None
    created_at: str = ""
    completed_at: str | None = None

    model_config = {"extra": "allow"}


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------


def evidence_run_passes(run: ComplianceEvidenceRun) -> bool:
    """Return ``True`` if the run is complete and has no ``"finding"`` controls.

    A run with ``status != "completed"`` is treated as not passing
    (either still in progress or failed).
    """
    if run.status != "completed":
        return False
    return all(ctrl.status != "finding" for ctrl in run.controls)


def non_passing_controls(run: ComplianceEvidenceRun) -> list[EvidenceControl]:
    """Return controls that are not ``"pass"``.

    Results are ordered with ``"finding"`` before ``"gap"`` so callers
    that truncate the list see the most severe issues first.
    """
    findings = [c for c in run.controls if c.status == "finding"]
    gaps = [c for c in run.controls if c.status == "gap"]
    return findings + gaps
