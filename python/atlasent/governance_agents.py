"""Constrained governance agents -- read-side SDK surface.

Three endpoints, all GET, all org-scoped server-side:
    GET /v1/governance/agents
    GET /v1/governance/findings?change_id=...
    GET /v1/governance/evaluations?change_id=...

``can_authorize`` is ``False`` on every agent and finding -- enforced
by a CHECK constraint on the runtime DB, not just convention.
Governance agents are advisory-only; no invocation endpoint is
exposed here. CI invocation is the responsibility of atlasent-action.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

_SEVERITY_RANK: dict[str, int] = {
    "info": 1,
    "low": 2,
    "medium": 3,
    "high": 4,
    "blocker": 5,
}


class AgentEvidenceRef(BaseModel):
    """A reference to an evidence artifact produced by a governance agent."""

    kind: str
    ref: str
    note: str | None = None

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class GovernanceAgent(BaseModel):
    """An advisory governance agent registered in the AtlaSent registry.

    ``can_authorize`` is always ``False`` -- a structural invariant
    enforced by the runtime DB. Advisory agents produce findings;
    they never satisfy a permit gate.
    """

    slug: str
    version: str
    name: str
    description: str
    applicable_subject_kinds: list[str] = Field(default_factory=list)
    authority_class: Literal["advisory"]
    can_authorize: Literal[False]
    capabilities: list[str] = Field(default_factory=list)
    is_active: bool
    created_at: str
    retired_at: str | None = None

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class GovernanceAgentFinding(BaseModel):
    """A finding emitted by a governance agent evaluation run.

    ``can_authorize`` is always ``False`` -- a DB CHECK constraint
    prevents any finding from satisfying a permit gate.
    """

    id: str
    org_id: str
    evaluation_id: str
    change_id: str
    agent_slug: str
    agent_version: str
    finding_type: str
    severity: str
    confidence: float | None = None
    summary: str
    evidence_refs: list[AgentEvidenceRef] = Field(default_factory=list)
    required_authority: str | None = None
    recommended_action: str | None = None
    can_authorize: Literal[False]
    supersedes_finding_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    routed_gate_id: str | None = None

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class GovernanceAgentEvaluation(BaseModel):
    """A governance agent run record for a single governed change."""

    id: str
    org_id: str
    change_id: str
    agent_slug: str
    agent_version: str
    input_hash: str
    status: str
    highest_severity: str | None = None
    findings_count: int
    summary: str | None = None
    runtime_ms: int | None = None
    failure_reason: str | None = None
    invoked_by_kind: str
    invoked_by: str | None = None
    started_at: str
    completed_at: str | None = None

    model_config = ConfigDict(extra="allow", populate_by_name=True)


@dataclass
class ListGovernanceAgentsResult:
    """Return type for :meth:`~atlasent.AtlaSentClient.list_governance_agents`."""

    agents: list[GovernanceAgent] = field(default_factory=list)
    rate_limit: Any | None = None


@dataclass
class ListGovernanceFindingsResult:
    """Return type for :meth:`~atlasent.AtlaSentClient.list_governance_findings`."""

    findings: list[GovernanceAgentFinding] = field(default_factory=list)
    rate_limit: Any | None = None


@dataclass
class ListGovernanceEvaluationsResult:
    """Return type for :meth:`~atlasent.AtlaSentClient.list_governance_evaluations`."""

    evaluations: list[GovernanceAgentEvaluation] = field(default_factory=list)
    rate_limit: Any | None = None


def highest_agent_finding_severity(
    findings: list[GovernanceAgentFinding],
) -> str | None:
    """Return the highest severity string across a list of findings.

    Returns ``None`` when the list is empty or all severities are
    unrecognized. Severity rank: ``blocker`` > ``high`` > ``medium`` >
    ``low`` > ``info``.
    """
    best: str | None = None
    rank = 0
    for f in findings:
        r = _SEVERITY_RANK.get(f.severity, 0)
        if r > rank:
            rank = r
            best = f.severity
    return best
