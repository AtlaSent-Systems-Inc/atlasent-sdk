package atlasent

// EvaluateRequest is the input to Client.Evaluate.
type EvaluateRequest struct {
	Agent   string                 `json:"agent"`
	Action  string                 `json:"action"`
	Context map[string]interface{} `json:"context,omitempty"`
}

// EvaluateResponse is returned by Client.Evaluate.
// A DENY decision is returned as data (Permitted == false), not an error.
type EvaluateResponse struct {
	Decision  string // "ALLOW" or "DENY"
	Permitted bool
	PermitID  string
	Reason    string
	AuditHash string
	Timestamp string
	RateLimit *RateLimitState
}

// VerifyPermitRequest is the input to Client.VerifyPermit.
type VerifyPermitRequest struct {
	PermitID string
	Action   string
	Agent    string
	Context  map[string]interface{}
}

// VerifyPermitResponse is returned by Client.VerifyPermit.
// Verified == false is returned as data, not an error.
type VerifyPermitResponse struct {
	Verified   bool
	Outcome    string
	PermitHash string
	Timestamp  string
	RateLimit  *RateLimitState
}

// RateLimitState carries the parsed X-RateLimit-* headers when present.
type RateLimitState struct {
	Limit     int
	Remaining int
	ResetAt   int64 // unix seconds
}
