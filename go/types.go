package atlasent

// Wire types for the AtlaSent v1 API.
//
// Source of truth: atlasent-api/openapi.yaml (sections under
// `components.schemas`). Field names use json:"snake_case" tags that
// match the wire payload byte-for-byte; Go-side names are CamelCase.
//
// SSO types mirror typescript/src/sso.ts (which mirrors the v1-sso
// handler). When the contract evolves the change goes through
// `contract/schemas/` first; this file follows in the same PR.

// ─── Decision enum ───────────────────────────────────────────────────

// Decision is the canonical four-value decision the policy engine
// returns. Matches the DB CHECK on `execution_evaluations.decision`
// and the SDK engine output. `hold` and `escalate` are distinct
// authorization states — do not collapse to a binary "allow / deny".
type Decision string

const (
	DecisionAllow    Decision = "allow"
	DecisionDeny     Decision = "deny"
	DecisionHold     Decision = "hold"
	DecisionEscalate Decision = "escalate"
)

// ─── Risk ────────────────────────────────────────────────────────────

// RiskLevel mirrors the openapi enum; emitted on every Decision.
type RiskLevel string

const (
	RiskLevelLow      RiskLevel = "low"
	RiskLevelMedium   RiskLevel = "medium"
	RiskLevelHigh     RiskLevel = "high"
	RiskLevelCritical RiskLevel = "critical"
)

// RiskAssessment carries the engine's risk score and the structured
// reasons that produced it. `Reasons` is always non-nil on the wire
// (server emits `[]` when empty); the Go zero value is nil so unmarshal
// produces an empty slice in that case.
type RiskAssessment struct {
	Level         RiskLevel      `json:"level"`
	Score         float64        `json:"score"`
	Reasons       []string       `json:"reasons"`
	DomainSignals map[string]any `json:"domain_signals,omitempty"`
}

// ─── Permit ──────────────────────────────────────────────────────────

// PermitStatus mirrors the openapi enum; tracked by the permit's
// lifecycle on the server.
type PermitStatus string

const (
	PermitStatusIssued   PermitStatus = "issued"
	PermitStatusVerified PermitStatus = "verified"
	PermitStatusConsumed PermitStatus = "consumed"
	PermitStatusExpired  PermitStatus = "expired"
	PermitStatusRevoked  PermitStatus = "revoked"
)

// Permit is the signed authorization artifact returned with an
// `allow` decision. `Signature` is the Ed25519 signature (base64url)
// over the permit's canonical bytes.
type Permit struct {
	ID          string       `json:"id"`
	OrgID       string       `json:"org_id"`
	ActorID     string       `json:"actor_id"`
	ActionID    string       `json:"action_id"`
	TargetID    string       `json:"target_id,omitempty"`
	Environment string       `json:"environment,omitempty"`
	Status      PermitStatus `json:"status"`
	IssuedAt    string       `json:"issued_at"`
	ExpiresAt   string       `json:"expires_at"`
	ConsumedAt  string       `json:"consumed_at,omitempty"`
	Signature   string       `json:"signature,omitempty"`
}

// ─── Evaluation request ──────────────────────────────────────────────

// EvaluationActor identifies who is asking. `Type` is one of
// "user", "agent", "service".
type EvaluationActor struct {
	Actor      string         `json:"-"` // unused; placeholder to keep zero-value usable
	ID         string         `json:"id"`
	Type       string         `json:"type"`
	OrgID      string         `json:"org_id"`
	Roles      []string       `json:"roles,omitempty"`
	Attributes map[string]any `json:"attributes,omitempty"`
}

// EvaluationAction names the action being authorized. `Category` is
// optional — used by the rule engine's category-level matchers.
type EvaluationAction struct {
	ID       string `json:"id"`
	Category string `json:"category,omitempty"`
}

// EvaluationTarget describes the resource the action operates on.
// All fields are optional — actions like "list resources" carry no
// target.
type EvaluationTarget struct {
	ID         string         `json:"id,omitempty"`
	Type       string         `json:"type,omitempty"`
	Attributes map[string]any `json:"attributes,omitempty"`
}

// EvaluationRequest is the body of POST /v1/evaluate.
//
// `RequestID` doubles as an idempotency key — the server returns the
// same Decision for two requests with identical RequestID within a
// short window.
type EvaluationRequest struct {
	Actor       EvaluationActor   `json:"actor"`
	Action      EvaluationAction  `json:"action"`
	Target      *EvaluationTarget `json:"target,omitempty"`
	Context     map[string]any    `json:"context,omitempty"`
	Environment string            `json:"environment,omitempty"`
	RequestID   string            `json:"request_id,omitempty"`
}

// ─── Evaluation response ─────────────────────────────────────────────

