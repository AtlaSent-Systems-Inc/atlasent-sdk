package atlasent_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	atlasent "github.com/atlasent-systems-inc/atlasent-sdk/go"
)

// ── Wire fixtures ──────────────────────────────────────────────────────

var evaluatePermitBody = map[string]any{
	"permitted":   true,
	"decision":    "ALLOW",
	"decision_id": "dec_alpha",
	"reason":      "policy authorized",
	"audit_hash":  "hash_alpha",
	"timestamp":   "2026-04-29T18:00:00Z",
}

var evaluateDenyBody = map[string]any{
	"permitted":   false,
	"decision":    "DENY",
	"decision_id": "dec_beta",
	"reason":      "missing change_reason",
	"audit_hash":  "hash_beta",
	"timestamp":   "2026-04-29T18:00:00Z",
}

var verifyOKBody = map[string]any{
	"verified":    true,
	"outcome":     "verified",
	"permit_hash": "permit_alpha",
	"timestamp":   "2026-04-29T18:00:01Z",
}

var verifyConsumedBody = map[string]any{
	"verified":    false,
	"outcome":     "permit_consumed",
	"permit_hash": "permit_alpha",
	"timestamp":   "2026-04-29T18:00:01Z",
}

// scriptedServer routes each path to a fixed JSON body. evaluate calls hit
// /v1-evaluate; verify calls hit /v1-verify-permit. Pass nil for either to
// have that path return 500 (catches "should not have called X").
func scriptedServer(
	t *testing.T,
	evaluate map[string]any,
	verify map[string]any,
	evalStatus int,
	verifyStatus int,
) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1-evaluate", func(w http.ResponseWriter, r *http.Request) {
		if evaluate == nil {
			http.Error(w, "evaluate not scripted", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if evalStatus != 0 {
			w.WriteHeader(evalStatus)
		}
		_ = json.NewEncoder(w).Encode(evaluate)
	})
	mux.HandleFunc("/v1-verify-permit", func(w http.ResponseWriter, r *http.Request) {
		if verify == nil {
			http.Error(w, "verify not scripted", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if verifyStatus != 0 {
			w.WriteHeader(verifyStatus)
		}
		_ = json.NewEncoder(w).Encode(verify)
	})
	return httptest.NewServer(mux)
}

// ── Client.Protect ─────────────────────────────────────────────────────

func TestProtect_AllowReturnsVerifiedPermit(t *testing.T) {
	srv := scriptedServer(t, evaluatePermitBody, verifyOKBody, 200, 200)
	defer srv.Close()
	client := newClientAgainst(t, srv)

	permit, err := client.Protect(context.Background(), atlasent.EvaluateRequest{
		Agent:  "deploy-bot",
		Action: "deploy",
	})
	if err != nil {
		t.Fatalf("Protect: %v", err)
	}
	if permit.PermitID != "dec_alpha" {
		t.Errorf("PermitID = %q, want dec_alpha", permit.PermitID)
	}
	if permit.PermitHash != "permit_alpha" {
		t.Errorf("PermitHash = %q, want permit_alpha", permit.PermitHash)
	}
	if permit.AuditHash != "hash_alpha" {
		t.Errorf("AuditHash = %q, want hash_alpha", permit.AuditHash)
	}
}

func TestProtect_DenyReturnsDeniedError(t *testing.T) {
	srv := scriptedServer(t, evaluateDenyBody, nil, 200, 0)
	defer srv.Close()
	client := newClientAgainst(t, srv)

	_, err := client.Protect(context.Background(), atlasent.EvaluateRequest{
		Agent: "bot", Action: "deploy",
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var denied *atlasent.DeniedError
	if !errors.As(err, &denied) {
		t.Fatalf("err type = %T, want *DeniedError", err)
	}
	if denied.Decision != atlasent.DecisionDeny {
		t.Errorf("Decision = %q, want deny", denied.Decision)
	}
	if denied.EvaluationID != "dec_beta" {
		t.Errorf("EvaluationID = %q, want dec_beta", denied.EvaluationID)
	}
	if !strings.Contains(denied.Reason, "missing change_reason") {
		t.Errorf("Reason = %q, want substring 'missing change_reason'", denied.Reason)
	}
}

func TestProtect_VerifyConsumedReturnsDeniedError(t *testing.T) {
	srv := scriptedServer(t, evaluatePermitBody, verifyConsumedBody, 200, 200)
	defer srv.Close()
	client := newClientAgainst(t, srv)

	_, err := client.Protect(context.Background(), atlasent.EvaluateRequest{
		Agent: "bot", Action: "deploy",
	})
	var denied *atlasent.DeniedError
	if !errors.As(err, &denied) {
		t.Fatalf("err type = %T, want *DeniedError", err)
	}
	if !strings.Contains(denied.Reason, "permit_consumed") {
		t.Errorf("Reason = %q, want substring 'permit_consumed'", denied.Reason)
	}
}

func TestProtect_5xxOnEvaluateReturnsAtlaSentError(t *testing.T) {
	srv := scriptedServer(t, map[string]any{"error": "boom"}, nil, 500, 0)
	defer srv.Close()
	client := newClientAgainst(t, srv)

	_, err := client.Protect(context.Background(), atlasent.EvaluateRequest{
		Agent: "bot", Action: "deploy",
	})
	if err == nil {
		t.Fatal("expected error")
	}
	var apiErr *atlasent.AtlaSentError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err type = %T, want *AtlaSentError", err)
	}
	if apiErr.Code != atlasent.CodeServerError {
		t.Errorf("Code = %q, want server_error", apiErr.Code)
	}
	var denied *atlasent.DeniedError
	if errors.As(err, &denied) {
		t.Error("server_error should NOT also satisfy DeniedError")
	}
}

// ── WithPermit ─────────────────────────────────────────────────────────

func TestWithPermit_AllowedRunsCallback(t *testing.T) {
	srv := scriptedServer(t, evaluatePermitBody, verifyOKBody, 200, 200)
	defer srv.Close()
	client := newClientAgainst(t, srv)

	var seen *atlasent.Permit
	result, err := atlasent.WithPermit(
		context.Background(),
		client,
		atlasent.EvaluateRequest{Agent: "deploy-bot", Action: "deploy"},
		func(permit *atlasent.Permit) (string, error) {
			seen = permit
			return "ran", nil
		},
	)
	if err != nil {
		t.Fatalf("WithPermit: %v", err)
	}
	if result != "ran" {
		t.Errorf("result = %q, want ran", result)
	}
	if seen == nil || seen.PermitID != "dec_alpha" {
		t.Errorf("callback received permit = %+v, want PermitID=dec_alpha", seen)
	}
}

func TestWithPermit_DenyDoesNotInvokeCallback(t *testing.T) {
	srv := scriptedServer(t, evaluateDenyBody, nil, 200, 0)
	defer srv.Close()
	client := newClientAgainst(t, srv)

	called := false
	_, err := atlasent.WithPermit(
		context.Background(),
		client,
		atlasent.EvaluateRequest{Agent: "bot", Action: "deploy"},
		func(*atlasent.Permit) (string, error) {
			called = true
			return "", nil
		},
	)
	if err == nil {
		t.Fatal("expected error")
	}
	var denied *atlasent.DeniedError
	if !errors.As(err, &denied) {
		t.Fatalf("err type = %T, want *DeniedError", err)
	}
	if called {
		t.Error("callback was invoked despite denial — fail-closed contract violated")
	}
}

// TestWithPermit_ReplayConsumedDoesNotInvokeCallback is the v1 single-use
// guarantee made explicit. Even if a caller stashed and re-invoked
// WithPermit with the same request, the server reports
// verified:false / outcome:permit_consumed and the wrapped callback
// MUST NOT run.
func TestWithPermit_ReplayConsumedDoesNotInvokeCallback(t *testing.T) {
	srv := scriptedServer(t, evaluatePermitBody, verifyConsumedBody, 200, 200)
	defer srv.Close()
	client := newClientAgainst(t, srv)

	called := false
	_, err := atlasent.WithPermit(
		context.Background(),
		client,
		atlasent.EvaluateRequest{Agent: "bot", Action: "deploy"},
		func(*atlasent.Permit) (int, error) {
			called = true
			return 0, nil
		},
	)
	if called {
		t.Fatal("callback ran on replay/consumed permit — fail-closed violated")
	}
	var denied *atlasent.DeniedError
	if !errors.As(err, &denied) {
		t.Fatalf("err type = %T, want *DeniedError", err)
	}
	if !strings.Contains(denied.Reason, "permit_consumed") {
		t.Errorf("Reason = %q, want substring 'permit_consumed'", denied.Reason)
	}
}

// TestWithPermit_CallbackErrorPropagatesVerbatim — fn's error wraps unchanged.
func TestWithPermit_CallbackErrorPropagatesVerbatim(t *testing.T) {
	srv := scriptedServer(t, evaluatePermitBody, verifyOKBody, 200, 200)
	defer srv.Close()
	client := newClientAgainst(t, srv)

	sentinel := errors.New("user code blew up")
	_, err := atlasent.WithPermit(
		context.Background(),
		client,
		atlasent.EvaluateRequest{Agent: "bot", Action: "deploy"},
		func(*atlasent.Permit) (string, error) {
			return "", sentinel
		},
	)
	if !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want errors.Is(_, sentinel) == true", err)
	}
	var denied *atlasent.DeniedError
	if errors.As(err, &denied) {
		t.Error("callback error must not be converted to DeniedError")
	}
}

func TestWithPermit_5xxOnEvaluateDoesNotInvokeCallback(t *testing.T) {
	srv := scriptedServer(t, map[string]any{"error": "boom"}, nil, 500, 0)
	defer srv.Close()
	client := newClientAgainst(t, srv)

	called := false
	_, err := atlasent.WithPermit(
		context.Background(),
		client,
		atlasent.EvaluateRequest{Agent: "bot", Action: "deploy"},
		func(*atlasent.Permit) (string, error) {
			called = true
			return "", nil
		},
	)
	if called {
		t.Error("callback ran despite server error")
	}
	var apiErr *atlasent.AtlaSentError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err type = %T, want *AtlaSentError", err)
	}
}

// TestWithPermit_GenericReturnTypePreserved — generic T flows through.
func TestWithPermit_GenericReturnTypePreserved(t *testing.T) {
	srv := scriptedServer(t, evaluatePermitBody, verifyOKBody, 200, 200)
	defer srv.Close()
	client := newClientAgainst(t, srv)

	type result struct {
		OK       bool
		PermitID string
	}

	out, err := atlasent.WithPermit(
		context.Background(),
		client,
		atlasent.EvaluateRequest{Agent: "bot", Action: "deploy"},
		func(p *atlasent.Permit) (result, error) {
			return result{OK: true, PermitID: p.PermitID}, nil
		},
	)
	if err != nil {
		t.Fatalf("WithPermit: %v", err)
	}
	if !out.OK || out.PermitID != "dec_alpha" {
		t.Errorf("out = %+v, want {true dec_alpha}", out)
	}
}
