package atlasent

import (
	"context"
	"errors"
	"testing"
)

// Sanity tests for the scaffold. Exercise: client construction, the
// canonical Decision values, and that every public method returns
// ErrNotImplemented today (so a downstream consumer pinning the
// scaffold version sees a clear error rather than silent success).

func TestNewClientStoresOptions(t *testing.T) {
	c := NewClient(ClientOptions{APIKey: "k", BaseURL: "https://example"})
	if c == nil {
		t.Fatal("NewClient returned nil")
	}
	if c.opts.APIKey != "k" {
		t.Errorf("APIKey = %q, want %q", c.opts.APIKey, "k")
	}
}

func TestDecisionConstants(t *testing.T) {
	cases := []struct {
		got, want Decision
	}{
		{DecisionAllow, "allow"},
		{DecisionDeny, "deny"},
		{DecisionHold, "hold"},
		{DecisionEscalate, "escalate"},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Errorf("Decision = %q, want %q", tc.got, tc.want)
		}
	}
}

func TestEvaluateScaffold(t *testing.T) {
	c := NewClient(ClientOptions{})
	_, err := c.Evaluate(context.Background(), EvaluateRequest{
		ActionType: "deploy",
		ActorID:    "actor1",
	})
	if !errors.Is(err, ErrNotImplemented) {
		t.Errorf("Evaluate err = %v, want ErrNotImplemented", err)
	}
}

func TestVerifyPermitScaffold(t *testing.T) {
	c := NewClient(ClientOptions{})
	_, err := c.VerifyPermit(context.Background(), VerifyPermitRequest{
		PermitToken: "deadbeef",
	})
	if !errors.Is(err, ErrNotImplemented) {
		t.Errorf("VerifyPermit err = %v, want ErrNotImplemented", err)
	}
}

func TestProtectScaffold(t *testing.T) {
	c := NewClient(ClientOptions{})
	_, err := c.Protect(context.Background(), ProtectRequest{
		Agent:  "deploy-bot",
		Action: "deploy",
	})
	if !errors.Is(err, ErrNotImplemented) {
		t.Errorf("Protect err = %v, want ErrNotImplemented", err)
	}
}
