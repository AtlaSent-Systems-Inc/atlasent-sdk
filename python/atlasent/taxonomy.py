"""AtlaSent canonical authorization taxonomy — families, condition types, and
the frozen reason-code set.

GENERATED from the canonical registry (atlasent/contract/taxonomy/v1) — do not
edit by hand. The registry is the single source of truth; see
atlasent-docs/architecture/policy-authorization-data-architecture.md.

Use these to roll an action_type slug up to one of the 10 canonical families,
to enumerate the policy condition types, and to look up reason-code metadata.
"""

from __future__ import annotations

from typing import Final

__all__ = [
    "TAXONOMY_SCHEMA_VERSION",
    "ACTION_CLASS_FAMILIES",
    "CONDITION_TYPES",
    "REASON_CODES",
    "family_for_slug",
    "get_reason_code",
    "is_action_class_family_id",
    "is_condition_type_id",
    "is_reason_code",
]

TAXONOMY_SCHEMA_VERSION: Final = "1.0.0"

#: The 10 canonical action-class families. Every action_type slug maps to one.
ACTION_CLASS_FAMILIES: Final = (
    {"family_id": "production.deploy", "title": "Production deploy", "summary": "Ship code, configuration, or a feature flag to a production runtime.", "default_risk_posture": "high", "typical_conditions": ("approval_required", "change_window_required", "environment_match_required", "security_scan_required", "state_snapshot_required"), "example_slugs": ("production.deploy", "code.merge", "feature.flag.enable")},
    {"family_id": "infrastructure.change", "title": "Infrastructure change", "summary": "Mutate system, network, or platform configuration outside the application deploy path.", "default_risk_posture": "high", "typical_conditions": ("approval_required", "change_window_required", "state_snapshot_required", "authorized_actor_required"), "example_slugs": ("fedramp.system.change", "database.migration", "sso.enforcement.activate")},
    {"family_id": "privileged.operation", "title": "Privileged operation", "summary": "Execute a privileged admin / database / secret operation that bypasses normal application guards.", "default_risk_posture": "critical", "typical_conditions": ("role_authorized_required", "human_approval_required", "state_snapshot_required", "intent_match_required"), "example_slugs": ("database.execute_sql", "api.key.rotate")},
    {"family_id": "identity.grant", "title": "Identity & access grant", "summary": "Grant, elevate, or delegate access, roles, or entitlements to a principal.", "default_risk_posture": "high", "typical_conditions": ("dual_approval_required", "role_authorized_required", "authorized_actor_required"), "example_slugs": ("iam.access.grant",)},
    {"family_id": "data.access", "title": "Sensitive data access", "summary": "Read or query a regulated / sensitive dataset.", "default_risk_posture": "medium", "typical_conditions": ("purpose_approved_required", "role_eligible_for_dataset", "direct_identifier_forbidden"), "example_slugs": ("data.query",)},
    {"family_id": "data.release", "title": "Data release / export", "summary": "Export, publish, or release data beyond its original boundary.", "default_risk_posture": "high", "typical_conditions": ("purpose_approved_required", "release_size_cap", "direct_identifier_forbidden", "pii_export_review_required", "human_approval_required"), "example_slugs": ("data.release", "customer.export", "audit_export.generate", "behavior.event.share", "gdpr.data_processing.initiate")},
    {"family_id": "regulated.release", "title": "Regulated product / lot release", "summary": "Release a regulated product, lot, or software build that requires qualified sign-off (GxP / medical device / clinical).", "default_risk_posture": "critical", "typical_conditions": ("role_approval_required", "dual_approval_required", "state_snapshot_required", "human_approval_required"), "example_slugs": ("pharma.batch.release", "device.software.release", "clinical.trial.data.publish", "gxp.change_control.apply")},
    {"family_id": "financial.transaction", "title": "Financial transaction / posting", "summary": "Move money or post / certify a financial record (payment, journal entry, period close, reconciliation).", "default_risk_posture": "high", "typical_conditions": ("amount_threshold", "dual_approval_required", "authorized_actor_required", "human_approval_required"), "example_slugs": ("vendor.payment.release", "journal_entry.approve", "period_close.submit", "reconciliation.certify", "reconciliation.close", "variance_review.escalate")},
    {"family_id": "security.exception", "title": "Security exception / break-glass", "summary": "Request an override, waiver, exception, or incident escalation that relaxes a standing control.", "default_risk_posture": "critical", "typical_conditions": ("human_approval_required", "role_approval_required", "authorized_actor_required"), "example_slugs": ("control_override.request", "incident.response.escalate")},
    {"family_id": "agent.execute", "title": "Autonomous agent action", "summary": "An autonomous agent executes an action or invokes a tool on a user's or system's behalf.", "default_risk_posture": "high", "typical_conditions": ("intent_match_required", "dependency_satisfied_required", "human_approval_required", "rate_limit"), "example_slugs": ("agent.execute", "agent.tool.use")},
)

