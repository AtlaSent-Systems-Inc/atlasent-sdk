"""AtlaSent SDK — execution-time authorization for AI agents.

Fail-closed by design: any failure to confirm authorization raises
an exception, so no action can proceed without an explicit permit.

Quick start::

    from atlasent import protect

    permit = protect(
        agent="deploy-bot",
        action="production.deploy",
        context={"commit": commit, "approver": approver},
    )
    # If we got here, the action is authorized end-to-end.
    # Otherwise protect() raised and the action never ran.

Canonical surface — three primitives, each with a distinct
lifecycle:

- :func:`atlasent.protect` — fail-closed execution primitive.
  Use when the caller wants "no permit, no execution." Raises on
  ``deny``, ``hold``, ``escalate``, or verification failure.
- :func:`atlasent.evaluate` — raw decision primitive. Use when the
  caller needs to inspect the four-value decision
  (``allow`` / ``deny`` / ``hold`` / ``escalate``). Does not
  collapse states; does not pretend denial is a permit path.
- :func:`atlasent.verify` — post-permit verification primitive,
  for callers that already hold a permit token.

``authorize()`` and ``gate()`` are deprecated legacy convenience
wrappers and will be removed in ``atlasent`` v3. Migrate to
``protect()`` (for fail-closed) or ``evaluate()`` (to inspect).
"""

