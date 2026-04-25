// Package atlasent is the Go client for the AtlaSent authorization API
// (https://api.atlasent.io).
//
// AtlaSent is execution-time authorization for AI agents and other
// non-human actors: every action gets a deterministic allow / deny /
// hold / escalate decision plus an optional Ed25519-signed permit
// suitable for downstream verification.
//
// # Quick start
//
//	client := atlasent.NewClient(
//	    "https://api.atlasent.io",
//	    os.Getenv("ATLASENT_API_KEY"),
//	)
//
//	decision, err := client.Evaluate(ctx, atlasent.EvaluationRequest{
//	    Actor:  atlasent.EvaluationActor{ID: "agent.deploy-bot", Type: "agent", OrgID: "org_123"},
//	    Action: atlasent.EvaluationAction{ID: "deploy_to_production"},
//	    Context: map[string]any{"commit": commitSHA, "approver": approverID},
//	})
//	if err != nil {
//	    // Transport / HTTP errors are typed — fail-closed: never proceed on error.
//	    return err
//	}
//	if decision.Decision != atlasent.DecisionAllow {
//	    return fmt.Errorf("atlasent denied: %s", decision.DenyReason)
//	}
//	// decision.Permit is set when Decision == "allow".
//
// # Fail-closed discipline
//
// Mirroring the discipline from the GitHub Action wrapper
// (atlasent-action), transport errors (network, timeout, 5xx) DO NOT
// degrade to "allow". The recommended pattern is to treat any non-nil
// error as a block; the typed errors below let callers branch on the
// failure family if they need finer control:
//
//	switch {
//	case errors.Is(err, atlasent.ErrUnauthorized):
//	    // bad / revoked / expired API key — operator action required
//	case errors.Is(err, atlasent.ErrRateLimited):
//	    // back off; check decision.Decision == "" before retrying
//	case errors.Is(err, atlasent.ErrServer):
//	    // transient backend; retry with jitter
//	default:
//	    // network / timeout / parse error — block and alert
//	}
//
// # Status
//
// v1.0.0 not yet tagged. Tag `go/v1.0.0` to publish (Go modules
// resolve from git tags; no workflow needed beyond the tag itself).
package atlasent
