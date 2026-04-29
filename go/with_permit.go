package atlasent

import "context"

// WithPermit authorizes a request and runs fn only if AtlaSent issued
// and verified a permit. Returns whatever fn returns.
//
// Where [Client.Protect] returns a verified *Permit and leaves the caller
// to invoke their own action, WithPermit orchestrates the entire
// lifecycle in a single call:
//
//  1. evaluate the request → return *DeniedError on anything other than ALLOW.
//  2. verify the resulting permit → return *DeniedError on Verified=false
//     (covers v1 single-use semantics: a permit consumed by an earlier
//     verify reports verified:false on a replay).
//  3. invoke fn with the verified permit.
//  4. return fn's result.
//
// fn never runs unless steps 1 and 2 succeed. Errors returned by fn
// itself propagate verbatim — the permit is already consumed by step 2
// in v1, so the SDK can't meaningfully roll back; surfacing the
// caller's error is the right behaviour.
//
// Internally, WithPermit delegates to [Client.Protect] so the two paths
// can never drift in fail-closed semantics or error taxonomy. Future
// Protect-side hardening (risk-tier gating, etc.) flows through
// automatically.
//
//	result, err := atlasent.WithPermit(
//	    ctx,
//	    client,
//	    atlasent.EvaluateRequest{
//	        Agent:   "deploy-bot",
//	        Action:  "deploy_to_production",
//	        Context: map[string]any{"commit": commit, "approver": approver},
//	    },
//	    func(permit *atlasent.Permit) (string, error) {
//	        return doDeploy(commit, permit.PermitID)
//	    },
//	)
//
// Mirrors withPermit() (TypeScript, PR #123) and with_permit() (Python).
func WithPermit[T any](
	ctx context.Context,
	c *Client,
	req EvaluateRequest,
	fn func(*Permit) (T, error),
) (T, error) {
	var zero T
	permit, err := c.Protect(ctx, req)
	if err != nil {
		return zero, err
	}
	return fn(permit)
}