from ._version import __version__
from .access_governance_log import AccessGovernanceLogClient
from .approval_artifact import (
    ApprovalArtifactV1,
    ApprovalIssuer,
    ApprovalQuorumV1,
    ApprovalReference,
    ApprovalReviewer,
    ApprovalTrustedIssuersConfig,
    IdentityAssertionBinding,
    IdentityAssertionV1,
    IdentityIssuer,
    IdentityIssuerKey,
    IdentitySubject,
    IdentityTrustedIssuersConfig,
    PermitApprovalBinding,
    PrincipalKind,
    QuorumIndependence,
    QuorumPolicy,
    QuorumProof,
    QuorumRoleRequirement,
    TrustedIssuerKey,
)
from .async_client import AsyncAtlaSentClient
from .audit import (
    AuditDecision,
    AuditEvent,
    AuditEventsResult,
    AuditExportResult,
    AuditExportSignatureStatus,
)
from .audit_bundle import (
    BundleVerificationResult,
    VerifyKey,
    verify_audit_bundle,
    verify_bundle,
)
from .authorize import authorize, evaluate, gate, protect, verify
from .bccae import BCCAEClient, generate_bccae_nonce
from .billing import (
    AccessStatus,
    AdminOverrideRequest,
    AdminOverrideResponse,
    AllowedAction,
    AsyncBillingClient,
    BillingClient,
    BillingEntitlement,
    BillingMode,
    BillingWebhookSubscription,
    DenyReason,
    InvoiceStatus,
    verify_billing_webhook_signature,
)
from .cache import TTLCache
from .claim_lineage import (
    NOT_APPLICABLE,
    ActionBundleInput,
    ActionBundleReceipt,
    ApprovalArtifactSlot,
    ClaimEvidenceLink,
    DeltaSlot,
    DeltaStatus,
    DeployEvidenceInput,
    DeployEvidenceSlot,
    DriftChangeType,
    DriftDetail,
    DriftSeverity,
    EvidenceSlotStatus,
    HitlChainSummaryInput,
    IntegrationEvidenceInput,
    IntegrationEvidenceSlot,
    NotApplicable,
    RuntimeEvidenceInput,
    RuntimeEvidenceSlot,
    SignedApprovalArtifactInput,
    VerificationChecklist,
    VerifyClaimEvidenceLinkResult,
    build_claim_evidence_link,
    build_claim_evidence_link_from_action_bundle,
    verify_claim_evidence_link,
)
from .client import AtlaSentClient
from .compliance_evidence import (
    ComplianceEvidenceRun,
    ControlStatus,
    EvidenceControl,
    EvidenceRunSummary,
    SOC2ControlId,
    evidence_run_passes,
    non_passing_controls,
)
from .config import configure
from .context_envelope import (
    CONTEXT_NAMESPACES,
    ContextEnvelope,
    ContextNamespaceEntry,
    ContextSignal,
    RecordContextEnvelopeInput,
)
from .evidence_engine import (
    ActionEvidenceBundle,
    ComplianceControlCoverage,
    DecisionReceipt,
    DecisionReceiptPayload,
    WhyPolicyEvaluation,
    WhyStage,
    WhyTrace,
)
from .evidence_exports import (
    create_evidence_export,
    get_evidence_export,
    list_evidence_exports,
)
from .exceptions import (
    AtlaSentDecision,
    AtlaSentDenied,
    AtlaSentDeniedError,
    AtlaSentError,
    AtlaSentErrorCode,
    BundleVerificationError,
    ConfigurationError,
    PermissionDeniedError,
    PermitOutcome,
    RateLimitError,
    StreamParseError,
    StreamTimeoutError,
)
from .governance_agents import (
    AgentEvidenceRef,
    GovernanceAgent,
    GovernanceAgentEvaluation,
    GovernanceAgentFinding,
    ListGovernanceAgentsResult,
    ListGovernanceEvaluationsResult,
    ListGovernanceFindingsResult,
    highest_agent_finding_severity,
)
from .governance_webhooks import (
    EnforcementWebhookEvent,
    GovernanceWebhookEvent,
    WebhookDelivery,
    WebhookDeliveryStatus,
    WebhookPayload,
    WebhookSubscription,
    verify_webhook_signature,
)
from .guard import async_atlasent_guard, atlasent_guard
from .hitl import (
    HitlApprovalRecord,
    HitlApprovalsResult,
    HitlChainHop,
    HitlChainResult,
    HitlCreateRequest,
    HitlEscalation,
    HitlEscalationResult,
    HitlFallbackDecision,
    HitlQuorumProgress,
    HitlQuorumTier,
    HitlStatus,
    ListHitlEscalationsResult,
    hitl_required_approver_count,
)
from .models import (
    ApiKeySelfResult,
    AuthError,
    AuthorizationResult,
    ConstraintTrace,
    ConstraintTracePolicy,
    ConstraintTraceStage,
    DecisionValue,
    EnforcementOutcome,
    EvaluatePreflightResult,
    EvaluateResult,
    EvaluateRiskEnvelope,
    EvaluateRiskEnvelopeFactor,
    GateResult,
    GetPermitResult,
    GovernanceDecision,
    LicenseStatus,
    LicenseVerifyResult,
    ListPermitsResult,
    Permit,
    PermitRecord,
    PermitVerifyEvidence,
    RateLimitState,
    ReplayResponse,
    ReplayVarianceKind,
    RevokePermitByIdResult,
    RevokePermitResult,
    StreamDecisionEvent,
    StreamEvent,
    StreamProgressEvent,
    VerifyPermitByIdResult,
    VerifyResult,
)
from .models import (
    CompletionProof as CompletionProof,
)
from .policy_sync import (
    PolicyBundleEntry,
    PolicySyncDiff,
    PolicySyncRun,
    PolicySyncStatus,
    SubmitPolicySyncRequest,
    format_policy_sync_diff,
    is_policy_sync_terminal,
)
from .replay import EvidenceVerificationResult, verify_evidence_bundle
from .require_permit import (
    CanonicalProtectedActionType,
    ProtectedAction,
    classify_command,
    require_permit,
)
from .runtime_v2 import (
    AuditChainPage,
    AuthorityRecord,
    AuthorizationDecision,
    ChainIntegrityReport,
    ComplianceExport,
    ExecutionReceipt,
    PostExecutionResult,
    RuntimeAuditEntry,
    RuntimeV2Client,
    VerificationFailure,
    VerificationResult,
    runtime,
)
from .scim import (
    SCIM_GROUP_SCHEMA,
    SCIM_PATCH_OP_SCHEMA,
    SCIM_USER_SCHEMA,
    scim_create_group,
    scim_create_user,
    scim_delete_group,
    scim_delete_user,
    scim_get_group,
    scim_get_user,
    scim_list_groups,
    scim_list_users,
    scim_patch_group,
    scim_patch_user,
    scim_replace_group,
    scim_replace_user,
)
from .siem import (
    get_siem_config,
    siem_test_delivery,
    upsert_siem_config,
)
from .sso_client import SsoClient
from .trust_root import (
    TrustRootKey,
    TrustRootManager,
    TrustRootRevocationEntry,
    TrustRootSnapshot,
    _set_global_trust_root_manager_for_tests,
    get_global_trust_root_manager,
)
from .v2_endpoints import (
    BATCH_PATH as V2_BATCH_PATH,
)
from .v2_endpoints import (
    GRAPHQL_PATH as V2_GRAPHQL_PATH,
)
from .v2_endpoints import (
    MAX_BATCH_ITEMS as V2_MAX_BATCH_ITEMS,
)
from .v2_endpoints import (
    STREAM_PATH as V2_STREAM_PATH,
)
from .v2_endpoints import (
    EvaluateBatchItem,
    EvaluateBatchResponse,
    FeatureNotEnabledError,
    GraphQLResponse,
    StreamComplete,
    StreamDecision,
    StreamErrorFrame,
    authorize_stream,
    evaluate_many,
    graphql,
)
from .verticals.access_cert import (
    protect_access_cert_action,
    protect_access_cert_revoke,
)
from .verticals.contract_actions import (
    protect_contract_action,
    protect_contract_execution,
)
from .verticals.data_delete import protect_customer_data_delete
from .verticals.database_actions import (
    protect_database_action,
    protect_database_migration,
    protect_database_schema_drop,
    protect_database_table_delete,
)
from .verticals.financial_close import (
    protect_financial_close_action,
    protect_period_close_certify,
)

