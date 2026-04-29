package atlasent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// Permit is the result of a successful Protect call.
// It proves that the policy engine approved the action and the permit
// passed cryptographic verification.
type Permit struct {
	// PermitID is the evaluation decision ID (dec_…). Use it to open
	// the audit trail for this authorization event.
	PermitID string
	// PermitHash is the cryptographic hash of the verified permit,
	// returned by /v1-verify-permit.
	PermitHash string
	// AuditHash links this authorization to the immutable audit log.
	AuditHash string
	// Reason is the human-readable policy rationale for ALLOW.
	Reason string
	// Timestamp is when the permit was issued (RFC 3339).
	Timestamp string
}

// DeniedError is returned by Protect when:
//   - the policy engine issued a DENY decision, or
//   - the permit failed cryptographic verification after an ALLOW.
//
// It embeds *AtlaSentError so callers can always check errors.As(&AtlaSentError).
type DeniedError struct {
	*AtlaSentError
	// Decision is "DENY" on a policy denial, "verify_failed" when
	// VerifyPermit returned Verified == false.
	Decision string
	// EvaluationID is the decision_id from the ALLOW/DENY response.
	EvaluationID string
	// Reason is the human-readable policy rationale.
	Reason string
	// AuditHash links this event to the audit trail.
	AuditHash string
}

func (e *DeniedError) Error() string {
	return fmt.Sprintf("atlasent: denied (%s) [%s]: %s", e.Decision, e.EvaluationID, e.Reason)
}

// Unwrap lets errors.As / errors.Is traverse to the embedded *AtlaSentError.
func (e *DeniedError) Unwrap() error { return e.AtlaSentError }

// ProtectRequest is the input to Client.Protect.
type ProtectRequest struct {
	Agent   string
	Action  string
	Context map[string]interface{}
}

// Protect combines Evaluate + VerifyPermit into a single blocking call.
//
// On ALLOW + verified it returns a *Permit.
// On policy DENY it returns a *DeniedError with Decision == "DENY".
// On permit verification failure it returns a *DeniedError with
// Decision == "verify_failed".
// Transport/auth errors are returned as *AtlaSentError.
func (c *Client) Protect(ctx context.Context, req ProtectRequest) (*Permit, error) {
	evalResp, err := c.Evaluate(ctx, EvaluateRequest{
		Agent:   req.Agent,
		Action:  req.Action,
		Context: req.Context,
	})
	if err != nil {
		return nil, err
	}
	if !evalResp.Permitted {
		return nil, &DeniedError{
			AtlaSentError: &AtlaSentError{
				Code:    CodeForbidden,
				Message: evalResp.Reason,
			},
			Decision:     "DENY",
			EvaluationID: evalResp.PermitID,
			Reason:       evalResp.Reason,
			AuditHash:    evalResp.AuditHash,
		}
	}

	verifyResp, err := c.VerifyPermit(ctx, VerifyPermitRequest{
		PermitID: evalResp.PermitID,
		Action:   req.Action,
		Agent:    req.Agent,
		Context:  req.Context,
	})
	if err != nil {
		return nil, err
	}
	if !verifyResp.Verified {
		return nil, &DeniedError{
			AtlaSentError: &AtlaSentError{
				Code:    CodeForbidden,
				Message: "permit verification failed: " + verifyResp.Outcome,
			},
			Decision:     "verify_failed",
			EvaluationID: evalResp.PermitID,
			Reason:       "permit " + verifyResp.Outcome,
			AuditHash:    evalResp.AuditHash,
		}
	}

	return &Permit{
		PermitID:   evalResp.PermitID,
		PermitHash: verifyResp.PermitHash,
		AuditHash:  evalResp.AuditHash,
		Reason:     evalResp.Reason,
		Timestamp:  verifyResp.Timestamp,
	}, nil
}

// ── HTTP middleware ──────────────────────────────────────────────────────────

// GuardOptions configures the Guard middleware.
type GuardOptions struct {
	// Agent is the agent identifier sent on every request.
	// Mutually exclusive with GetAgent.
	Agent string
	// Action is the action identifier sent on every request.
	// Mutually exclusive with GetAction.
	Action string

	// GetAgent extracts the agent from the incoming HTTP request.
	// Takes precedence over Agent when set.
	GetAgent func(r *http.Request) string
	// GetAction extracts the action from the incoming HTTP request.
	// Takes precedence over Action when set.
	GetAction func(r *http.Request) string
	// GetContext extracts additional authorization context from the request.
	GetContext func(r *http.Request) map[string]interface{}

	// OnDenied is called when the policy engine denies the action or
	// when permit verification fails. The default writes HTTP 403 JSON.
	OnDenied func(w http.ResponseWriter, r *http.Request, err *DeniedError)
	// OnError is called for transport / auth / server errors.
	// The default writes HTTP 503 JSON.
	OnError func(w http.ResponseWriter, r *http.Request, err error)
}

// Guard returns an http.Handler middleware that calls Protect before
// passing the request to next. The Permit is stored in the request
// context under PermitContextKey.
//
// Example (net/http):
//
//	mux.Handle("/actions/deploy", client.Guard(atlasent.GuardOptions{
//	    GetAgent:  func(r *http.Request) string { return r.Header.Get("X-Agent-ID") },
//	    GetAction: func(r *http.Request) string { return "deploy_to_production" },
//	})(deployHandler))
func (c *Client) Guard(opts GuardOptions) func(http.Handler) http.Handler {
	onDenied := opts.OnDenied
	if onDenied == nil {
		onDenied = defaultOnDenied
	}
	onError := opts.OnError
	if onError == nil {
		onError = defaultOnError
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			agent := opts.Agent
			if opts.GetAgent != nil {
				agent = opts.GetAgent(r)
			}
			action := opts.Action
			if opts.GetAction != nil {
				action = opts.GetAction(r)
			}
			var reqCtx map[string]interface{}
			if opts.GetContext != nil {
				reqCtx = opts.GetContext(r)
			}

			permit, err := c.Protect(r.Context(), ProtectRequest{
				Agent:   agent,
				Action:  action,
				Context: reqCtx,
			})
			if err != nil {
				if denied, ok := err.(*DeniedError); ok {
					onDenied(w, r, denied)
					return
				}
				onError(w, r, err)
				return
			}

			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), PermitContextKey, permit)))
		})
	}
}

// PermitContextKey is the key used to store the *Permit in the request context.
// Downstream handlers retrieve it via r.Context().Value(atlasent.PermitContextKey).
var PermitContextKey = &contextKey{"atlasent-permit"}

type contextKey struct{ name string }

func (k *contextKey) String() string { return "atlasent context key " + k.name }

// PermitFromContext extracts the *Permit stored by Guard.
// Returns nil if the context does not carry a permit (i.e. the middleware was bypassed).
func PermitFromContext(ctx context.Context) *Permit {
	p, _ := ctx.Value(PermitContextKey).(*Permit)
	return p
}

// ── default error handlers ───────────────────────────────────────────────────

func defaultOnDenied(w http.ResponseWriter, _ *http.Request, err *DeniedError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error":   "forbidden",
		"reason":  err.Reason,
		"permit":  err.EvaluationID,
		"decision": err.Decision,
	})
}

func defaultOnError(w http.ResponseWriter, _ *http.Request, _ error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error": "authorization_service_unavailable",
	})
}
