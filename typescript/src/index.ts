/**
 * @atlasent/sdk — execution-time authorization for AI agents.
 *
 * The canonical execution-boundary surface is two forms of the same
 * contract. Both mint and verify a Permit end-to-end; both fail closed.
 * Pick the form that fits the call site.
 *
 * `protect` — the primitive. Returns the verified {@link Permit} so
 * the caller can pass it across a boundary, persist it alongside
 * their own record, or interleave it with non-trivial control flow:
 *
 * ```ts
 * import atlasent from "@atlasent/sdk";
 *
 * const permit = await atlasent.protect({
 *   agent: "deploy-bot",
 *   action: "production.deploy",
 *   context: { commit, approver },
 * });
 * // permit is verified end-to-end. Execute the action.
 * ```
 *
 * `withPermit` — the lexically-scoped form. Binds the action body to
 * the permit's lifetime via a callback so the call site reads as
 * "execute this body under a permit":
 *
 * ```ts
 * const result = await atlasent.withPermit(
 *   { agent: "deploy-bot", action: "production.deploy",
 *     context: { commit, approver } },
 *   async (permit) => runDeploy(commit, { permitId: permit.permitId }),
 * );
 * ```
 *
 * `requirePermit` — descriptor form for dangerous operations carrying
 * `resource_id` + `environment`. The executor only runs when AtlaSent
 * authorizes it end-to-end:
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
import { withPermit } from "./withPermit.js";
import {
  DEPLOYMENT_PRODUCTION_ACTION,
  PRODUCTION_DEPLOY_ACTION,
} from "./types.js";

export { AtlaSentClient } from "./client.js";
export {
  DEPLOY_GATE_CODES,
  DEPLOYMENT_PRODUCTION_ACTION,
  PRODUCTION_DEPLOY_ACTION,
} from "./types.js";
export {
  AtlaSentDeniedError,
  AtlaSentEscalateError,
  AtlaSentError,
  PermitRevoked,
  StreamParseError,
  StreamTimeoutError,
  normalizePermitOutcome,
  type AtlaSentDecision,
  type AtlaSentDeniedErrorInit,
  type AtlaSentEscalateErrorInit,
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
  type PermitWithEvidence,
  type ProtectRequest,
  type ProtectWithEvidenceOptions,
  protectWithEvidence,
} from "./protect.js";
export {
  requirePermit,
  classifyCommand,
  type ProtectedAction,
} from "./requirePermit.js";
export { withPermit } from "./withPermit.js";
export type {
  ApiKeySelfResponse,
  AtlaSentClientOptions,
  BvsSnapshot,
  ConsentClassProjection,
  AuditEventsResult,
  AuditExportRequest,
  AuditExportResult,
  ConstraintTrace,
  ConstraintTracePolicy,
  ConstraintTraceStage,
  Decision,
  DecisionCanonical,
  DeployGateContext,
  DeployGateDenyCode,
  DeployGateEvidence,
  DeployGateRequest,
  DeployGateResponse,
  DeployOverrideClaim,
  DeployPermitClaim,
  BatchEvalItem,
  BatchEvalResponse,
  DecisionStreamEvent,
  EvaluateBatchResultItem,
  EvaluatePreflightResponse,
  SubscribeDecisionsOptions,
  EvaluateRequest,
  EvaluateResponse,
  EvaluateResponsePermit,
  EvaluateRiskEnvelope,
  EvaluateRiskEnvelopeFactor,
  GetPermitResponse,
  ListPermitsRequest,
  ListPermitsResponse,
  PermitRecord,
  PermitStatus,
  PermitValidResponse,
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
export type {
  EngineVersionKind,
  EnvelopeDriftDetail,
  EnvelopeVerification,
  ReplayDecisionResponse,
  ReplayDecisionValue,
  ReplayRequest,
  ReplayResponse,
  ReplayVarianceKind,
  EvidenceBundleVerifyResult,
  OfflineEvidenceBundleData,
} from "./replay.js";
export {
  verifyEvidenceBundle,
  _computeEvidenceRootHash,
} from "./replay.js";
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
  type HitlCreateRequest,
  type HitlDetailResponse,
  type HitlEscalation,
  type HitlFallbackDecision,
  type HitlHeterogeneousQuorumExtension,
  type HitlHeterogeneousQuorumTally,
  type HitlListResponse,
  type HitlQuorumProgress,
  type HitlQuorumTier,
  type HitlRejectRequest,
  type HitlRespondRequest,
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

// ── V1 Proof bundle ──────────────────────────────────────────────────────────────────────────────────────
export type {
  GovernanceEvent,
  PermitV1,
} from "./v1Types.js";
export type {
  ProofEvaluationSummary,
  ProofPayload,
  ProofResponse,
} from "./proof.js";

// ── V1 Override types ────────────────────────────────────────────────────────────────────────────────────
export type {
  CreateOverrideRequest,
  OverrideEvent,
  OverrideEventsResponse,
  OverrideListResponse,
  OverrideStatus,
  OverrideEventType,
  OverrideV1,
} from "./overrides.js";
export type {
  TrustRootSnapshot,
  TrustRootKey,
  TrustRootRevocationEntry,
  TrustRootManagerOptions,
} from "./trustRoot.js";
export {
  TrustRootManager,
  getGlobalTrustRootManager,
  __setGlobalTrustRootManagerForTests,
} from "./trustRoot.js";

// ── Economic Governance & Liability Attribution ─────────────────────────────────────────────────────────────
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

// ── Governance enforcement layer ────────────────────────────────────────────────────────────────────────────────────────
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

// ── Governance Webhooks, Compliance Evidence & Policy Sync ────────────────────────────────────────────
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

// ── Governance Graph & Incident Reconstruction ────────────────────────────────────────────────
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

// ── Connector Management & Organizational Risk Graph ──────────────────────────────────────────────────────
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

// ── Cross-Org Permission Negotiation ────────────────────────────────────────────────────────────────────────────
export {
  summarizeCrossOrgPermission,
  type CrossOrgPermissionCheckListParams,
  type CrossOrgPermissionCheckRequest,
  type CrossOrgPermissionCheckResult,
  type CrossOrgTrustHop,
} from "./crossOrgPermission.js";

// ── Anomaly Response Automation ─────────────────────────────────────────────────────────────────────────────────────
export {
  highestSeverityAction,
  matchAnomalyRules,
  type AnomalyActionType,
  type AnomalyResponseEvent,
  type AnomalyResponseRule,
  type CreateAnomalyResponseRuleRequest,
  type TriggerAnomalyResponseRequest,
} from "./anomalyResponse.js";

// ── Budget Exception Workflows ──────────────────────────────────────────────────────────────────────────────────────────
export {
  isBudgetExceptionActive,
  isBudgetExceptionTerminal,
  type ApproveBudgetExceptionRequest,
  type BudgetExceptionRequest,
  type BudgetExceptionStatus,
  type CreateBudgetExceptionRequest,
} from "./budgetExceptions.js";

// ── Regulatory Escalation Chain ────────────────────────────────────────────────────────────────────────────────────
export {
  isEscalationSlaBreached,
  isRegulatoryEscalationTerminal,
  type CreateRegulatoryEscalationRequest,
  type RegulatoryAuthorityLevel,
  type RegulatoryEscalation,
  type RegulatoryEscalationStatus,
} from "./regulatoryEscalation.js";

// ── Incentive Signal Feedback Loop ───────────────────────────────────────────────────────────────────────────────────────
export {
  computeSignalEngagementRate,
  isSubstantiveSignalResponse,
  type GovernanceSignalAction,
  type RecordSignalActionRequest,
  type RecordSignalOutcomeRequest,
  type SignalActionSummary,
  type SignalActionType,
} from "./incentiveSignalFeedback.js";

// ── Cross-Org Impersonation ──────────────────────────────────────────────────────────────────────────────────────────
export {
  clampTokenDuration,
  isImpersonationGrantUsable,
  type CreateImpersonationGrantRequest,
  type CrossOrgImpersonationGrant,
  type ImpersonationToken,
  type ImpersonationValidationResult,
} from "./crossOrgImpersonation.js";

// ── V2 Wave-A endpoints ──────────────────────────────────────────────────────────────────────────────────────────────────
export {
  FeatureNotEnabledError,
  V2_BATCH_PATH,
  V2_GRAPHQL_MAX_DEPTH,
  V2_GRAPHQL_PATH,
  V2_MAX_BATCH_ITEMS,
  V2_MAX_BODY_BYTES,
  V2_STREAM_PATH,
  authorizeStream,
  evaluateMany,
  graphql,
  type AuthorizeStreamHandlers,
  type EvaluateBatchItem,
  type EvaluateBatchResponse,
  type EvaluateManyRequest,
  type FeatureNotEnabledErrorInit,
  type GraphQLRequest,
  type GraphQLResponse,
  type StreamComplete,
  type StreamDecisionFrame,
  type StreamErrorFrame,
  type V2Feature,
  type V2Transport,
} from "./v2.js";

// ── Approval / Override Runtime ────────────────────────────────────────────────────────────────────────────────────
export {
  configureApprovalRuntime,
  createEscalation,
  EscalationDeniedError,
  EscalationTimeoutError,
  protectOrEscalate,
  requestOverride,
  waitForEscalationApproval,
  type ApprovalPermit,
  type ApprovalRuntimeConfig,
  type ApprovalStatus,
  type CreateEscalationOptions,
  type EscalationHandle,
  type EscalationOutcome,
  type ProtectOrEscalateOptions,
  type RequestOverrideOptions,
  type WaitForApprovalOptions,
} from "./approvalRuntime.js";

// ── Context Layer ───────────────────────────────────────────────────────────────────────────────────────────────────────
export {
  DEFAULT_REDACTION_RULES,
  buildActionContext,
  flattenActionContext,
  redactContext,
  validateActionContext,
  type ActionContext,
  type ActionMetaContext,
  type ActorContext,
  type BuildActionContextInput,
  type ContextValidationError,
  type ContextValidationResult,
  type ContextValidationWarning,
  type EnvironmentContext,
  type HistoricalContext,
  type RedactionMode,
  type RedactionRule,
  type ResourceContext,
  type ValidateContextOptions,
} from "./actionContext.js";

// ── Shadow Mode ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export {
  configureShadow,
  protectShadow,
  reportShadowEvent,
  type ShadowConfig,
  type ShadowEventPayload,
  type ShadowMode,
  type ShadowOptions,
  type ShadowOutcome,
} from "./shadow.js";

// ── Enterprise Control Surface ────────────────────────────────────────────────────────────────────────────────────
export {
  checkIntegrationHealth,
  configureControlSurface,
  getEnforcementStatus,
  getOrgSummary,
  reportProtectedAction,
  type ControlSurfaceConfig,
  type EnforcementMode,
  type EnforcementStatus,
  type HealthReport,
  type GetEnforcementStatusOptions,
  type OrgSummary,
  type ProtectedActionEntry,
  type ReportProtectedActionOptions,
} from "./controlSurface.js";

// ── Pilot Verticals ────────────────────────────────────────────────────────────────────────────────────────────────────────
export {
  protectDeploy,
  type DeployGateOptions,
  type DeployEnvironment,
  protectCloseAction,
  type CloseGovernanceOptions,
  type CloseActionType,
  protectPaymentRelease,
  type PaymentReleaseOptions,
  protectToolCall,
  classifyToolRisk,
  type AgentToolOptions,
  type AgentToolMode,
} from "./verticals/index.js";

/**
 * Default export. The opinionated, category-defining entry point:
 *
 * ```ts
 * import atlasent from "@atlasent/sdk";
 * const permit = await atlasent.protect({ ... });        // primitive
 * await atlasent.withPermit({ ... }, async (permit) => …); // scoped form
 * await atlasent.requirePermit({ ... }, executor);         // descriptor form
 * ```
 */