#: The canonical policy condition types, each bound to the reason code(s) it produces.
CONDITION_TYPES: Final = (
    {"condition_id": "approval_required", "title": "Approval count", "summary": "At least N independent approvers have signed off.", "maps_to": "context.approvals", "produces_reason_code": ("INSUFFICIENT_APPROVALS",)},
    {"condition_id": "dual_approval_required", "title": "Dual approval (four-eyes)", "summary": "Two distinct principals must approve; requester cannot self-approve.", "maps_to": "context.approvals", "produces_reason_code": ("INSUFFICIENT_APPROVALS",)},
    {"condition_id": "role_approval_required", "title": "Role-mix approval quorum", "summary": "Approvers must satisfy a role mix (e.g. 1 QP + 1 QA Head).", "maps_to": "context.approvals", "produces_reason_code": ("INSUFFICIENT_ROLE_APPROVALS",)},
    {"condition_id": "human_approval_required", "title": "Verified human approval", "summary": "A verified human approval artifact is required; a self-asserted actor_id does not satisfy it.", "maps_to": "action_classes.requires_human_approval", "produces_reason_code": ("INSUFFICIENT_APPROVALS",)},
    {"condition_id": "authorized_actor_required", "title": "Actor allow-list", "summary": "Actor must be on the bundle's explicit allow-list.", "maps_to": "context.actor", "produces_reason_code": ("ACTOR_NOT_ALLOWED",)},
    {"condition_id": "actor_not_denied", "title": "Actor deny-list", "summary": "Actor must not be on the bundle's deny-list.", "maps_to": "context.actor", "produces_reason_code": ("ACTOR_DENIED",)},
    {"condition_id": "role_authorized_required", "title": "Role authorization", "summary": "Actor's role must be authorized for this action.", "maps_to": "context.actor.role", "produces_reason_code": ("DENY_AUTHORITY",)},
    {"condition_id": "state_snapshot_required", "title": "State snapshot", "summary": "Caller must supply a state_snapshot the decision is bound to.", "maps_to": "action_classes.requires_state_snapshot", "produces_reason_code": ("SNAPSHOT_REQUIRED",)},
    {"condition_id": "change_window_required", "title": "Change window", "summary": "Action is restricted to a declared change window / blocked during freeze.", "maps_to": "context.change_window_status", "produces_reason_code": ("OUTSIDE_CHANGE_WINDOW",)},
    {"condition_id": "environment_match_required", "title": "Environment match", "summary": "Request environment must match the action class / permit environment scope.", "maps_to": "context.environment", "produces_reason_code": ("DENY_ENVIRONMENT",)},
    {"condition_id": "mfa_required", "title": "MFA / trust tier", "summary": "Caller must present a minimum auth strength / trust tier.", "maps_to": "context.trust_tier", "produces_reason_code": ("DENY_AUTHORITY",)},
    {"condition_id": "ticket_required", "title": "Linked ticket", "summary": "A linked, approved change/work ticket is required.", "maps_to": "context.ticket", "produces_reason_code": ("NO_TEMPLATE_MATCH",)},
    {"condition_id": "security_scan_required", "title": "Security scan passed", "summary": "A passing security scan is required before the action proceeds.", "maps_to": "context.security_scan", "produces_reason_code": ("DENY_POLICY",)},
    {"condition_id": "risk_threshold", "title": "Risk threshold", "summary": "Risk score must stay below the hold / escalate thresholds.", "maps_to": "context.riskScore", "produces_reason_code": ("RISK_HOLD", "RISK_ESCALATE")},
    {"condition_id": "amount_threshold", "title": "Amount threshold", "summary": "Monetary amount must stay under the auto-approval cap (over → route to approval).", "maps_to": "context.amount", "produces_reason_code": ("INSUFFICIENT_APPROVALS",)},
    {"condition_id": "release_size_cap", "title": "Release size cap", "summary": "Result / release row count must stay under the role's cap.", "maps_to": "context.row_count", "produces_reason_code": ("RELEASE_TOO_LARGE",)},
    {"condition_id": "direct_identifier_forbidden", "title": "No direct identifiers", "summary": "Query/projection must not select a direct-identifier column (minimum necessary).", "maps_to": "context.columns", "produces_reason_code": ("DIRECT_IDENTIFIER_REQUESTED", "RELEASE_FIELD_DIRECT_IDENTIFIER")},
    {"condition_id": "purpose_approved_required", "title": "Approved purpose", "summary": "Declared processing purpose must be in the approved set (GDPR Art. 5(1)(b)).", "maps_to": "context.purpose", "produces_reason_code": ("PURPOSE_NOT_APPROVED",)},
    {"condition_id": "role_eligible_for_dataset", "title": "Dataset role eligibility", "summary": "Caller's role must be eligible for the requested dataset.", "maps_to": "context.actor.role", "produces_reason_code": ("ROLE_NOT_ELIGIBLE",)},
    {"condition_id": "pii_export_review_required", "title": "PII export review", "summary": "Bulk PII export requires a completed privacy review.", "maps_to": "context.export", "produces_reason_code": ("PII_EXPORT_RESTRICTED",)},
    {"condition_id": "approved_base_model_required", "title": "Approved base model", "summary": "Base model must be on the fine-tuning approved list.", "maps_to": "context.base_model", "produces_reason_code": ("UNAPPROVED_BASE_MODEL",)},
    {"condition_id": "rate_limit", "title": "Rate limit", "summary": "Per-actor / per-org / per-key call rate must be within the limit.", "maps_to": "runtime.rate_counter", "produces_reason_code": ("RATE_LIMIT_EXCEEDED",)},
    {"condition_id": "dependency_satisfied_required", "title": "Dependency satisfied", "summary": "Required upstream permits / predicates in the execution dependency graph must be satisfied.", "maps_to": "context.dependencies", "produces_reason_code": ("NO_TEMPLATE_MATCH",)},
    {"condition_id": "signal_trust_required", "title": "Trusted signal", "summary": "External signals/assertions consulted must come from a trusted issuer.", "maps_to": "context.externalSignals", "produces_reason_code": ("DENY_POLICY",)},
    {"condition_id": "intent_match_required", "title": "Intent match", "summary": "Declared intent must match the action being executed.", "maps_to": "cdo.intent", "produces_reason_code": ("DENY_POLICY",)},
    {"condition_id": "escalation_required", "title": "Higher-authority escalation", "summary": "Inconsistent or out-of-band state routes to a higher-authority reviewer.", "maps_to": "runtime.state", "produces_reason_code": ("ESCALATE_REQUIRED",)},
)

