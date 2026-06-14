// AtlaSent canonical authorization taxonomy — families, condition types, and
// the frozen reason-code set. GENERATED from the canonical registry
// (atlasent/contract/taxonomy/v1) — do not edit by hand. The registry is the
// single source of truth; see
// atlasent-docs/architecture/policy-authorization-data-architecture.md.
//
// Use these to roll an action_type slug up to one of the 10 canonical families,
// to enumerate the policy condition types, and to look up reason-code metadata.

export const TAXONOMY_SCHEMA_VERSION = "1.0.0";

export interface ActionClassFamily {
  readonly familyId: string;
  readonly title: string;
  readonly summary: string;
  readonly defaultRiskPosture: "low" | "medium" | "high" | "critical";
  readonly typicalConditions: readonly string[];
  readonly exampleSlugs: readonly string[];
}

export interface ConditionType {
  readonly conditionId: string;
  readonly title: string;
  readonly summary: string;
  readonly mapsTo: string;
  readonly producesReasonCode: readonly string[];
}

export interface ReasonCodeEntry {
  readonly code: string;
  readonly category: string;
  readonly severity: "info" | "warn" | "error" | "critical";
  readonly retryAdvice: "never" | "with_modified_input" | "after_human_approval" | "after_rate_window" | "transient";
  readonly tier: "safe" | "bounded" | "oracle_risk";
  readonly decision: "deny" | "hold" | "escalate";
  readonly meaning: string;
}

/** The 10 canonical action-class families. Every action_type slug maps to one. */
export const ACTION_CLASS_FAMILIES: readonly ActionClassFamily[] = [
  { familyId: "production.deploy", title: "Production deploy", summary: "Ship code, configuration, or a feature flag to a production runtime.", defaultRiskPosture: "high", typicalConditions: ["approval_required", "change_window_required", "environment_match_required", "security_scan_required", "state_snapshot_required"], exampleSlugs: ["production.deploy", "code.merge", "feature.flag.enable"] },
  { familyId: "infrastructure.change", title: "Infrastructure change", summary: "Mutate system, network, or platform configuration outside the application deploy path.", defaultRiskPosture: "high", typicalConditions: ["approval_required", "change_window_required", "state_snapshot_required", "authorized_actor_required"], exampleSlugs: ["fedramp.system.change", "database.migration", "sso.enforcement.activate"] },
  { familyId: "privileged.operation", title: "Privileged operation", summary: "Execute a privileged admin / database / secret operation that bypasses normal application guards.", defaultRiskPosture: "critical", typicalConditions: ["role_authorized_required", "human_approval_required", "state_snapshot_required", "intent_match_required"], exampleSlugs: ["database.execute_sql", "api.key.rotate"] },
  { familyId: "identity.grant", title: "Identity & access grant", summary: "Grant, elevate, or delegate access, roles, or entitlements to a principal.", defaultRiskPosture: "high", typicalConditions: ["dual_approval_required", "role_authorized_required", "authorized_actor_required"], exampleSlugs: ["iam.access.grant"] },
  { familyId: "data.access", title: "Sensitive data access", summary: "Read or query a regulated / sensitive dataset.", defaultRiskPosture: "medium", typicalConditions: ["purpose_approved_required", "role_eligible_for_dataset", "direct_identifier_forbidden"], exampleSlugs: ["data.query"] },
  { familyId: "data.release", title: "Data release / export", summary: "Export, publish, or release data beyond its original boundary.", defaultRiskPosture: "high", typicalConditions: ["purpose_approved_required", "release_size_cap", "direct_identifier_forbidden", "pii_export_review_required", "human_approval_required"], exampleSlugs: ["data.release", "customer.export", "audit_export.generate", "behavior.event.share", "gdpr.data_processing.initiate"] },
  { familyId: "regulated.release", title: "Regulated product / lot release", summary: "Release a regulated product, lot, or software build that requires qualified sign-off (GxP / medical device / clinical).", defaultRiskPosture: "critical", typicalConditions: ["role_approval_required", "dual_approval_required", "state_snapshot_required", "human_approval_required"], exampleSlugs: ["pharma.batch.release", "device.software.release", "clinical.trial.data.publish", "gxp.change_control.apply"] },
  { familyId: "financial.transaction", title: "Financial transaction / posting", summary: "Move money or post / certify a financial record (payment, journal entry, period close, reconciliation).", defaultRiskPosture: "high", typicalConditions: ["amount_threshold", "dual_approval_required", "authorized_actor_required", "human_approval_required"], exampleSlugs: ["vendor.payment.release", "journal_entry.approve", "period_close.submit", "reconciliation.certify", "reconciliation.close", "variance_review.escalate"] },
  { familyId: "security.exception", title: "Security exception / break-glass", summary: "Request an override, waiver, exception, or incident escalation that relaxes a standing control.", defaultRiskPosture: "critical", typicalConditions: ["human_approval_required", "role_approval_required", "authorized_actor_required"], exampleSlugs: ["control_override.request", "incident.response.escalate"] },
  { familyId: "agent.execute", title: "Autonomous agent action", summary: "An autonomous agent executes an action or invokes a tool on a user's or system's behalf.", defaultRiskPosture: "high", typicalConditions: ["intent_match_required", "dependency_satisfied_required", "human_approval_required", "rate_limit"], exampleSlugs: ["agent.execute", "agent.tool.use"] },
];