const atlasent = {
  protect,
  withPermit,
  deployGate,
  configure,
  requirePermit,
  classifyCommand,
  verifyBundle,
  PRODUCTION_DEPLOY_ACTION,
  DEPLOYMENT_PRODUCTION_ACTION,
  AtlaSentClient,
  AtlaSentError,
  AtlaSentDeniedError,
} as const;

export default atlasent;

export {
  buildClaimEvidenceLink,
  verifyClaimEvidenceLink,
  NOT_APPLICABLE,
  type BuildClaimEvidenceLinkOpts,
  type VerifyClaimEvidenceLinkOpts,
  type VerifyClaimEvidenceLinkResult,
  type ClaimEvidenceLink,
  type RuntimeEvidenceSlot,
  type DeployEvidenceSlot,
  type IntegrationEvidenceSlot,
  type ApprovalArtifactSlot,
  type DeltaSlot,
  type DriftDetail,
  type DriftChangeType,
  type DriftSeverity,
  type DeltaStatus,
  type EvidenceSlotStatus,
  type VerificationChecklist,
  type NotApplicable,
  type DeployEvidenceInput,
  type HitlChainSummary,
  type SignedApprovalArtifact,
  buildClaimEvidenceLinkFromActionBundle,
  type ActionBundleInput,
  type ActionBundleReceipt,
  type BuildFromActionBundleOpts,
} from "./claimLineage.js";

