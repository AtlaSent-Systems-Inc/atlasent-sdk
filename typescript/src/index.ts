/**
 * @atlasent/sdk — execution-time authorization for AI agents.
 *
 * Primary entry points:
 *   - {@link AtlaSentClient}       HTTP client (evaluate, verify, revoke, …)
 *   - {@link AtlaSentError}        Structured error class
 *   - {@link verifyBundle}         Offline audit-bundle verifier
 *
 * All public types are re-exported from this module so callers can
 * import everything from `"@atlasent/sdk"` rather than reaching into
 * sub-paths.
 */

export { AtlaSentClient } from "./client.js";
export {
  AtlaSentError,
  StreamParseError,
  StreamTimeoutError,
} from "./errors.js";
export type { AtlaSentErrorCode } from "./errors.js";
export type {
  // Core evaluation
  AtlaSentClientOptions,
  Decision,
  DecisionCanonical,
  EvaluateRequest,
  EvaluateResponse,
  // Batch
  BatchEvalItem,
  BatchEvalResponse,
  EvaluateBatchResultItem,
  // Preflight
  ConstraintTrace,
  EvaluatePreflightResponse,
  // Permit lifecycle
  GetPermitResponse,
  ListPermitsRequest,
  ListPermitsResponse,
  PermitRecord,
  PermitValidResponse,
  RevokePermitByIdInput,
  RevokePermitByIdResponse,
  RevokePermitRequest,
  RevokePermitResponse,
  VerifyPermitByIdResponse,
  VerifyPermitRequest,
  VerifyPermitResponse,
  // Rate limiting
  RateLimitState,
  // Key self-describe
  ApiKeySelfResponse,
  // Audit
  AuditEventsQuery,
  AuditEventsResult,
  AuditExportRequest,
  AuditExportResult,
  // Streaming
  DecisionStreamEvent,
  StreamDecisionEvent,
  StreamEvent,
  StreamOptions,
  StreamProgressEvent,
  SubscribeDecisionsOptions,
  // Deploy Gate
  DeployGateEvidence,
  DeployGateRequest,
  DeployGateResponse,
} from "./types.js";
export { PRODUCTION_DEPLOY_ACTION } from "./types.js";
export type {
  AuditEventsPage,
  AuditEntry,
  AuditExport,
} from "./audit.js";
export { verifyBundle, verifyAuditBundle } from "./auditVerify.js";
export type { BundleVerifyResult } from "./auditVerify.js";
export type {
  HitlApprovalRecord,
  HitlApproveRequest,
  HitlChainHop,
  HitlCreateRequest,
  HitlEscalateRequest,
  HitlEscalation,
  HitlRejectRequest,
  ListHitlEscalationsRequest,
  ListHitlEscalationsResponse,
} from "./hitl.js";
export type {
  GovernanceGraphQueryParams,
  GovernanceGraphQueryResponse,
  GovernanceGraphQueryType,
  GovernanceGraphResultRow,
} from "./governanceGraph.js";
export type { IncidentTimelineResponse } from "./incidentReconstruction.js";
export type {
  AuthenticateConnectorInput,
  AuthenticateConnectorResponse,
  ConnectorType,
  InstallConnectorInput,
  InstallConnectorResponse,
  ListConnectorsResponse,
  ListEnforcementPoliciesResponse,
  RevokeConnectorResponse,
  RotateCredentialsResponse,
  SyncConnectorResponse,
  UpsertEnforcementPolicyInput,
  UpsertEnforcementPolicyResponse,
} from "./connectorManagement.js";
export type {
  ComputeOrgRiskOptions,
  ComputeOrgRiskResponse,
  GetLatestOrgRiskResponse,
  ListOrgRiskHistoryResponse,
} from "./orgRiskGraph.js";
export type {
  CrossOrgPermissionCheckListParams,
  CrossOrgPermissionCheckRequest,
  CrossOrgPermissionCheckResult,
} from "./crossOrgPermission.js";
export type {
  AnomalyResponseEvent,
  AnomalyResponseRule,
  CreateAnomalyResponseRuleRequest,
  TriggerAnomalyResponseRequest,
} from "./anomalyResponse.js";
export type {
  ApproveBudgetExceptionRequest,
  BudgetExceptionRequest,
  BudgetExceptionStatus,
  CreateBudgetExceptionRequest,
} from "./budgetExceptions.js";
export type {
  CreateRegulatoryEscalationRequest,
  RegulatoryAuthorityLevel,
  RegulatoryEscalation,
  RegulatoryEscalationStatus,
} from "./regulatoryEscalation.js";
export type {
  GovernanceAgent,
  GovernanceAgentEvaluation,
  GovernanceAgentFinding,
  ListGovernanceAgentsResponse,
  ListGovernanceEvaluationsQuery,
  ListGovernanceEvaluationsResponse,
  ListGovernanceFindingsQuery,
  ListGovernanceFindingsResponse,
} from "./governanceAgents.js";
export type {
  GovernanceSignalAction,
  RecordSignalActionRequest,
  RecordSignalOutcomeRequest,
  SignalActionSummary,
} from "./incentiveSignalFeedback.js";
export type {
  CrossOrgImpersonationGrant,
  CreateImpersonationGrantRequest,
  ImpersonationToken,
  ImpersonationValidationResult,
} from "./crossOrgImpersonation.js";

// ── Decision replay (ADR-015 §Replay, parity v2) ────────────────────────────
export type { ReplayRequest, ReplayResponse, ReplayVarianceKind } from "./types.js";