/** The canonical policy condition types, each bound to the reason code(s) it produces. */
export const CONDITION_TYPES: readonly ConditionType[] = [
  { conditionId: "approval_required", title: "Approval count", summary: "At least N independent approvers have signed off.", mapsTo: "context.approvals", producesReasonCode: ["INSUFFICIENT_APPROVALS"] },
  { conditionId: "dual_approval_required", title: "Dual approval (four-eyes)", summary: "Two distinct principals must approve; requester cannot self-approve.", mapsTo: "context.approvals", producesReasonCode: ["INSUFFICIENT_APPROVALS"] },
  { conditionId: "role_approval_required", title: "Role-mix approval quorum", summary: "Approvers must satisfy a role mix (e.g. 1 QP + 1 QA Head).", mapsTo: "context.approvals", producesReasonCode: ["INSUFFICIENT_ROLE_APPROVALS"] },
  { conditionId: "human_approval_required", title: "Verified human approval", summary: "A verified human approval artifact is required; a self-asserted actor_id does not satisfy it.", mapsTo: "action_classes.requires_human_approval", producesReasonCode: ["INSUFFICIENT_APPROVALS"] },
  { conditionId: "authorized_actor_required", title: "Actor allow-list", summary: "Actor must be on the bundle's explicit allow-list.", mapsTo: "context.actor", producesReasonCode: ["ACTOR_NOT_ALLOWED"] },
  { conditionId: "actor_not_denied", title: "Actor deny-list", summary: "Actor must not be on the bundle's deny-list.", mapsTo: "context.actor", producesReasonCode: ["ACTOR_DENIED"] },
  { conditionId: "role_authorized_required", title: "Role authorization", summary: "Actor's role must be authorized for this action.", mapsTo: "context.actor.role", producesReasonCode: ["DENY_AUTHORITY"] },
  { conditionId: "state_snapshot_required", title: "State snapshot", summary: "Caller must supply a state_snapshot the decision is bound to.", mapsTo: "action_classes.requires_state_snapshot", producesReasonCode: ["SNAPSHOT_REQUIRED"] },
  { conditionId: "change_window_required", title: "Change window", summary: "Action is restricted to a declared change window / blocked during freeze.", mapsTo: "context.change_window_status", producesReasonCode: ["OUTSIDE_CHANGE_WINDOW"] },
  { conditionId: "environment_match_required", title: "Environment match", summary: "Request environment must match the action class / permit environment scope.", mapsTo: "context.environment", producesReasonCode: ["DENY_ENVIRONMENT"] },
  { conditionId: "mfa_required", title: "MFA / trust tier", summary: "Caller must present a minimum auth strength / trust tier.", mapsTo: "context.trust_tier", producesReasonCode: ["DENY_AUTHORITY"] },
  { conditionId: "ticket_required", title: "Linked ticket", summary: "A linked, approved change/work ticket is required.", mapsTo: "context.ticket", producesReasonCode: ["NO_TEMPLATE_MATCH"] },
  { conditionId: "security_scan_required", title: "Security scan passed", summary: "A passing security scan is required before the action proceeds.", mapsTo: "context.security_scan", producesReasonCode: ["DENY_POLICY"] },
  { conditionId: "risk_threshold", title: "Risk threshold", summary: "Risk score must stay below the hold / escalate thresholds.", mapsTo: "context.riskScore", producesReasonCode: ["RISK_HOLD", "RISK_ESCALATE"] },
  { conditionId: "amount_threshold", title: "Amount threshold", summary: "Monetary amount must stay under the auto-approval cap (over → route to approval).", mapsTo: "context.amount", producesReasonCode: ["INSUFFICIENT_APPROVALS"] },
  { conditionId: "release_size_cap", title: "Release size cap", summary: "Result / release row count must stay under the role's cap.", mapsTo: "context.row_count", producesReasonCode: ["RELEASE_TOO_LARGE"] },
  { conditionId: "direct_identifier_forbidden", title: "No direct identifiers", summary: "Query/projection must not select a direct-identifier column (minimum necessary).", mapsTo: "context.columns", producesReasonCode: ["DIRECT_IDENTIFIER_REQUESTED", "RELEASE_FIELD_DIRECT_IDENTIFIER"] },
  { conditionId: "purpose_approved_required", title: "Approved purpose", summary: "Declared processing purpose must be in the approved set (GDPR Art. 5(1)(b)).", mapsTo: "context.purpose", producesReasonCode: ["PURPOSE_NOT_APPROVED"] },
  { conditionId: "role_eligible_for_dataset", title: "Dataset role eligibility", summary: "Caller's role must be eligible for the requested dataset.", mapsTo: "context.actor.role", producesReasonCode: ["ROLE_NOT_ELIGIBLE"] },
  { conditionId: "pii_export_review_required", title: "PII export review", summary: "Bulk PII export requires a completed privacy review.", mapsTo: "context.export", producesReasonCode: ["PII_EXPORT_RESTRICTED"] },
  { conditionId: "approved_base_model_required", title: "Approved base model", summary: "Base model must be on the fine-tuning approved list.", mapsTo: "context.base_model", producesReasonCode: ["UNAPPROVED_BASE_MODEL"] },
  { conditionId: "rate_limit", title: "Rate limit", summary: "Per-actor / per-org / per-key call rate must be within the limit.", mapsTo: "runtime.rate_counter", producesReasonCode: ["RATE_LIMIT_EXCEEDED"] },
  { conditionId: "dependency_satisfied_required", title: "Dependency satisfied", summary: "Required upstream permits / predicates in the execution dependency graph must be satisfied.", mapsTo: "context.dependencies", producesReasonCode: ["NO_TEMPLATE_MATCH"] },
  { conditionId: "signal_trust_required", title: "Trusted signal", summary: "External signals/assertions consulted must come from a trusted issuer.", mapsTo: "context.externalSignals", producesReasonCode: ["DENY_POLICY"] },
  { conditionId: "intent_match_required", title: "Intent match", summary: "Declared intent must match the action being executed.", mapsTo: "cdo.intent", producesReasonCode: ["DENY_POLICY"] },
  { conditionId: "escalation_required", title: "Higher-authority escalation", summary: "Inconsistent or out-of-band state routes to a higher-authority reviewer.", mapsTo: "runtime.state", producesReasonCode: ["ESCALATE_REQUIRED"] },
];

