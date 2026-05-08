"""Economic Governance — canonical Python port of the TypeScript SDK modules.

This subpackage is the **canonical Python implementation** of AtlaSent's
Economic Governance Advisory System (EGAS). It mirrors the canonical
TypeScript modules in ``atlasent-sdk/typescript/src/`` exactly. Where
this package and the TypeScript implementation disagree on any
governance decision for the same input, **that is a bug in this
package** and must be fixed here, not in the TS source.

Deliberately **not** a port of:

- ``atlasent/python/atlasent/governance/`` (the orchestration repo's
  earlier advisory subset). That module uses different role taxonomies,
  different liability weights, and incompatible bundle structures.
  See ``docs/MIGRATION-economic-governance-to-sdk.md``.
- ``atlasent/packages/sdk/src/governance.ts`` (a pure-classification
  mirror used only by the existing classifier-only compat tests).

This package is **advisory** — no function in it blocks execution.
Enforcement-layer helpers (``enforce_financial_quorum`` etc.) are
intentionally not part of this PR; they will land in a follow-up once
parity is locked.

Public API::

    from atlasent.governance import (
        # financial_action
        classify_risk_tier,
        within_autonomous_ceiling,
        DEFAULT_RISK_TIER_THRESHOLDS,
        FinancialActionClass,
        FinancialExecutionRecord,
        # economic_evidence (priority 1)
        EconomicEvidenceBundle,
        EvidenceBundleSignableContent,
        build_signable_content,
        serialize_signable_content,
        compute_content_hash,
        verify_evidence_bundle_structure,
        canonicalize_for_evidence,
        # liability_attribution (priority 2)
        LiabilityParty,
        LiabilityAttributionRecord,
        LiabilityAttributionInput,
        ROLE_WEIGHTS,
        build_liability_chain,
        compute_liability_weights,
        validate_liability_chain,
        find_primary_liability_parties,
        compute_chain_hash,
        # financial_quorum (priority 3)
        FinancialQuorumPolicy,
        FinancialQuorumInput,
        FinancialQuorumResult,
        AmountThreshold,
        FinancialRoleRequirement,
        EmergencyFreeze,
        evaluate_financial_quorum,
        compute_escalated_approval_count,
        # budgetary_governance (priority 4)
        BudgetPolicy,
        BudgetLimit,
        BudgetSpendingState,
        SpendingConstraint,
        BudgetViolation,
        BudgetConstraintCheckResult,
        check_budget_constraints,
        budget_utilization_severity,
        # autonomous_financial (priority 5)
        AutonomousExecutionBounds,
        ExecutionCeiling,
        AutonomousExecutionRecord,
        AutonomousExecutionCheckResult,
        check_autonomous_bounds,
        detect_autonomous_anomaly,
    )
"""

from ._canonical import canonicalize_for_evidence
from .autonomous_financial import (
    AutonomousExecutionBounds,
    AutonomousExecutionCheckResult,
    AutonomousExecutionRecord,
    ExecutionCeiling,
    check_autonomous_bounds,
    detect_autonomous_anomaly,
)
from .budgetary_governance import (
    BudgetConstraintCheckResult,
    BudgetLimit,
    BudgetPolicy,
    BudgetSpendingState,
    BudgetViolation,
    SpendingConstraint,
    budget_utilization_severity,
    check_budget_constraints,
)
from .economic_evidence import (
    ApprovalProvenance,
    EconomicEvidenceBundle,
    EvidenceBundleSignableContent,
    EvidenceBundleVerificationResult,
    EvidencePurpose,
    build_signable_content,
    compute_content_hash,
    serialize_signable_content,
    verify_evidence_bundle_structure,
)
from .financial_action import (
    DEFAULT_RISK_TIER_THRESHOLDS,
    CurrencyCode,
    FinancialActionClass,
    FinancialActionType,
    FinancialExecutionRecord,
    FinancialExecutionStatus,
    FinancialRiskTier,
    LiabilityClassification,
    RiskTierThreshold,
    classify_risk_tier,
    within_autonomous_ceiling,
)
from .financial_quorum import (
    AmountThreshold,
    EmergencyFreeze,
    FinancialQuorumInput,
    FinancialQuorumPolicy,
    FinancialQuorumResult,
    FinancialRoleRequirement,
    compute_escalated_approval_count,
    evaluate_financial_quorum,
)
from .liability_attribution import (
    ROLE_WEIGHTS,
    LiabilityAttributionInput,
    LiabilityAttributionRecord,
    LiabilityChainValidation,
    LiabilityParty,
    LiabilityPartyRole,
    WeightDistribution,
    build_liability_chain,
    compute_chain_hash,
    compute_liability_weights,
    find_primary_liability_parties,
    validate_liability_chain,
)

__all__ = [
    # canonical helper (exported for tests + consumers needing byte-exact bundles)
    "canonicalize_for_evidence",
    # financial_action
    "DEFAULT_RISK_TIER_THRESHOLDS",
    "CurrencyCode",
    "FinancialActionClass",
    "FinancialActionType",
    "FinancialExecutionRecord",
    "FinancialExecutionStatus",
    "FinancialRiskTier",
    "LiabilityClassification",
    "RiskTierThreshold",
    "classify_risk_tier",
    "within_autonomous_ceiling",
    # economic_evidence
    "ApprovalProvenance",
    "EconomicEvidenceBundle",
    "EvidenceBundleSignableContent",
    "EvidenceBundleVerificationResult",
    "EvidencePurpose",
    "build_signable_content",
    "compute_content_hash",
    "serialize_signable_content",
    "verify_evidence_bundle_structure",
    # liability_attribution
    "ROLE_WEIGHTS",
    "LiabilityAttributionInput",
    "LiabilityAttributionRecord",
    "LiabilityChainValidation",
    "LiabilityParty",
    "LiabilityPartyRole",
    "WeightDistribution",
    "build_liability_chain",
    "compute_chain_hash",
    "compute_liability_weights",
    "find_primary_liability_parties",
    "validate_liability_chain",
    # financial_quorum
    "AmountThreshold",
    "EmergencyFreeze",
    "FinancialQuorumInput",
    "FinancialQuorumPolicy",
    "FinancialQuorumResult",
    "FinancialRoleRequirement",
    "compute_escalated_approval_count",
    "evaluate_financial_quorum",
    # budgetary_governance
    "BudgetConstraintCheckResult",
    "BudgetLimit",
    "BudgetPolicy",
    "BudgetSpendingState",
    "BudgetViolation",
    "SpendingConstraint",
    "budget_utilization_severity",
    "check_budget_constraints",
    # autonomous_financial
    "AutonomousExecutionBounds",
    "AutonomousExecutionCheckResult",
    "AutonomousExecutionRecord",
    "ExecutionCeiling",
    "check_autonomous_bounds",
    "detect_autonomous_anomaly",
]
