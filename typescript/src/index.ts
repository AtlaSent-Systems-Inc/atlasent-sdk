/**
 * @atlasent/sdk — execution-time authorization for AI agents.
 *
 * Primary API is the default export:
 *
 * ```ts
 * import atlasent from "@atlasent/sdk";
 *
 * const permit = await atlasent.protect({
 *   agent: "deploy-bot",
 *   action: "deployment.production",
 *   context: { commit, approver },
 * });
 * ```
 *
 * For dangerous operations use `requirePermit` — the executor only
 * runs when AtlaSent authorizes it end-to-end:
 *
 * ```ts
 * await atlasent.requirePermit(
 *   { action_type: "database.table.drop", actor_id: "agent:code-agent",
 *     resource_id: "prod-db.users", environment: "production",
 *     context: { reversibility: "irreversible" } },
 *   async () => { await db.raw("DROP TABLE users"); },
 * );
 * ```
 *
 * Named exports remain available for the lower-level
 * {@link AtlaSentClient} and the error taxonomy.
 */

import { AtlaSentClient } from "./client.js";
import { verifyBundle } from "./auditBundle.js";
import { AtlaSentDeniedError, AtlaSentError } from "./errors.js";
import { configure, deployGate, protect } from "./protect.js";
import { requirePermit, classifyCommand } from "./requirePermit.js";
import { DEPLOYMENT_PRODUCTION_ACTION } from "./types.js";