// ── BCCAE V1 — Phase 3 Execution Assurance substrate ───────────────────────────────────────────────
export {
  BCCAEClient,
  generateBccaeNonce,
  type BccaeActorType,
  type BccaeTrustLevel,
  type BccaeResourceClassification,
  type BccaeDeploymentEnv,
  type BccaeSecurityPosture,
  type BccaeRequestSource,
  type BccaeRevocationTargetType,
  type BccaeClientOptions,
  type BccaeEvaluateInput,
  type BccaeEvaluateResponse,
  type BccaeExecuteInput,
  type BccaeExecuteResponse,
  type BccaeRevokeInput,
  type BccaeRevokeResponse,
  type BccaeEvidenceResponse,
} from "./bccae.js";

// ── Constrained governance agents (advisory read surface) ───────────────────────────────────────────────
export {
  highestAgentFindingSeverity,
  type AgentAuthorityDomain,
  type AgentEvaluationStatus,
  type AgentEvidenceRef,
  type AgentFindingSeverity,
  type AgentInvokerKind,
  type AgentSubjectKind,
  type GovernanceAgent,
  type GovernanceAgentEvaluation,
  type GovernanceAgentFinding,
  type ListGovernanceAgentsResponse,
  type ListGovernanceEvaluationsQuery,
  type ListGovernanceEvaluationsResponse,
  type ListGovernanceFindingsQuery,
  type ListGovernanceFindingsResponse,
} from "./governanceAgents.js";