/** The frozen reason-code (deny_code) set — mirror of the canonical registry. */
export const REASON_CODES: readonly ReasonCodeEntry[] = [
  { code: "ACTOR_DENIED", category: "actor", severity: "error", retryAdvice: "never", tier: "bounded", decision: "deny", meaning: "Actor is on the bundle's deny list." },
  { code: "ACTOR_NOT_ALLOWED", category: "actor", severity: "error", retryAdvice: "with_modified_input", tier: "bounded", decision: "deny", meaning: "Bundle requires an explicit allow-list entry; this actor isn't on it." },
  { code: "ACTOR_HELD", category: "actor", severity: "warn", retryAdvice: "after_human_approval", tier: "safe", decision: "hold", meaning: "Actor is held for review; a human must release." },
  { code: "ACTOR_ESCALATED", category: "actor", severity: "warn", retryAdvice: "after_human_approval", tier: "safe", decision: "escalate", meaning: "Actor routed to manual review." },
  { code: "INSUFFICIENT_APPROVALS", category: "approvals", severity: "warn", retryAdvice: "after_human_approval", tier: "safe", decision: "deny", meaning: "Fewer approvals than the policy requires." },
  { code: "INSUFFICIENT_ROLE_APPROVALS", category: "approvals", severity: "warn", retryAdvice: "after_human_approval", tier: "safe", decision: "deny", meaning: "Approvers don't satisfy the role-mix (e.g. 1 QP + 1 QA Head)." },
  { code: "RATE_LIMIT_EXCEEDED", category: "rate_limit", severity: "warn", retryAdvice: "after_rate_window", tier: "safe", decision: "deny", meaning: "Over the per-actor / per-org / per-key rate limit." },
  { code: "NO_TEMPLATE_MATCH", category: "policy", severity: "error", retryAdvice: "with_modified_input", tier: "safe", decision: "deny", meaning: "Fail-closed default: no rule template matched the request." },
  { code: "POLICY_MALFORMED", category: "policy", severity: "error", retryAdvice: "never", tier: "safe", decision: "deny", meaning: "Policy bundle failed schema validation; engine fails closed." },
  { code: "SNAPSHOT_REQUIRED", category: "policy", severity: "error", retryAdvice: "with_modified_input", tier: "safe", decision: "deny", meaning: "Action class requires state_snapshot; none was supplied." },
  { code: "RISK_ESCALATE", category: "risk", severity: "warn", retryAdvice: "after_human_approval", tier: "safe", decision: "escalate", meaning: "Risk score crossed the escalate threshold." },
  { code: "RISK_HOLD", category: "risk", severity: "warn", retryAdvice: "after_human_approval", tier: "safe", decision: "hold", meaning: "Risk score crossed the hold threshold." },
  { code: "ROLE_HELD", category: "actor", severity: "warn", retryAdvice: "after_human_approval", tier: "safe", decision: "hold", meaning: "Actor's role is held for review." },
  { code: "ROLE_ESCALATED", category: "actor", severity: "warn", retryAdvice: "after_human_approval", tier: "safe", decision: "escalate", meaning: "Actor's role is escalated for review." },
  { code: "PURPOSE_NOT_APPROVED", category: "data", severity: "error", retryAdvice: "with_modified_input", tier: "oracle_risk", decision: "deny", meaning: "Declared purpose isn't in the approved set (GDPR Art. 5(1)(b))." },
  { code: "ROLE_NOT_ELIGIBLE", category: "data", severity: "error", retryAdvice: "with_modified_input", tier: "oracle_risk", decision: "deny", meaning: "Caller's role isn't eligible for this dataset." },
  { code: "DIRECT_IDENTIFIER_REQUESTED", category: "data", severity: "error", retryAdvice: "with_modified_input", tier: "oracle_risk", decision: "deny", meaning: "Query selected a direct-identifier column (HIPAA minimum-necessary)." },
  { code: "PII_EXPORT_RESTRICTED", category: "data", severity: "error", retryAdvice: "after_human_approval", tier: "oracle_risk", decision: "deny", meaning: "Bulk PII export without GDPR review." },
  { code: "RELEASE_TOO_LARGE", category: "release", severity: "error", retryAdvice: "with_modified_input", tier: "oracle_risk", decision: "deny", meaning: "Result row count exceeds the role's release cap." },
  { code: "RELEASE_FIELD_DIRECT_IDENTIFIER", category: "release", severity: "error", retryAdvice: "with_modified_input", tier: "oracle_risk", decision: "deny", meaning: "Realized projection includes a direct-identifier column." },
  { code: "PERMIT_EXPIRED", category: "permit", severity: "warn", retryAdvice: "with_modified_input", tier: "safe", decision: "deny", meaning: "Permit TTL elapsed before verify; re-issue." },
  { code: "PERMIT_CONSUMED", category: "permit", severity: "warn", retryAdvice: "with_modified_input", tier: "safe", decision: "deny", meaning: "Single-use permit already verified; re-issue." },
  { code: "PERMIT_REVOKED", category: "permit", severity: "error", retryAdvice: "after_human_approval", tier: "safe", decision: "deny", meaning: "Permit was revoked before consumption." },
  { code: "PERMIT_INVALID_SIGNATURE", category: "permit", severity: "error", retryAdvice: "never", tier: "safe", decision: "deny", meaning: "Permit signature doesn't verify against any known key." },
  { code: "OUTSIDE_CHANGE_WINDOW", category: "infra", severity: "warn", retryAdvice: "after_rate_window", tier: "safe", decision: "deny", meaning: "Action restricted to a declared change window." },
  { code: "UNAPPROVED_BASE_MODEL", category: "infra", severity: "error", retryAdvice: "with_modified_input", tier: "bounded", decision: "deny", meaning: "Base model isn't on the fine-tuning approved list." },
  { code: "DENY_POLICY", category: "policy", severity: "error", retryAdvice: "never", tier: "bounded", decision: "deny", meaning: "The active policy rule explicitly denied the request." },
  { code: "DENY_AUTHORITY", category: "actor", severity: "error", retryAdvice: "with_modified_input", tier: "bounded", decision: "deny", meaning: "Actor's role isn't authorized for this action." },
  { code: "DENY_ENVIRONMENT", category: "infra", severity: "error", retryAdvice: "with_modified_input", tier: "safe", decision: "deny", meaning: "Permit environment doesn't match the request environment." },
  { code: "VERIFY_FAILED", category: "permit", severity: "error", retryAdvice: "with_modified_input", tier: "safe", decision: "deny", meaning: "No permit provided, or it wasn't verified before the action." },
  { code: "ESCALATE_REQUIRED", category: "policy", severity: "warn", retryAdvice: "after_human_approval", tier: "safe", decision: "escalate", meaning: "Inconsistent state; a higher-authority reviewer must decide." },
];

