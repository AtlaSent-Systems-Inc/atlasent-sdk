// ── Core types ────────────────────────────────────────────────────────────────
export type {
  Permit,
  ProtectRequest,
  EvaluateRequest,
  EvaluateResponse,
  EvaluationDecision,
  VerifyPermitRequest,
} from "./types.js";

// ── Errors ────────────────────────────────────────────────────────────────────
export {
  AtlaSentError,
  AtlaSentDeniedError,
  type AtlaSentErrorCode,
} from "./errors.js";

// ── Client ────────────────────────────────────────────────────────────────────
export { AtlaSentClient, type AtlaSentClientOptions } from "./client.js";

// ── Protect singleton ─────────────────────────────────────────────────────────
export { protect, configureProtect, type ProtectOptions } from "./protect.js";

// ── HITL wire types ───────────────────────────────────────────────────────────
export type {
  HitlCreateRequest,
  HitlEscalation,
  HitlEscalationStatus as EscalationStatus,
  HitlFallbackDecision,
  HitlQuorumTier,
  HitlResolution,
  OverrideV1,
} from "./hitl.js";

// ── Approval / Override Runtime ───────────────────────────────────────────────
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

// ── Context Layer ──────────────────────────────────────────────────────────────
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

// ── Shadow Mode ────────────────────────────────────────────────────────────────
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

// ── Enterprise Control Surface ───────────────────────────────────────────────
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
  type OrgSummary,
  type ProtectedActionEntry,
  type ReportProtectedActionOptions,
  type GetEnforcementStatusOptions,
} from "./controlSurface.js";

// ── Pilot Verticals ──────────────────────────────────────────────────────────────
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
