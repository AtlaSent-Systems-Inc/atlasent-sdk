// Package atlasent is the AtlaSent Go SDK — execution-time
// authorization for AI agents.
//
// Status: scaffold. Method signatures mirror the TS and Python SDKs
// for cross-language parity (see ../contract/SDK_COMPATIBILITY.md).
// Implementations return errors today; the next release will land
// the HTTP transport and contract round-trip vectors.
//
// Quick start (when implemented):
//
//	import "github.com/AtlaSent-Systems-Inc/atlasent-sdk/go"
//
//	client := atlasent.NewClient(atlasent.ClientOptions{
//		APIKey:  os.Getenv("ATLASENT_API_KEY"),
//		BaseURL: "https://api.atlasent.io",
//	})
//	permit, err := client.Protect(ctx, atlasent.ProtectRequest{
//		Agent:  "deploy-bot",
//		Action: "deploy_to_production",
//	})
//	if err != nil { return err }
//	_ = permit
//
// Wire format: JSON, snake_case, the same two endpoints as every
// other SDK — POST /v1-evaluate and POST /v1-verify-permit.
package atlasent

import (
	"context"
	"errors"
)

// Version is the SDK version. Bumped in lockstep with TS/Python via
// coordinated tags (see ../RELEASING.md).
const Version = "0.1.0-rc.0"

// ErrNotImplemented is returned by every method until the
// implementation lands. Tests may match this error to detect a
// scaffold installation.
var ErrNotImplemented = errors.New("atlasent: scaffold release; implementation pending")

// Decision is the four-valued backend decision. Note: the Go SDK,
// unlike TypeScript and Python, exposes the full four-valued enum
// on the public surface. The TS SDK collapses to ALLOW/DENY for
// historical reasons; the Python SDK mirrors TS. Go is greenfield,
// so we ship the canonical literal here from day one.
type Decision string

const (
	DecisionAllow    Decision = "allow"
	DecisionDeny     Decision = "deny"
	DecisionHold     Decision = "hold"
	DecisionEscalate Decision = "escalate"
)

// ClientOptions configures the AtlaSent client.
type ClientOptions struct {
	// APIKey is the bearer token (ask_live_* or ask_test_*).
	APIKey string
	// BaseURL of the AtlaSent API. Defaults to the public production
	// URL when empty.
	BaseURL string
	// Timeout for every HTTP request. Defaults to 10s when zero.
	TimeoutSeconds int
}

// Client is the AtlaSent SDK entry point.
type Client struct {
	opts ClientOptions
}

// NewClient constructs a Client from the given options.
func NewClient(opts ClientOptions) *Client { return &Client{opts: opts} }

// EvaluateRequest is the body of POST /v1-evaluate.
type EvaluateRequest struct {
	ActionType string                 `json:"action_type"`
	ActorID    string                 `json:"actor_id"`
	Context    map[string]interface{} `json:"context,omitempty"`
	RequestID  string                 `json:"request_id,omitempty"`
	Shadow     bool                   `json:"shadow,omitempty"`
	Explain    bool                   `json:"explain,omitempty"`
}

// EvaluateResponse is the response from POST /v1-evaluate.
type EvaluateResponse struct {
	Decision     Decision `json:"decision"`
	PermitToken  string   `json:"permit_token,omitempty"`
	RequestID    string   `json:"request_id"`
	Mode         string   `json:"mode"`
	CacheHit     bool     `json:"cache_hit"`
	EvaluationMs int      `json:"evaluation_ms"`
	ExpiresAt    string   `json:"expires_at,omitempty"`
	DenyCode     string   `json:"deny_code,omitempty"`
	DenyReason   string   `json:"deny_reason,omitempty"`
}

// Evaluate performs an authorization decision.
func (c *Client) Evaluate(ctx context.Context, req EvaluateRequest) (*EvaluateResponse, error) {
	_ = ctx
	_ = req
	return nil, ErrNotImplemented
}

// VerifyPermitRequest is the body of POST /v1-verify-permit.
type VerifyPermitRequest struct {
	PermitToken string `json:"permit_token"`
	ActionType  string `json:"action_type,omitempty"`
	ActorID     string `json:"actor_id,omitempty"`
}

// VerifyPermitResponse is the response from POST /v1-verify-permit.
type VerifyPermitResponse struct {
	Valid           bool     `json:"valid"`
	Outcome         string   `json:"outcome"`
	Decision        Decision `json:"decision,omitempty"`
	Reason          string   `json:"reason,omitempty"`
	VerifyErrorCode string   `json:"verify_error_code,omitempty"`
}

// VerifyPermit consumes a permit. Single-use; subsequent calls with
// the same permit return PERMIT_ALREADY_USED.
func (c *Client) VerifyPermit(ctx context.Context, req VerifyPermitRequest) (*VerifyPermitResponse, error) {
	_ = ctx
	_ = req
	return nil, ErrNotImplemented
}

// ProtectRequest is the input to Protect.
type ProtectRequest struct {
	Agent   string                 `json:"agent"`
	Action  string                 `json:"action"`
	Context map[string]interface{} `json:"context,omitempty"`
}

// Permit is the success return from Protect.
type Permit struct {
	PermitID   string `json:"permit_id"`
	PermitHash string `json:"permit_hash"`
	AuditHash  string `json:"audit_hash"`
	Reason     string `json:"reason,omitempty"`
	Timestamp  string `json:"timestamp,omitempty"`
}

// Protect runs Evaluate + VerifyPermit end-to-end. Fail-closed: any
// error or non-allow decision returns an error.
func (c *Client) Protect(ctx context.Context, req ProtectRequest) (*Permit, error) {
	_ = ctx
	_ = req
	return nil, ErrNotImplemented
}
