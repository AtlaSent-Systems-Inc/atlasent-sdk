"""Financial Governance client-facing wire types.

Parity with ``typescript/src/financialGovernance.ts``.

Wire surfaces:
  - ``v1-financial-governance``: ``list_action_classes``, ``update_ceiling``,
    ``list_executions``, ``freeze_execution``, ``reverse_execution``,
    ``list_incentive_signals``, ``get_health_score``.
  - ``v1-liability-attribution``: ``list``, ``get_by_execution``,
    ``generate_evidence_bundle``.

Pure advisory helpers (local computation, no network) live in the
existing ``atlasent.governance`` subpackage.

Wire-stable as ``financial_governance_client.v1``.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# Re-use existing canonical type literals from the governance subpackage
# rather than duplicating them here.
from .governance.financial_action import (
    CurrencyCode,
    FinancialActionType,
    FinancialRiskTier,
)

# ---------------------------------------------------------------------------
# Literals
# ---------------------------------------------------------------------------

FinancialExecutionStatus = Literal[
    "pending",
    "executed",
    "frozen",
    "reversed",
    "failed",
]
"""Status of a financial execution record."""

# ---------------------------------------------------------------------------
# Action Classes
# ---------------------------------------------------------------------------


class FinancialActionClassRecord(BaseModel):
    """Server-persisted action class configuration.

    Returned by ``list_action_classes``.
    """

    class_id: str
    org_id: str
    action_type: FinancialActionType
    label: str
    risk_tier: FinancialRiskTier
    per_execution_ceiling: float
    ceiling_currency: CurrencyCode
    daily_aggregate_ceiling: float | None = None
    require_permit: bool = False
    updated_at: str
    updated_by: str

    model_config = {"extra": "allow"}


class ListActionClassesResponse(BaseModel):
    """Response for ``list_action_classes``."""

    classes: list[FinancialActionClassRecord] = Field(default_factory=list)
    total: int = 0

    model_config = {"extra": "allow"}


class UpdateCeilingRequest(BaseModel):
    """Request body for ``update_ceiling``."""

    action_type: FinancialActionType
    per_execution_ceiling: float
    ceiling_currency: CurrencyCode
    daily_aggregate_ceiling: float | None = None
    require_permit: bool | None = None
    updated_by: str

    model_config = {"extra": "allow"}


class UpdateCeilingResponse(BaseModel):
    """Response for ``update_ceiling``."""

    class_: FinancialActionClassRecord = Field(alias="class")

    model_config = {"extra": "allow", "populate_by_name": True}


# ---------------------------------------------------------------------------
# Executions
# ---------------------------------------------------------------------------


class FinancialExecutionRecord(BaseModel):
    """A persisted financial execution record."""

    execution_id: str
    org_id: str
    agent_id: str
    action_type: FinancialActionType
    action_value: float
    currency: CurrencyCode
    risk_tier: FinancialRiskTier
    status: FinancialExecutionStatus
    permit_id: str | None = None
    anomaly_detected: bool = False
    anomaly_description: str | None = None
    frozen_at: str | None = None
    frozen_by: str | None = None
    freeze_reason: str | None = None
    reversed_at: str | None = None
    reversed_by: str | None = None
    reversal_reason: str | None = None
    executed_at: str | None = None
    created_at: str

    model_config = {"extra": "allow"}


class ListExecutionsResponse(BaseModel):
    """Response for ``list_executions``."""

    executions: list[FinancialExecutionRecord] = Field(default_factory=list)
    total: int = 0
    next_cursor: str | None = None

    model_config = {"extra": "allow"}


class FreezeExecutionRequest(BaseModel):
    """Request body for ``freeze_execution``."""

    frozen_by: str
    freeze_reason: str

    model_config = {"extra": "allow"}


class FreezeExecutionResponse(BaseModel):
    """Response for ``freeze_execution``."""

    execution: FinancialExecutionRecord

    model_config = {"extra": "allow"}


class ReverseExecutionRequest(BaseModel):
    """Request body for ``reverse_execution``."""

    reversed_by: str
    reversal_reason: str

    model_config = {"extra": "allow"}


class ReverseExecutionResponse(BaseModel):
    """Response for ``reverse_execution``."""

    execution: FinancialExecutionRecord

    model_config = {"extra": "allow"}


# ---------------------------------------------------------------------------
# Incentive Signals
# ---------------------------------------------------------------------------


class IncentiveSignalRecord(BaseModel):
    """A persisted incentive misalignment signal.

    Field names mirror the TypeScript ``IncentiveSignal`` interface from
    ``incentiveAlignment.ts``.
    """

    signal_id: str
    signal_type: str
    party_id: str
    party_label: str
    severity: float
    """0–100."""
    description: str
    evidence: list[str] = Field(default_factory=list)
    detected_at: str
    reviewed: bool = False
    reviewed_by: str | None = None

    model_config = {"extra": "allow"}


class ListIncentiveSignalsResponse(BaseModel):
    """Response for ``list_incentive_signals``."""

    signals: list[IncentiveSignalRecord] = Field(default_factory=list)
    total: int = 0
    next_cursor: str | None = None

    model_config = {"extra": "allow"}


class GovernanceHealthScoreResponse(BaseModel):
    """Response for ``get_health_score``."""

    org_id: str
    health_score: float
    """0–100; higher = healthier governance posture."""
    open_signal_count: int = 0
    computed_at: str

    model_config = {"extra": "allow"}


# ---------------------------------------------------------------------------
# Liability Attribution (v1-liability-attribution)
# ---------------------------------------------------------------------------


class LiabilityPartyWire(BaseModel):
    """Wire shape of a single party in a liability chain."""

    party_id: str
    party_label: str
    party_type: Literal["human", "agent", "system"]
    role: str
    liability_weight: float
    acted_at: str
    permit_id: str | None = None

    model_config = {"extra": "allow"}


class LiabilityAttributionServerRecord(BaseModel):
    """Server-persisted liability attribution record.

    Returned by ``list`` and ``get_by_execution``.
    """

    attribution_id: str
    execution_id: str
    org_id: str
    classification: str
    risk_tier: FinancialRiskTier
    liability_chain: list[LiabilityPartyWire] = Field(default_factory=list)
    delegation_present: bool = False
    supervisory_present: bool = False
    emergency_override: bool = False
    override_justification: str | None = None
    chain_hash: str
    created_at: str

    model_config = {"extra": "allow"}


class ListLiabilityRecordsResponse(BaseModel):
    """Response for ``list`` (liability attribution)."""

    records: list[LiabilityAttributionServerRecord] = Field(default_factory=list)
    total: int = 0
    next_cursor: str | None = None

    model_config = {"extra": "allow"}


class GetLiabilityByExecutionResponse(BaseModel):
    """Response for ``get_by_execution``."""

    record: LiabilityAttributionServerRecord

    model_config = {"extra": "allow"}


class LiabilityEvidenceBundle(BaseModel):
    """Self-contained evidence bundle for a liability attribution record.

    Returned by ``generate_evidence_bundle``.
    """

    bundle_id: str
    attribution_id: str
    execution_id: str
    org_id: str
    canonical_chain_json: str
    """Canonical JSON of the liability chain (deterministic field order)."""
    chain_hash: str
    """SHA-256 over ``canonical_chain_json``.  Matches ``chain_hash`` on the record."""
    signature: str
    """Detached Ed25519 signature (base64url) over canonical bytes."""
    signing_key_id: str | None = None
    generated_at: str

    model_config = {"extra": "allow"}


class GenerateLiabilityEvidenceBundleResponse(BaseModel):
    """Response for ``generate_evidence_bundle``."""

    bundle: LiabilityEvidenceBundle

    model_config = {"extra": "allow"}


__all__ = [
    # action classes
    "FinancialActionClassRecord",
    "ListActionClassesResponse",
    "UpdateCeilingRequest",
    "UpdateCeilingResponse",
    # executions
    "FinancialExecutionRecord",
    "FinancialExecutionStatus",
    "FreezeExecutionRequest",
    "FreezeExecutionResponse",
    "ListExecutionsResponse",
    "ReverseExecutionRequest",
    "ReverseExecutionResponse",
    # incentive signals
    "GovernanceHealthScoreResponse",
    "IncentiveSignalRecord",
    "ListIncentiveSignalsResponse",
    # liability attribution
    "GenerateLiabilityEvidenceBundleResponse",
    "GetLiabilityByExecutionResponse",
    "LiabilityAttributionServerRecord",
    "LiabilityEvidenceBundle",
    "LiabilityPartyWire",
    "ListLiabilityRecordsResponse",
]