# Verticals — domain-specific protect() convenience wrappers.
from .verticals.hr_actions import (
    protect_hr_action,
    protect_hr_offboard,
    protect_hr_role_escalate,
)
from .verticals.model_governance import (
    protect_model_governance,
    protect_model_promotion,
)
from .verticals.pricing_actions import (
    protect_pricing_action,
    protect_pricing_rule,
)
from .verticals.security_actions import (
    protect_security_access_quarantine,
    protect_security_action,
    protect_security_incident_escalate,
)
from .webhook import WebhookVerificationError, assert_webhook, verify_webhook
from .with_permit import with_permit

#: Canonical Deploy Gate V1 protected action. Mirrors the TypeScript
#: SDK's ``PRODUCTION_DEPLOY_ACTION``. Use this string (or the constant)
#: when calling ``protect()``/``evaluate()`` for the production deploy
#: gate; the server alias-tolerates the legacy ``deployment.production``
#: during the V1 alias window.
PRODUCTION_DEPLOY_ACTION = "production.deploy"

__all__ = [
    "__version__",
    "PRODUCTION_DEPLOY_ACTION",
    "AtlaSentClient",
    "AsyncAtlaSentClient",
    "configure",
    "protect",
    "with_permit",
    # SCIM helpers + schema constants.
    "SCIM_USER_SCHEMA",
    "SCIM_GROUP_SCHEMA",
    "SCIM_PATCH_OP_SCHEMA",
    "scim_list_users",
    "scim_create_user",
    "scim_get_user",
    "scim_replace_user",
    "scim_patch_user",
    "scim_delete_user",
    "scim_list_groups",
    "scim_create_group",
    "scim_get_group",
    "scim_replace_group",
    "scim_patch_group",
    "scim_delete_group",
    # SIEM helpers.
    "get_siem_config",
    "upsert_siem_config",
    "siem_test_delivery",
    "require_permit",
    "classify_command",
    "ProtectedAction",
    "CanonicalProtectedActionType",
    "WhyTrace",
    "WhyPolicyEvaluation",
    "WhyStage",
    "DecisionReceipt",
    "DecisionReceiptPayload",
    "ActionEvidenceBundle",
    "ComplianceControlCoverage",
    "ContextEnvelope",
    "ContextSignal",
    "ContextNamespaceEntry",
    "RecordContextEnvelopeInput",
    "CONTEXT_NAMESPACES",
    "authorize",
    "evaluate",
    "verify",
    "gate",
    "DecisionValue",
    "Permit",
    "AuthorizationResult",
    "EvaluateResult",
    "EvaluateRiskEnvelope",
    "EvaluateRiskEnvelopeFactor",
    "EvaluatePreflightResult",
    "ConstraintTrace",
    "ConstraintTracePolicy",
    "ConstraintTraceStage",
    "VerifyResult",
    "RateLimitState",
    "ReplayResponse",
    "ReplayVarianceKind",
    "ApiKeySelfResult",
    "GateResult",
    "AtlaSentError",
    "AtlaSentErrorCode",
    "AtlaSentDecision",
    "AtlaSentDenied",
    "AtlaSentDeniedError",
    "BundleVerificationError",
    "PermissionDeniedError",
    "PermitOutcome",
    "BundleVerificationError",
    "ConfigurationError",
    "RateLimitError",
    "StreamTimeoutError",
    "StreamParseError",
    "atlasent_guard",
    "async_atlasent_guard",
    "TTLCache",
    "verify_bundle",
    "verify_audit_bundle",
    "BundleVerificationResult",
    "VerifyKey",
    "AuditDecision",
    "AuditEvent",
    "AuditEventsResult",
    "AuditExportResult",
    "AuditExportSignatureStatus",
    "RevokePermitResult",
    "RevokePermitByIdResult",
    "VerifyPermitByIdResult",
    "PermitVerifyEvidence",
    "GetPermitResult",
    "LicenseStatus",
    "LicenseVerifyResult",
    "ListPermitsResult",
    "PermitRecord",
    "StreamDecisionEvent",
    "StreamProgressEvent",
    "StreamEvent",
    # Phase 7 typed models (provisional — see models.py).
    "GovernanceDecision",
    "AuthError",
    "EnforcementOutcome",
    # Governance agents read surface (parity with @atlasent/sdk 2.6.0).
    "GovernanceAgent",
    "GovernanceAgentFinding",
    "GovernanceAgentEvaluation",
    "AgentEvidenceRef",
    "ListGovernanceAgentsResult",
    "ListGovernanceFindingsResult",
    "ListGovernanceEvaluationsResult",
    "highest_agent_finding_severity",
    # HITL orchestration surface (parity with the TS SDK).
    "HitlApprovalRecord",
    "HitlApprovalsResult",
    "HitlChainHop",
    "HitlChainResult",
    "HitlCreateRequest",
    "HitlEscalation",
    "HitlEscalationResult",
    "HitlFallbackDecision",
    "HitlQuorumProgress",
    "HitlQuorumTier",
    "HitlStatus",
    "ListHitlEscalationsResult",
    "hitl_required_approver_count",
    # Approval artifact contract surface (parity with the TS SDK).
    "ApprovalArtifactV1",
    "ApprovalIssuer",
    "ApprovalQuorumV1",
    "ApprovalReference",
    "ApprovalReviewer",
    "ApprovalTrustedIssuersConfig",
    "IdentityAssertionBinding",
    "IdentityAssertionV1",
    "IdentityIssuer",
    "IdentityIssuerKey",
    "IdentitySubject",
    "IdentityTrustedIssuersConfig",
    "PermitApprovalBinding",
    "PrincipalKind",
    "QuorumIndependence",
    "QuorumPolicy",
    "QuorumProof",
    "QuorumRoleRequirement",
    "TrustedIssuerKey",
    # Governance webhooks (parity with the TS SDK).
    "GovernanceWebhookEvent",
    "EnforcementWebhookEvent",
    "WebhookSubscription",
    "WebhookDelivery",
    "WebhookDeliveryStatus",
    "WebhookPayload",
    "verify_webhook_signature",
    # Claims evidence lineage (parity with the TS SDK).
    "ClaimEvidenceLink",
    "RuntimeEvidenceSlot",
    "DeployEvidenceSlot",
    "IntegrationEvidenceSlot",
    "ApprovalArtifactSlot",
    "ActionBundleInput",
    "ActionBundleReceipt",
    "DeltaSlot",
    "DeltaStatus",
    "DriftDetail",
    "DriftChangeType",
    "DriftSeverity",
    "EvidenceSlotStatus",
    "VerificationChecklist",
    "NotApplicable",
    "NOT_APPLICABLE",
    "RuntimeEvidenceInput",
    "DeployEvidenceInput",
    "IntegrationEvidenceInput",
    "HitlChainSummaryInput",
    "SignedApprovalArtifactInput",
    "VerifyClaimEvidenceLinkResult",
    "build_claim_evidence_link",
    "build_claim_evidence_link_from_action_bundle",
    "verify_claim_evidence_link",
    # Compliance evidence (parity with the TS SDK).
    "SOC2ControlId",
    "ControlStatus",
    "EvidenceControl",
    "EvidenceRunSummary",
    "ComplianceEvidenceRun",
    "evidence_run_passes",
    "non_passing_controls",
    # Policy sync (parity with the TS SDK).
    "PolicySyncStatus",
    "PolicyBundleEntry",
    "PolicySyncDiff",
    "PolicySyncRun",
    "SubmitPolicySyncRequest",
    "format_policy_sync_diff",
    "is_policy_sync_terminal",
    # Billing entitlement + webhook management (enterprise grace period support).
    "AccessStatus",
    "AllowedAction",
    "AsyncBillingClient",
    "BillingClient",
    "BillingEntitlement",
    "BillingMode",
    "BillingWebhookSubscription",
    "DenyReason",
    "InvoiceStatus",
    "AdminOverrideRequest",
    "AdminOverrideResponse",
    "verify_billing_webhook_signature",
    # Webhook signature verification (parity with the TypeScript SDK).
    "verify_webhook",
    "assert_webhook",
    "WebhookVerificationError",
    # V2 Wave-A endpoints (V2-D3 batch, V2-D4 stream, V2-D8 graphql).
    # V1 substrate is frozen — these are additive and close-by-default
    # per tenant (FeatureNotEnabledError surfaces the 404 fall-back path).
    "FeatureNotEnabledError",
    "EvaluateBatchItem",
    "EvaluateBatchResponse",
    "StreamComplete",
    "StreamDecision",
    "StreamErrorFrame",
    "GraphQLResponse",
    "V2_BATCH_PATH",
    "V2_STREAM_PATH",
    "V2_GRAPHQL_PATH",
    "V2_MAX_BATCH_ITEMS",
    "evaluate_many",
    "authorize_stream",
    "graphql",
    # Phase 3 offline replay client — verify evidence bundles without backend.
    "verify_evidence_bundle",
    "SsoClient",
    "AccessGovernanceLogClient",
    "EvidenceVerificationResult",
    # BCCAE V1 — Phase 3 Execution Assurance substrate.
    # Standalone BCCAEClient with bccae:* scopes — not part of the
    # Deploy Gate V1 customer API surface.
    "BCCAEClient",
    "generate_bccae_nonce",
    # Evidence bundle exports (Wave B parity).
    "list_evidence_exports",
    "get_evidence_export",
    "create_evidence_export",
    # Trust-root V1 (bootstrap + snapshot management).
    "TrustRootKey",
    "TrustRootManager",
    "TrustRootRevocationEntry",
    "TrustRootSnapshot",
    "get_global_trust_root_manager",
    "_set_global_trust_root_manager_for_tests",
    # Verticals — domain-specific protect() convenience wrappers.
    # Phase 4: HR, model governance, data delete, contract, pricing.
    "protect_hr_action",
    "protect_hr_offboard",
    "protect_hr_role_escalate",
    "protect_model_governance",
    "protect_model_promotion",
    "protect_customer_data_delete",
    "protect_contract_action",
    "protect_contract_execution",
    "protect_pricing_action",
    "protect_pricing_rule",
    # Phase 5: security, access-cert, financial-close.
    "protect_security_action",
    "protect_security_incident_escalate",
    "protect_security_access_quarantine",
    "protect_access_cert_action",
    "protect_access_cert_revoke",
    "protect_financial_close_action",
    "protect_period_close_certify",
    # Phase 6: database actions.
    "protect_database_action",
    "protect_database_migration",
    "protect_database_schema_drop",
    "protect_database_table_delete",
    # Runtime v2 — four-plane authorized-state-change lifecycle.
    "RuntimeV2Client",
    "runtime",
    "AuthorizationDecision",
    "AuthorityRecord",
    "AuditChainPage",
    "ChainIntegrityReport",
    "ComplianceExport",
    "ExecutionReceipt",
    "PostExecutionResult",
    "RuntimeAuditEntry",
    "VerificationFailure",
    "VerificationResult",
]