// ── SCIM 2.0 Provisioning ─────────────────────────────────────────────────────────────────────────────────────────
export {
  makeScimClient,
  SCIM_GROUP_SCHEMA,
  SCIM_PATCH_OP_SCHEMA,
  SCIM_USER_SCHEMA,
  type ScimEmail,
  type ScimGroupRef,
  type ScimGroupsSubClient,
  type ScimListParams,
  type ScimListResponse,
  type ScimMeta,
  type ScimName,
  type ScimPatchOp,
  type ScimSubClient,
  type ScimUser,
  type ScimUserCreate,
  type ScimUsersSubClient,
  type ScimUserUpdate,
} from "./scim.js";

// ── Evidence Bundles ──────────────────────────────────────────────────────────────────────────────────────────────
export {
  makeEvidenceBundleClient,
  type EvidenceBundle,
  type EvidenceBundleCreateParams,
  type EvidenceBundleListPage,
  type EvidenceBundleListParams,
  type EvidenceBundleStatus,
  type EvidenceBundleSubClient,
} from "./evidence-bundle.js";

// ── Auth Token Management ─────────────────────────────────────────────────────────────────────────────────────────────
export {
  makeAuthClient,
  type AuthSubClient,
  type IdpConnection,
  type TokenResponse,
} from "./auth.js";

// ── SSO Administration ────────────────────────────────────────────────────────────────────────────────────────────────
export {
  wireToSsoConnection,
  wireToSsoJitRule,
  wireToSsoEvent,
  wireToSsoReadiness,
  makeSsoClient,
  type SsoConnection,
  type SsoConnectionWire,
  type SsoConnectionInput,
  type SsoJitRule,
  type SsoJitRuleWire,
  type SsoJitRuleInput,
  type SsoJitRulePatch,
  type SsoEvent,
  type SsoEventWire,
  type SsoEnforceAction,
  type SsoEnforceResult,
  type SsoReadiness,
  type SsoReadinessWire,
  type SsoRole,
  type SsoSubClient,
} from "./sso.js";

// ── Access Governance Log ─────────────────────────────────────────────────────
export {
  makeAccessGovernanceLogClient,
  type AccessGovernanceEvent,
  type AccessGovernanceLogPage,
  type AccessGovernanceLogQuery,
  type AccessGovernanceLogSubClient,
} from "./access-governance-log.js";
