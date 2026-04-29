package atlasent

import (
	"context"
	"fmt"
)

// Permit is the verified-end-to-end success result of [Client.Protect] or
// [WithPermit]. If you have one, the policy engine allowed the request and
// the resulting permit verified — it's safe to run the action.
//
// Mirrors the TypeScript SDK's Permit and the Python SDK's Permit dataclass.
type Permit struct {
	// PermitID is the opaque permit / decision identifier.
	PermitID string
	// PermitHash is the verification hash bound to the permit.
	PermitHash string
	// AuditHash is the hash-chain audit-trail entry for the decision.
	AuditHash string
	// Reason is the human-readable reason from the policy engine.
	Reason string
	// Timestamp is the ISO 8601 timestamp of the verification.
	Timestamp string
}

// Decision is the policy decision that produced a denial.
//
// "deny" today; "hold" / "escalate" reserved for v2 surfaces. Mirrors the
// TS AtlaSentDecision and Python AtlaSentDecision string unions.
type Decision string

const (
	DecisionDeny     Decision = "deny"
	DecisionHold     Decision = "hold"
	DecisionEscalate Decision = "escalate"
)

// DeniedError is returned by [Client.Protect] and [WithPermit] when the
// policy engine refuses the action OR when a permit fails end-to-end
// verification.
//
// This is the fail-closed boundary of the SDK: every code path that
// short-circuits an action because authorization was not confirmed
// returns a *DeniedError. Callers branch with errors.As:
//
//	permit, err := client.Protect(ctx, req)
//	if err != nil {
//	    var denied *atlasent.DeniedError
//	    if errors.As(err, &denied) {
//	        // Policy denied or permit failed verification.
//	        return
//	    }
//	    // Transport / auth / server error — fail closed.
//	    return err
//	}
type DeniedError struct {
	// Decision is "deny" today; "hold" / "escalate" reserved.
	Decision Decision
	// EvaluationID is the opaque permit/decision id from /v1-evaluate.
	EvaluationID string
	// Reason is the human-readable explanation from the policy engine,
	// or empty if not provided.
	Reason string
	// AuditHash is the hash-chained audit-trail entry associated with
	// the decision.
	AuditHash string
}

func (e *DeniedError) Error() string {
	if e.Reason != "" {
		return fmt.Sprintf("atlasent %s: %s", e.Decision, e.Reason)
	}
	return fmt.Sprintf("atlasent %s", e.Decision)
}

// wireDecisionToDenied maps the v1 server's "DENY" / "ALLOW" / future
// values to the Decision enum. Mirrors the TS wireDecisionToDenied —
// unknown values default to "deny" rather than passing through unchanged
// so the fail-closed contract holds even if the server adds new shapes.
func wireDecisionToDenied(serverDecision string) Decision {
	switch lowercaseASCII(serverDecision) {
	case "hold":
		return DecisionHold
	case "escalate":
		return DecisionEscalate
	default:
		return DecisionDeny
	}
}

// lowercaseASCII is a strings.ToLower without the unicode dependency —
// the v1 wire enum is ASCII-only.
func lowercaseASCII(s string) string {
	out := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out[i] = c
	}
	return string(out)
}

// Protect authorizes an action end-to-end — the category primitive.
//
// On allow, returns a verified *Permit. On policy denial or permit
// verification failure, returns a *DeniedError (use errors.As). On
// transport / auth / rate-limit / server error, returns *AtlaSentError.
//
// This is the fail-closed boundary: there is no permitted=false return
// path. If Protect returns no error, the action is authorized; if it
// returns an error, the action MUST NOT proceed.
//
// Mirrors atlasent.protect() (TS) and atlasent.protect() (Python).
func (c *Client) Protect(ctx context.Context, req EvaluateRequest) (*Permit, error) {
	eval, err := c.Evaluate(ctx, req)
	if err != nil {
		return nil, err
	}
	if !eval.Permitted {
		return nil, &DeniedError{
			Decision:     wireDecisionToDenied(eval.Decision),
			EvaluationID: eval.PermitID,
			Reason:       eval.Reason,
			AuditHash:    eval.AuditHash,
		}
	}
	verifyReq := VerifyPermitRequest{
		PermitID: eval.PermitID,
		Action:   req.Action,
		Agent:    req.Agent,
		Context:  req.Context,
	}
	verify, err := c.VerifyPermit(ctx, verifyReq)
	if err != nil {
		return nil, err
	}
	if !verify.Verified {
		return nil, &DeniedError{
			Decision:     DecisionDeny,
			EvaluationID: eval.PermitID,
			Reason:       fmt.Sprintf("Permit failed verification (%s)", verify.Outcome),
			AuditHash:    eval.AuditHash,
		}
	}
	return &Permit{
		PermitID:   eval.PermitID,
		PermitHash: verify.PermitHash,
		AuditHash:  eval.AuditHash,
		Reason:     eval.Reason,
		Timestamp:  verify.Timestamp,
	}, nil
}