// EvaluationResponse is the wire shape returned by POST /v1/evaluate.
// Aliased as Decision-shaped to match the openapi naming, but kept as
// its own type so the type name doesn't collide with the Decision
// enum.
//
// Permit is only set when Decision == DecisionAllow; the openapi spec
// guarantees absence on deny / hold / escalate.
type EvaluationResponse struct {
	Decision        Decision       `json:"decision"`
	MatchedRuleID   string         `json:"matched_rule_id,omitempty"`
	MatchedPolicyID string         `json:"matched_policy_id,omitempty"`
	DenyCode        string         `json:"deny_code,omitempty"`
	DenyReason      string         `json:"deny_reason,omitempty"`
	Risk            RiskAssessment `json:"risk"`
	Obligations     []map[string]any `json:"obligations,omitempty"`
	Permit          *Permit        `json:"permit,omitempty"`
	EvaluatedAt     string         `json:"evaluated_at"`
	EvaluationID    string         `json:"evaluation_id"`
}

// ─── SSO types ───────────────────────────────────────────────────────

// SsoProtocol is the IdP protocol an SSO connection speaks.
type SsoProtocol string

const (
	SsoProtocolSAML SsoProtocol = "saml"
	SsoProtocolOIDC SsoProtocol = "oidc"
)

// SsoCanonicalRole tracks the handler's CANONICAL_ROLES — the role
// set a JIT rule may grant. Reflected in the `granted_role` CHECK
// constraint on `sso_jit_provisioning_rules`.
type SsoCanonicalRole string

const (
	SsoRoleOwner    SsoCanonicalRole = "owner"
	SsoRoleAdmin    SsoCanonicalRole = "admin"
	SsoRoleApprover SsoCanonicalRole = "approver"
	SsoRoleMember   SsoCanonicalRole = "member"
	SsoRoleViewer   SsoCanonicalRole = "viewer"
)

// SsoEventType lists the lifecycle tags persisted into
// `sso_events.event_type`. Drawn from the table CHECK constraint in
// migration 0041.
type SsoEventType string

const (
	SsoEventLoginSuccess         SsoEventType = "login_success"
	SsoEventLoginDenied          SsoEventType = "login_denied"
	SsoEventJitProvisioned       SsoEventType = "jit_provisioned"
	SsoEventRoleChanged          SsoEventType = "role_changed"
	SsoEventConnectionCreated    SsoEventType = "connection_created"
	SsoEventConnectionUpdated    SsoEventType = "connection_updated"
	SsoEventConnectionDeleted    SsoEventType = "connection_deleted"
	SsoEventConnectionActivated  SsoEventType = "connection_activated"
	SsoEventConnectionDeactivated SsoEventType = "connection_deactivated"
)

// SsoConnection is one row from `sso_connections` as returned by
// GET /v1/sso/connections.
type SsoConnection struct {
	ID                 string      `json:"id"`
	OrganizationID     string      `json:"organization_id"`
	Name               string      `json:"name"`
	Protocol           SsoProtocol `json:"protocol"`
	SupabaseProviderID *string     `json:"supabase_provider_id"`
	IdpEntityID        string      `json:"idp_entity_id"`
	MetadataURL        *string     `json:"metadata_url"`
	MetadataXML        *string     `json:"metadata_xml"`
	EmailDomain        *string     `json:"email_domain"`
	EnforceForDomain   bool        `json:"enforce_for_domain"`
	IsActive           bool        `json:"is_active"`
	CreatedAt          string      `json:"created_at"`
	UpdatedAt          string      `json:"updated_at"`
	CreatedBy          *string     `json:"created_by,omitempty"`
}

// SsoJitRule is one row from `sso_jit_provisioning_rules`.
type SsoJitRule struct {
	ID             string           `json:"id"`
	ConnectionID   string           `json:"connection_id"`
	OrganizationID string           `json:"organization_id"`
	ClaimAttribute string           `json:"claim_attribute"`
	ClaimValue     string           `json:"claim_value"`
	GrantedRole    SsoCanonicalRole `json:"granted_role"`
	Precedence     int              `json:"precedence"`
	IsActive       bool             `json:"is_active"`
	CreatedAt      string           `json:"created_at"`
	UpdatedAt      string           `json:"updated_at"`
}

// SsoEvent is one row from `sso_events` as returned by
// GET /v1/sso/events.
type SsoEvent struct {
	ID             string         `json:"id"`
	OrganizationID string         `json:"organization_id"`
	ConnectionID   *string        `json:"connection_id"`
	EventType      SsoEventType   `json:"event_type"`
	ActorEmail     *string        `json:"actor_email"`
	Payload        map[string]any `json:"payload"`
	OccurredAt     string         `json:"occurred_at"`
}