#: The frozen reason-code (deny_code) set — mirror of the canonical registry.
REASON_CODES: Final = (
    {"code": "ACTOR_DENIED", "category": "actor", "severity": "error", "retry_advice": "never", "tier": "bounded", "decision": "deny", "meaning": "Actor is on the bundle's deny list."},
    {"code": "ACTOR_NOT_ALLOWED", "category": "actor", "severity": "error", "retry_advice": "with_modified_input", "tier": "bounded", "decision": "deny", "meaning": "Bundle requires an explicit allow-list entry; this actor isn't on it."},
    {"code": "ACTOR_HELD", "category": "actor", "severity": "warn", "retry_advice": "after_human_approval", "tier": "safe", "decision": "hold", "meaning": "Actor is held for review; a human must release."},
    {"code": "ACTOR_ESCALATED", "category": "actor", "severity": "warn", "retry_advice": "after_human_approval", "tier": "safe", "decision": "escalate", "meaning": "Actor routed to manual review."},
    {"code": "INSUFFICIENT_APPROVALS", "category": "approvals", "severity": "warn", "retry_advice": "after_human_approval", "tier": "safe", "decision": "deny", "meaning": "Fewer approvals than the policy requires."},
    {"code": "INSUFFICIENT_ROLE_APPROVALS", "category": "approvals", "severity": "warn", "retry_advice": "after_human_approval", "tier": "safe", "decision": "deny", "meaning": "Approvers don't satisfy the role-mix (e.g. 1 QP + 1 QA Head)."},
    {"code": "RATE_LIMIT_EXCEEDED", "category": "rate_limit", "severity": "warn", "retry_advice": "after_rate_window", "tier": "safe", "decision": "deny", "meaning": "Over the per-actor / per-org / per-key rate limit."},
    {"code": "NO_TEMPLATE_MATCH", "category": "policy", "severity": "error", "retry_advice": "with_modified_input", "tier": "safe", "decision": "deny", "meaning": "Fail-closed default: no rule template matched the request."},
    {"code": "POLICY_MALFORMED", "category": "policy", "severity": "error", "retry_advice": "never", "tier": "safe", "decision": "deny", "meaning": "Policy bundle failed schema validation; engine fails closed."},
    {"code": "SNAPSHOT_REQUIRED", "category": "policy", "severity": "error", "retry_advice": "with_modified_input", "tier": "safe", "decision": "deny", "meaning": "Action class requires state_snapshot; none was supplied."},
    {"code": "RISK_ESCALATE", "category": "risk", "severity": "warn", "retry_advice": "after_human_approval", "tier": "safe", "decision": "escalate", "meaning": "Risk score crossed the escalate threshold."},
    {"code": "RISK_HOLD", "category": "risk", "severity": "warn", "retry_advice": "after_human_approval", "tier": "safe", "decision": "hold", "meaning": "Risk score crossed the hold threshold."},
    {"code": "ROLE_HELD", "category": "actor", "severity": "warn", "retry_advice": "after_human_approval", "tier": "safe", "decision": "hold", "meaning": "Actor's role is held for review."},
    {"code": "ROLE_ESCALATED", "category": "actor", "severity": "warn", "retry_advice": "after_human_approval", "tier": "safe", "decision": "escalate", "meaning": "Actor's role is escalated for review."},
    {"code": "PURPOSE_NOT_APPROVED", "category": "data", "severity": "error", "retry_advice": "with_modified_input", "tier": "oracle_risk", "decision": "deny", "meaning": "Declared purpose isn't in the approved set (GDPR Art. 5(1)(b))."},
    {"code": "ROLE_NOT_ELIGIBLE", "category": "data", "severity": "error", "retry_advice": "with_modified_input", "tier": "oracle_risk", "decision": "deny", "meaning": "Caller's role isn't eligible for this dataset."},
    {"code": "DIRECT_IDENTIFIER_REQUESTED", "category": "data", "severity": "error", "retry_advice": "with_modified_input", "tier": "oracle_risk", "decision": "deny", "meaning": "Query selected a direct-identifier column (HIPAA minimum-necessary)."},
    {"code": "PII_EXPORT_RESTRICTED", "category": "data", "severity": "error", "retry_advice": "after_human_approval", "tier": "oracle_risk", "decision": "deny", "meaning": "Bulk PII export without GDPR review."},
    {"code": "RELEASE_TOO_LARGE", "category": "release", "severity": "error", "retry_advice": "with_modified_input", "tier": "oracle_risk", "decision": "deny", "meaning": "Result row count exceeds the role's release cap."},
    {"code": "RELEASE_FIELD_DIRECT_IDENTIFIER", "category": "release", "severity": "error", "retry_advice": "with_modified_input", "tier": "oracle_risk", "decision": "deny", "meaning": "Realized projection includes a direct-identifier column."},
    {"code": "PERMIT_EXPIRED", "category": "permit", "severity": "warn", "retry_advice": "with_modified_input", "tier": "safe", "decision": "deny", "meaning": "Permit TTL elapsed before verify; re-issue."},
    {"code": "PERMIT_CONSUMED", "category": "permit", "severity": "warn", "retry_advice": "with_modified_input", "tier": "safe", "decision": "deny", "meaning": "Single-use permit already verified; re-issue."},
    {"code": "PERMIT_REVOKED", "category": "permit", "severity": "error", "retry_advice": "after_human_approval", "tier": "safe", "decision": "deny", "meaning": "Permit was revoked before consumption."},
    {"code": "PERMIT_INVALID_SIGNATURE", "category": "permit", "severity": "error", "retry_advice": "never", "tier": "safe", "decision": "deny", "meaning": "Permit signature doesn't verify against any known key."},
    {"code": "OUTSIDE_CHANGE_WINDOW", "category": "infra", "severity": "warn", "retry_advice": "after_rate_window", "tier": "safe", "decision": "deny", "meaning": "Action restricted to a declared change window."},
    {"code": "UNAPPROVED_BASE_MODEL", "category": "infra", "severity": "error", "retry_advice": "with_modified_input", "tier": "bounded", "decision": "deny", "meaning": "Base model isn't on the fine-tuning approved list."},
    {"code": "DENY_POLICY", "category": "policy", "severity": "error", "retry_advice": "never", "tier": "bounded", "decision": "deny", "meaning": "The active policy rule explicitly denied the request."},
    {"code": "DENY_AUTHORITY", "category": "actor", "severity": "error", "retry_advice": "with_modified_input", "tier": "bounded", "decision": "deny", "meaning": "Actor's role isn't authorized for this action."},
    {"code": "DENY_ENVIRONMENT", "category": "infra", "severity": "error", "retry_advice": "with_modified_input", "tier": "safe", "decision": "deny", "meaning": "Permit environment doesn't match the request environment."},
    {"code": "VERIFY_FAILED", "category": "permit", "severity": "error", "retry_advice": "with_modified_input", "tier": "safe", "decision": "deny", "meaning": "No permit provided, or it wasn't verified before the action."},
    {"code": "ESCALATE_REQUIRED", "category": "policy", "severity": "warn", "retry_advice": "after_human_approval", "tier": "safe", "decision": "escalate", "meaning": "Inconsistent state; a higher-authority reviewer must decide."},
)

_SLUG_TO_FAMILY: Final = {
    slug: fam["family_id"] for fam in ACTION_CLASS_FAMILIES for slug in fam["example_slugs"]
}
_FAMILY_IDS: Final = frozenset(f["family_id"] for f in ACTION_CLASS_FAMILIES)
_CONDITION_IDS: Final = frozenset(c["condition_id"] for c in CONDITION_TYPES)
_REASON_CODES: Final = frozenset(r["code"] for r in REASON_CODES)


def family_for_slug(slug: str) -> str | None:
    """Roll an action_type slug up to its canonical family id, or None if unmapped."""
    return _SLUG_TO_FAMILY.get(slug)


def get_reason_code(code: str) -> dict | None:
    """Look up reason-code metadata, or None if not a known code."""
    for r in REASON_CODES:
        if r["code"] == code:
            return r
    return None


def is_action_class_family_id(value: str) -> bool:
    return value in _FAMILY_IDS


def is_condition_type_id(value: str) -> bool:
    return value in _CONDITION_IDS


def is_reason_code(value: str) -> bool:
    return value in _REASON_CODES
