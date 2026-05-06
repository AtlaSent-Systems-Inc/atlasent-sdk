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
 *   action: "deploy_to_production",
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
import { configure, protect } from "./protect.js";
import { requirePermit, classifyCommand } from "./requirePermit.js";

export { AtlaSentClient } from "./client.js";
export {
  AtlaSentDeniedError,
  AtlaSentError,
  normalizePermitOutcome,
  type AtlaSentDecision,
  type AtlaSentDeniedErrorInit,
  type AtlaSentErrorCode,
  type AtlaSentErrorInit,
  type PermitOutcome,
} from "./errors.js";
export {
  configure,
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
  EvaluatePreflightResponse,
  EvaluateRequest,
  EvaluateResponse,
  RateLimitState,
  RevokePermitRequest,
  RevokePermitResponse,
  StreamDecisionEvent,
  StreamEvent,
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

// ── Economic Governance & Liability Attribution ───────────────────────────────

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
  configure,
  requirePermit,
  classifyCommand,
  verifyBundle,
  AtlaSentClient,
  AtlaSentError,
  AtlaSentDeniedError,
} as const;

export default atlasent;
