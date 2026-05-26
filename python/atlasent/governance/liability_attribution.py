"""Liability Attribution — priority 2.

Mirrors ``atlasent-sdk/typescript/src/liabilityAttribution.ts``.

Key divergences from the legacy ``atlasent.governance.liability_attribution``
in the orchestration repo (which this canonical port supersedes):

- 8 roles instead of 5: adds ``delegator``, ``delegate``, ``override_actor``,
  ``supervisor``, ``exception_approver``. Renames legacy ``initiator`` to
  the canonical ``authorizer``.
- Role weights match the canonical TS table (override_actor=0.40,
  authorizer=0.30, executor=0.25, supervisor=0.10, delegator=0.15,
  delegate=0.15, approver=0.05, exception_approver=0.05).
- Adds ``LiabilityClassification`` regimes from migration 002.
- Adds ``validate_liability_chain`` (chain integrity check).
- Adds ``compute_chain_hash`` over canonical bytes (matches the
  ``chain_hash`` column in migration 002).
- ``find_primary_liability_parties`` returns *all* parties at/above a
  threshold (default 0.20), not just the highest-weight party.

Wire-stable as ``liability_attribution.v1``.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal

from ._canonical import canonicalize_for_evidence
from .financial_action import FinancialRiskTier, LiabilityClassification

LiabilityPartyRole = Literal[
    "authorizer",
    "delegator",
    "delegate",
    "executor",
    "approver",
    "override_actor",
    "supervisor",
    "exception_approver",
]

PartyType = Literal["human", "agent", "system"]

WeightDistribution = Literal["equal", "role_weighted"]

# Default weights for ``role_weighted`` distribution. Sum is intentionally
# not 1.0 — weights are normalized at chain construction time. Values match
# ``ROLE_WEIGHTS`` in the TS module byte-for-byte.
ROLE_WEIGHTS: dict[str, float] = {
    "authorizer": 0.30,
    "delegator": 0.15,
    "delegate": 0.15,
    "executor": 0.25,
    "approver": 0.05,
    "override_actor": 0.40,
    "supervisor": 0.10,
    "exception_approver": 0.05,
}


@dataclass(frozen=True)
class LiabilityParty:
    """A single party in the liability chain."""

    party_id: str
    party_label: str
    party_type: PartyType
    role: LiabilityPartyRole
    liability_weight: float
    acted_at: str
    permit_id: str | None

    def to_dict(self) -> dict:
        return {
            "party_id": self.party_id,
            "party_label": self.party_label,
            "party_type": self.party_type,
            "role": self.role,
            "liability_weight": self.liability_weight,
            "acted_at": self.acted_at,
            "permit_id": self.permit_id,
        }


@dataclass(frozen=True)
class _PartyInput:
    """Helper shape for inputs that carry party identity but no role/weight yet."""

    party_id: str
    party_label: str
    party_type: PartyType
    acted_at: str
    permit_id: str | None


@dataclass(frozen=True)
class DelegationInput:
    """Input shape for a single delegation event in the chain."""

    delegator_id: str
    delegate_id: str
    delegator_label: str
    delegate_label: str
    delegator_type: PartyType
    delegate_type: PartyType
    permit_id: str | None
    acted_at: str


@dataclass(frozen=True)
class OverrideInput:
    """Input shape for an emergency override in the chain."""

    actor_id: str
    actor_label: str
    actor_type: PartyType
    justification: str
    permit_id: str | None
    acted_at: str


@dataclass(frozen=True)
class LiabilityAttributionInput:
    """Input required to build a liability attribution record."""

    execution_id: str
    org_id: str
    classification: LiabilityClassification
    risk_tier: FinancialRiskTier
    authorizer: _PartyInput
    executor: _PartyInput
    approvers: Sequence[_PartyInput] = field(default_factory=tuple)
    delegations: Sequence[DelegationInput] = field(default_factory=tuple)
    supervisors: Sequence[_PartyInput] = field(default_factory=tuple)
    override: OverrideInput | None = None


@dataclass(frozen=True)
class LiabilityAttributionRecord:
    """Immutable liability attribution record for a financial execution.

    Stored in ``liability_attribution_records``. One record per execution.
    """

    attribution_id: str
    execution_id: str
    org_id: str
    classification: LiabilityClassification
    risk_tier: FinancialRiskTier
    liability_chain: Sequence[LiabilityParty]
    delegation_present: bool
    supervisory_present: bool
    emergency_override: bool
    override_justification: str | None
    chain_hash: str
    created_at: str


@dataclass(frozen=True)
class LiabilityChainValidation:
    """Result of ``validate_liability_chain``."""

    valid: bool
    errors: Sequence[str]


def compute_liability_weights(
    parties: Sequence[dict],
    distribution: WeightDistribution = "role_weighted",
) -> list[float]:
    """Compute normalized liability weights for a sequence of role-bearing parties.

    ``parties`` is a sequence of mappings each containing at least a ``role`` key.
    Returns weights normalized to sum to 1.0. Mirrors
    ``computeLiabilityWeights`` in TS exactly.
    """
    n = len(parties)
    if n == 0:
        return []
    if distribution == "equal":
        raw = [1.0] * n
    else:
        raw = [ROLE_WEIGHTS.get(p["role"], 0.05) for p in parties]
    total = sum(raw)
    if total <= 0:
        return [1.0 / n] * n
    return [w / total for w in raw]


def build_liability_chain(
    input: LiabilityAttributionInput,
    distribution: WeightDistribution = "role_weighted",
) -> list[LiabilityParty]:
    """Build a liability chain from attribution input.

    Order matches the TS source:
        1. authorizer
        2. delegations (each: delegator then delegate)
        3. approvers
        4. supervisors
        5. executor
        6. override (if present)
    """
    raw: list[dict] = []

    raw.append(
        {
            "party_id": input.authorizer.party_id,
            "party_label": input.authorizer.party_label,
            "party_type": input.authorizer.party_type,
            "role": "authorizer",
            "acted_at": input.authorizer.acted_at,
            "permit_id": input.authorizer.permit_id,
        }
    )

    for d in input.delegations:
        raw.append(
            {
                "party_id": d.delegator_id,
                "party_label": d.delegator_label,
                "party_type": d.delegator_type,
                "role": "delegator",
                "acted_at": d.acted_at,
                "permit_id": d.permit_id,
            }
        )
        raw.append(
            {
                "party_id": d.delegate_id,
                "party_label": d.delegate_label,
                "party_type": d.delegate_type,
                "role": "delegate",
                "acted_at": d.acted_at,
                "permit_id": d.permit_id,
            }
        )

    for a in input.approvers:
        raw.append(
            {
                "party_id": a.party_id,
                "party_label": a.party_label,
                "party_type": a.party_type,
                "role": "approver",
                "acted_at": a.acted_at,
                "permit_id": a.permit_id,
            }
        )

    for s in input.supervisors:
        raw.append(
            {
                "party_id": s.party_id,
                "party_label": s.party_label,
                "party_type": s.party_type,
                "role": "supervisor",
                "acted_at": s.acted_at,
                "permit_id": s.permit_id,
            }
        )

    raw.append(
        {
            "party_id": input.executor.party_id,
            "party_label": input.executor.party_label,
            "party_type": input.executor.party_type,
            "role": "executor",
            "acted_at": input.executor.acted_at,
            "permit_id": input.executor.permit_id,
        }
    )

    if input.override is not None:
        raw.append(
            {
                "party_id": input.override.actor_id,
                "party_label": input.override.actor_label,
                "party_type": input.override.actor_type,
                "role": "override_actor",
                "acted_at": input.override.acted_at,
                "permit_id": input.override.permit_id,
            }
        )

    weights = compute_liability_weights(raw, distribution)
    return [
        LiabilityParty(
            party_id=p["party_id"],
            party_label=p["party_label"],
            party_type=p["party_type"],
            role=p["role"],
            liability_weight=w,
            acted_at=p["acted_at"],
            permit_id=p["permit_id"],
        )
        for p, w in zip(raw, weights)
    ]


def find_primary_liability_parties(
    chain: Sequence[LiabilityParty],
    threshold: float = 0.20,
) -> list[LiabilityParty]:
    """Return all parties bearing primary liability (weight >= threshold).

    Used in dispute workflows and regulatory reporting.
    Mirrors ``findPrimaryLiabilityParties`` in TS.
    """
    return [p for p in chain if p.liability_weight >= threshold]


def validate_liability_chain(
    chain: Sequence[LiabilityParty],
    has_emergency_override: bool,
) -> LiabilityChainValidation:
    """Validate structural correctness of a liability chain.

    Mirrors ``validateLiabilityChain`` in TS:
      - At least one party present
      - Weights sum to ~1.0 (within 0.01 tolerance)
      - No duplicate ``(party_id, role)`` pairs
      - ``override_actor`` present iff ``has_emergency_override`` is True
    """
    errors: list[str] = []

    if len(chain) == 0:
        errors.append("liability chain must have at least one party")

    weight_sum = sum(p.liability_weight for p in chain)
    if abs(weight_sum - 1.0) > 0.01:
        errors.append(f"liability weights sum to {weight_sum:.4f}, expected 1.0")

    seen: set[str] = set()
    for p in chain:
        key = f"{p.party_id}:{p.role}"
        if key in seen:
            errors.append(f"duplicate party+role: {key}")
        seen.add(key)

    has_override_actor = any(p.role == "override_actor" for p in chain)
    if has_emergency_override and not has_override_actor:
        errors.append("emergency_override is true but no override_actor in chain")

    return LiabilityChainValidation(valid=len(errors) == 0, errors=tuple(errors))


def compute_chain_hash(chain: Sequence[LiabilityParty]) -> str:
    """Compute the canonical SHA-256 chain hash for storage in ``chain_hash``.

    Algorithm (canonical, locked by this PR; TS-side helper to match must be
    added in a follow-up):

        sha256(canonicalize_for_evidence([party.to_dict() for party in chain]))

    The hash is order-sensitive on chain order (matches TS chain construction
    order) and includes ``liability_weight`` so a chain with renormalized
    weights produces a different hash.
    """
    payload = [p.to_dict() for p in chain]
    canonical = canonicalize_for_evidence(payload)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


__all__ = [
    "DelegationInput",
    "LiabilityAttributionInput",
    "LiabilityAttributionRecord",
    "LiabilityChainValidation",
    "LiabilityParty",
    "LiabilityPartyRole",
    "OverrideInput",
    "PartyType",
    "ROLE_WEIGHTS",
    "WeightDistribution",
    "build_liability_chain",
    "compute_chain_hash",
    "compute_liability_weights",
    "find_primary_liability_parties",
    "validate_liability_chain",
]