export { AtlaSentClient } from "./client.js";
export { DEPLOYMENT_PRODUCTION_ACTION } from "./types.js";
export {
  AtlaSentDeniedError,
  AtlaSentError,
  StreamParseError,
  StreamTimeoutError,
  normalizePermitOutcome,
  type AtlaSentDecision,
  type AtlaSentDeniedErrorInit,
  type AtlaSentErrorCode,
  type AtlaSentErrorInit,
  type PermitOutcome,
} from "./errors.js";
export {
  configure,
  deployGate,
  protect,
  type ConfigureOptions,
  type Permit,
  type ProtectRequest,
} from "./protect.js";
export {
  requirePermit,
  classifyCommand,
  type ProtectedAction,
} from "./requirePermit.js";
export type {
  ApiKeySelfResponse,
  AtlaSentClientOptions,
  AuditEventsResult,
  AuditExportRequest,
  AuditExportResult,
  ConstraintTrace,
  ConstraintTracePolicy,
  ConstraintTraceStage,
  Decision,
  DecisionCanonical,
  DeployGateEvidence,
  DeployGateRequest,
  DeployGateResponse,
  EvaluatePreflightResponse,
  EvaluateRequest,
  EvaluateResponse,
  GetPermitResponse,
  ListPermitsRequest,
  ListPermitsResponse,
  PermitRecord,
  PermitStatus,
  RateLimitState,
  RevokePermitByIdInput,
  RevokePermitByIdResponse,
  RevokePermitRequest,
  RevokePermitResponse,
  VerifyPermitByIdResponse,
  StreamDecisionEvent,
  StreamEvent,
  StreamOptions,
  StreamProgressEvent,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";
export {
  canonicalJSON,
  signedBytesFor,
  verifyAuditBundle,
  verifyBundle,
  type AuditBundle,
  type BundleVerificationResult,
  type VerifyBundleOptions,
  type VerifyKey,
} from "./auditBundle.js";
export type {
  AuditDecision,
  AuditEvent,
  AuditEventsPage,
  AuditEventsQuery,
  AuditExport,
  AuditExportSignatureStatus,
} from "./audit.js";
export {
  DEFAULT_RETRY_POLICY,
  computeBackoffMs,
  hasAttemptsLeft,
  isRetryable,
  mergePolicy,
  type RetryPolicy,
} from "./retry.js";
export {
  normalizeEvaluateRequest,
  normalizeEvaluateResponse,
  type LegacyEvaluateRequest,
  type LegacyEvaluateResponse,
  type V2EvaluateRequest,
  type V2EvaluateResponse,
} from "./compat.js";
export {
  hitlRequiredApproverCount,
  type HitlAiUnavailableFallback,
  type HitlApprovalRecord,
  type HitlApproveRequest,
  type HitlApproverPoolEntry,
  type HitlApproverType,
  type HitlChainHop,
  type HitlEscalateRequest,
  type HitlEscalation,
  type HitlFallbackDecision,
  type HitlHeterogeneousQuorumExtension,
  type HitlHeterogeneousQuorumTally,
  type HitlQuorumProgress,
  type HitlQuorumTier,
  type HitlRejectRequest,
  type HitlStatus,
  type ListHitlEscalationsRequest,
  type ListHitlEscalationsResponse,
} from "./hitl.js";
export {
  isSandboxDiffPopulated,
  type SandboxDiff,
  type SandboxDiffEmpty,
  type SandboxDiffPerTable,
  type SandboxDiffResponse,
  type SandboxRunMode,
  type SandboxRunStatus,
  type SandboxRunWrite,
  type SandboxWriteOp,
} from "./sandboxDiff.js";
export {
  delegationPropagationHadEffect,
  type DelegationPropagationSummary,
} from "./delegationPropagation.js";
export type {
  ApprovalArtifactV1,
  ApprovalIssuer,
  ApprovalReference,
  ApprovalReviewer,
  PrincipalKind,
} from "./approvalArtifact.js";
export type {
  IdentityAssertionBinding,
  IdentityAssertionV1,
  IdentityIssuer,
  IdentityIssuerKey,
  IdentitySubject,
  IdentityTrustedIssuersConfig,
} from "./identityAssertion.js";
export type {
  ApprovalQuorumV1,
  QuorumIndependence,
  QuorumPolicy,
  QuorumProof,
  QuorumRoleRequirement,
} from "./approvalQuorum.js";

// ── Economic Governance & Liability Attribution ────────────────────────────────────

export {
  DEFAULT_RISK_TIER_THRESHOLDS,
  classifyRiskTier,
  withinAutonomousCeiling,
  type CurrencyCode,
  type FinancialActionClass,
  type FinancialActionType,
  type FinancialExecutionRecord,
  type FinancialExecutionStatus,
  type FinancialRiskTier,
  type LiabilityClassification,
  type RiskTierThreshold,
} from "./financialAction.js";

export {
  buildLiabilityChain,
  computeLiabilityWeights,
  findPrimaryLiabilityParties,
  validateLiabilityChain,
  type LiabilityAttributionInput,
  type LiabilityAttributionRecord,
  type LiabilityChainValidation,
  type LiabilityParty,
  type LiabilityPartyRole,
  type WeightDistribution,
} from "./liabilityAttribution.js";

export {
  computeApprovalRiskScore,
  computeExposureScore,
  computeHHI,
  computeOverallRiskScore,
  computeOverrideScore,
  detectSelfApproval,
  hhiToConcentrationScore,
  scoreToRiskTier,
  type AnomalyType,
  type ApprovalConcentrationAnalysis,
  type ApproverBreakdown,
  type BudgetaryDriftAnalysis,
  type ConcentrationAlert,
  type ExecutionAnomaly,
  type FinancialRiskScore,
  type RiskFactor,
} from "./economicRisk.js";

export {
  computeEscalatedApprovalCount,
  evaluateFinancialQuorum,
  type AmountThreshold,
  type EmergencyFreeze,
  type FinancialQuorumInput,
  type FinancialQuorumPolicy,
  type FinancialQuorumResult,
  type FinancialRoleRequirement,
} from "./financialQuorum.js";

export {
  budgetUtilizationSeverity,
  checkBudgetConstraints,
  type BudgetConstraintCheckResult,
  type BudgetLimit,
  type BudgetPolicy,
  type BudgetScope,
  type BudgetSpendingState,
  type BudgetViolation,
  type SpendingConstraint,
} from "./budgetaryGovernance.js";

export {
  checkAutonomousBounds,
  detectAutonomousAnomaly,
  type AutonomousExecutionBounds,
  type AutonomousExecutionCheckResult,
  type AutonomousExecutionRecord,
  type ExecutionCeiling,
} from "./autonomousFinancial.js";

export {
  DEFAULT_INCENTIVE_CONFIG,
  computeGovernanceHealthScore,
  detectMisalignedIncentives,
  type GovernanceBehaviorPattern,
  type IncentiveAlignmentConfig,
  type IncentiveSignal,
  type IncentiveSignalType,
  type MisalignmentAlert,
} from "./incentiveAlignment.js";

export {
  buildSignableContent,
  canonicalizeForEvidence,
  serializeSignableContent,
  verifyEvidenceBundleStructure,
  type ApprovalProvenance,
  type EconomicEvidenceBundle,
  type EvidenceBundleSignableContent,
  type EvidenceBundleVerificationResult,
  type EvidencePurpose,
} from "./economicEvidence.js";

export {
  computeRemediationUrgency,
  isFreezeActive,
  transitionDispute,
  transitionReversal,
  type ActionFreeze,
  type DisputeOrigin,
  type DisputeRecord,
  type DisputeStatus,
  type ReversalStage,
  type ReversalWorkflow,
} from "./disputeReversal.js";

export {
  buildLiabilityVisualization,
  buildRiskTimeline,
  type ActionTypeOverrideStat,
  type ActorOverrideStat,
  type DisputeReversalSummary,
  type FinancialGovernanceSummary,
  type LiabilityEdge,
  type LiabilityNode,
  type LiabilityVisualization,
  type OverrideAnalytics,
  type RiskTimelinePoint,
} from "./financialDashboard.js";

// ── Governance enforcement layer (fail-closed helpers on top of the advisory primitives) ──
export {
  GovernanceEnforcementError,
  enforceAutonomousBounds,
  enforceBudgetConstraint,
  enforceEconomicGovernance,
  enforceFinancialQuorum,
  type AutonomousBoundsDenyCode,
  type BudgetDenyCode,
  type FinancialQuorumDenyCode,
  type GovernanceEnforcementErrorInit,
  type GovernanceGate,
} from "./governanceEnforcement.js";

// ── Governance Webhooks, Compliance Evidence & Policy Sync ─────────────────────────

export {
  verifyWebhookSignature,
  type CreateWebhookSubscriptionRequest,
  type EnforcementWebhookEvent,
  type GovernanceWebhookEvent,
  type ListWebhookDeliveriesResponse,
  type ListWebhookSubscriptionsResponse,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookPayload,
  type WebhookSubscription,
} from "./governanceWebhooks.js";

export {
  evidenceRunPasses,
  nonPassingControls,
  type ComplianceEvidenceRun,
  type ComplianceEvidenceSummary,
  type ComplianceFramework,
  type ComplianceRunStatus,
  type EvidenceControl,
  type EvidenceControlStatus,
  type ListEvidenceRunsResponse,
  type SOC2ControlId,
  type TriggerEvidenceRunRequest,
  type TriggerEvidenceRunResponse,
} from "./complianceEvidence.js";

export {
  formatPolicySyncDiff,
  isPolicySyncTerminal,
  type ApplyPolicySyncResponse,
  type ListPolicySyncRunsResponse,
  type PolicyBundleEntry,
  type PolicyRef,
  type PolicySyncDiff,
  type PolicySyncRun,
  type PolicySyncStatus,
  type SubmitPolicySyncRequest,
  type SubmitPolicySyncResponse,
} from "./policySync.js";

export {
  assertWebhook,
  verifyWebhook,
  WebhookVerificationError,
} from "./webhook.js";

// ── Governance Graph & Incident Reconstruction ──────────────────────────────────

export type {
  GovernanceGraphQueryType,
  GovernanceGraphQueryParams,
  GovernanceGraphQueryResponse,
  GovernanceGraphResultRow,
  GraphNodeType,
  GraphEdgeType,
  GraphNode,
  GraphEdge,
  ProductionDeployerRow,
  ExecutionApproverRow,
  QuorumBypassConnectorRow,
  EmergencyOverrideActionRow,
  ConnectedSystemRow,
  UserApprovalRow,
  ListGraphNodesResponse,
  ListGraphEdgesResponse,
  CreateGraphNodeInput,
  CreateGraphEdgeInput,
} from "./governanceGraph.js";

export type {
  IncidentChainExecutionRow,
  IncidentChainActorEntry,
  IncidentChainEvidenceRow,
  IncidentTimelineResponse,
} from "./incidentReconstruction.js";

// ── Connector Management & Organizational Risk Graph ─────────────────────────────

export type {
  ConnectorType,
  ConnectorStatus,
  ConnectorRow,
  ConnectorCredentialType,
  ConnectorCredentialRow,
  EnforcementAction,
  EnforcementQuorumConfig,
  ConnectorEnforcementPolicy,
  ConnectorAuditLogEntry,
  ConnectorSyncState,
  ConnectorEnforcementEventInput,
  ConnectorEnforcementResult,
  InstallConnectorInput,
  AuthenticateConnectorInput,
  UpsertEnforcementPolicyInput,
  ListConnectorsResponse,
  InstallConnectorResponse,
  AuthenticateConnectorResponse,
  SyncConnectorResponse,
  RevokeConnectorResponse,
  RotateCredentialsResponse,
  ListEnforcementPoliciesResponse,
  UpsertEnforcementPolicyResponse,
} from "./connectorManagement.js";

export type {
  OrgRiskLevel,
  OrgRiskScore,
  ComputeOrgRiskOptions,
  ComputeOrgRiskResponse,
  GetLatestOrgRiskResponse,
  ListOrgRiskHistoryResponse,
} from "./orgRiskGraph.js";
// ── Cross-Org Permission Negotiation ────────────────────────────────

export {
  summarizeCrossOrgPermission,
  type CrossOrgPermissionCheckListParams,
  type CrossOrgPermissionCheckRequest,
  type CrossOrgPermissionCheckResult,
  type CrossOrgTrustHop,
} from "./crossOrgPermission.js";

// ── Anomaly Response Automation ───────────────────────────────────

export {
  highestSeverityAction,
  matchAnomalyRules,
  type AnomalyActionType,
  type AnomalyResponseEvent,
  type AnomalyResponseRule,
  type CreateAnomalyResponseRuleRequest,
  type TriggerAnomalyResponseRequest,
} from "./anomalyResponse.js";

// ── Budget Exception Workflows ──────────────────────────────────────

export {
  isBudgetExceptionActive,
  isBudgetExceptionTerminal,
  type ApproveBudgetExceptionRequest,
  type BudgetExceptionRequest,
  type BudgetExceptionStatus,
  type CreateBudgetExceptionRequest,
} from "./budgetExceptions.js";

// ── Regulatory Escalation Chain ────────────────────────────────────

export {
  isEscalationSlaBreached,
  isRegulatoryEscalationTerminal,
  type CreateRegulatoryEscalationRequest,
  type RegulatoryAuthorityLevel,
  type RegulatoryEscalation,
  type RegulatoryEscalationStatus,
} from "./regulatoryEscalation.js";

// ── Incentive Signal Feedback Loop ────────────────────────────────

export {
  computeSignalEngagementRate,
  isSubstantiveSignalResponse,
  type GovernanceSignalAction,
  type RecordSignalActionRequest,
  type RecordSignalOutcomeRequest,
  type SignalActionSummary,
  type SignalActionType,
} from "./incentiveSignalFeedback.js";

// ── Cross-Org Impersonation ───────────────────────────────────────

export {
  clampTokenDuration,
  isImpersonationGrantUsable,
  type CreateImpersonationGrantRequest,
  type CrossOrgImpersonationGrant,
  type ImpersonationToken,
  type ImpersonationValidationResult,
} from "./crossOrgImpersonation.js";

/**
 * Default export. The opinionated, category-defining entry point:
 *
 * ```ts
 * import atlasent from "@atlasent/sdk";
 * await atlasent.protect({ ... });
 * await atlasent.requirePermit({ ... }, executor);
 * ```
 */
const atlasent = {
  protect,
  deployGate,
  configure,
  requirePermit,
  classifyCommand,
  verifyBundle,
  DEPLOYMENT_PRODUCTION_ACTION,
  AtlaSentClient,
  AtlaSentError,
  AtlaSentDeniedError,
} as const;

export default atlasent;
