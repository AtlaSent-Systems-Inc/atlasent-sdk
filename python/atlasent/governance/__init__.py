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

The :mod:`atlasent.governance.enforcement` submodule layers fail-closed
helpers on top of the advisory primitives. See
``docs/APPROVAL_DENY_REASONS.md`` for the deny-code taxonomy.

Public API::

    from atlasent.governance import (
        # advisory layer (locked)
        classify_risk_tier,
        build_liability_chain,
        evaluate_financial_quorum,
        check_budget_constraints,
        check_autonomous_bounds,
        # enforcement layer
        enforce_financial_quorum,
        enforce_budget_constraint,
        enforce_autonomous_bounds,
        enforce_economic_governance,
        GovernanceEnforcementError,
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
from .enforcement import (
    AutonomousBoundsDenyCode,
    BudgetDenyCode,
    FinancialQuorumDenyCode,
    GovernanceEnforcementError,
    GovernanceGate,
    enforce_autonomous_bounds,
    enforce_budget_constraint,
    enforce_economic_governance,
    enforce_financial_quorum,
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
    # canonical helper
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
    # enforcement
    "AutonomousBoundsDenyCode",
    "BudgetDenyCode",
    "FinancialQuorumDenyCode",
    "GovernanceEnforcementError",
    "GovernanceGate",
    "enforce_autonomous_bounds",
    "enforce_budget_constraint",
    "enforce_economic_governance",
    "enforce_financial_quorum",
]