const FAMILY_IDS: ReadonlySet<string> = new Set(ACTION_CLASS_FAMILIES.map((f) => f.familyId));
const CONDITION_IDS: ReadonlySet<string> = new Set(CONDITION_TYPES.map((c) => c.conditionId));
const REASON_CODE_SET: ReadonlySet<string> = new Set(REASON_CODES.map((r) => r.code));
const SLUG_TO_FAMILY: ReadonlyMap<string, string> = new Map(
  ACTION_CLASS_FAMILIES.flatMap((f) => f.exampleSlugs.map((s) => [s, f.familyId] as const)),
);

/** Roll an action_type slug up to its canonical family id, or undefined if unmapped. */
export function familyForSlug(slug: string): string | undefined {
  return SLUG_TO_FAMILY.get(slug);
}

/** Look up reason-code metadata, or undefined if not a known code. */
export function getReasonCode(code: string): ReasonCodeEntry | undefined {
  return REASON_CODES.find((r) => r.code === code);
}

export function isActionClassFamilyId(value: string): boolean {
  return FAMILY_IDS.has(value);
}

export function isConditionTypeId(value: string): boolean {
  return CONDITION_IDS.has(value);
}

export function isReasonCode(value: string): boolean {
  return REASON_CODE_SET.has(value);
}
