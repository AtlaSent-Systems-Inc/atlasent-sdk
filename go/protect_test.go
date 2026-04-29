package atlasent_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	atlasent "github.com/atlasent-systems-inc/atlasent-sdk/go"
)

// mockSeq returns a handler that serves responses from a FIFO queue.
func mockSeq(t *testing.T, responses []map[string]interface{}) *httptest.Server {
	t.Helper()
	queue := make([]map[string]interface{}, len(responses))
	copy(queue, responses)
	idx := 0
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if idx >= len(queue) {
			t.Errorf("mockSeq: unexpected request #%d", idx+1)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(queue[idx])
		idx++
	}))
}

func newProtectClient(t *testing.T, srv *httptest.Server) *atlasent.Client {
	t.Helper()
	c, err := atlasent.New(atlasent.Options{
		APIKey:      "ask_test",
		BaseURL:     srv.URL,
		HTTPClient:  &http.Client{Timeout: 5 * time.Second},
		RetryPolicy: atlasent.RetryPolicy{MaxAttempts: 1},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

var allowWire = map[string]interface{}{
	"permitted": true, "decision_id": "dec_alpha",
	"reason": "GxP policy authorized", "audit_hash": "hash_alpha",
	"timestamp": "2026-04-29T10:00:00Z",
}
var denyWire = map[string]interface{}{
	"permitted": false, "decision_id": "dec_beta",
	"reason": "Missing change_reason", "audit_hash": "hash_beta",
	"timestamp": "2026-04-29T10:01:00Z",
}
var verifyOKWire = map[string]interface{}{
	"verified": true, "outcome": "verified",
	"permit_hash": "permit_alpha", "timestamp": "2026-04-29T10:00:01Z",
}
var verifyRevokedWire = map[string]interface{}{
	"verified": false, "outcome": "revoked",
	"permit_hash": "permit_alpha", "timestamp": "2026-04-29T10:00:01Z",
}

// ── Protect ───────────────────────────────────────────────────────────────────

func TestProtect_AllowAndVerified(t *testing.T) {
	srv := mockSeq(t, []map[string]interface{}{allowWire, verifyOKWire})
	defer srv.Close()
	c := newProtectClient(t, srv)

	permit, err := c.Protect(context.Background(), atlasent.ProtectRequest{
		Agent: "deploy-bot", Action: "deploy_to_production",
	})
	if err != nil {
		t.Fatalf("Protect: %v", err)
	}
	if permit.PermitID != "dec_alpha" {
		t.Errorf("PermitID: got %q, want dec_alpha", permit.PermitID)
	}
	if permit.PermitHash != "permit_alpha" {
		t.Errorf("PermitHash: got %q, want permit_alpha", permit.PermitHash)
	}
	if permit.AuditHash != "hash_alpha" {
		t.Errorf("AuditHash: got %q, want hash_alpha", permit.AuditHash)
	}
}

func TestProtect_DenyReturnsDeniedError(t *testing.T) {
	srv := mockSeq(t, []map[string]interface{}{denyWire})
	defer srv.Close()
	c := newProtectClient(t, srv)

	_, err := c.Protect(context.Background(), atlasent.ProtectRequest{Agent: "a", Action: "b"})
	if err == nil {
		t.Fatal("expected error on DENY")
	}
	var denied *atlasent.DeniedError
	if !errors.As(err, &denied) {
		t.Fatalf("expected *DeniedError, got %T: %v", err, err)
	}
	if denied.Decision != "DENY" {
		t.Errorf("Decision: got %q, want DENY", denied.Decision)
	}
	if denied.EvaluationID != "dec_beta" {
		t.Errorf("EvaluationID: got %q, want dec_beta", denied.EvaluationID)
	}
}

func TestProtect_VerifyFailedReturnsDeniedError(t *testing.T) {
	srv := mockSeq(t, []map[string]interface{}{allowWire, verifyRevokedWire})
	defer srv.Close()
	c := newProtectClient(t, srv)

	_, err := c.Protect(context.Background(), atlasent.ProtectRequest{Agent: "a", Action: "b"})
	if err == nil {
		t.Fatal("expected error on revoked permit")
	}
	var denied *atlasent.DeniedError
	if !errors.As(err, &denied) {
		t.Fatalf("expected *DeniedError, got %T: %v", err, err)
	}
	if denied.Decision != "verify_failed" {
		t.Errorf("Decision: got %q, want verify_failed", denied.Decision)
	}
	if denied.EvaluationID != "dec_alpha" {
		t.Errorf("EvaluationID: got %q", denied.EvaluationID)
	}
}

func TestProtect_TransportErrorIsAtlaSentError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	c := newProtectClient(t, srv)

	_, err := c.Protect(context.Background(), atlasent.ProtectRequest{Agent: "a", Action: "b"})
	if err == nil {
		t.Fatal("expected error")
	}
	var aerr *atlasent.AtlaSentError
	if !errors.As(err, &aerr) {
		t.Fatalf("expected *AtlaSentError, got %T", err)
	}
	var denied *atlasent.DeniedError
	if errors.As(err, &denied) {
		t.Error("transport error must NOT be DeniedError")
	}
}

func TestProtect_ContextForwardedToVerify(t *testing.T) {
	var evalBody, verifyBody map[string]interface{}
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := make([]byte, 4096)
		n, _ := r.Body.Read(raw)
		w.Header().Set("Content-Type", "application/json")
		if callCount == 0 {
			_ = json.Unmarshal(raw[:n], &evalBody)
			_ = json.NewEncoder(w).Encode(allowWire)
		} else {
			_ = json.Unmarshal(raw[:n], &verifyBody)
			_ = json.NewEncoder(w).Encode(verifyOKWire)
		}
		callCount++
	}))
	defer srv.Close()
	c := newProtectClient(t, srv)

	ctx := map[string]interface{}{"commit": "abc123"}
	_, err := c.Protect(context.Background(), atlasent.ProtectRequest{
		Agent: "bot", Action: "deploy", Context: ctx,
	})
	if err != nil {
		t.Fatalf("Protect: %v", err)
	}
	if evalBody["context"] == nil {
		t.Error("context not forwarded to evaluate")
	}
	if verifyBody["context"] == nil {
		t.Error("context not forwarded to verifyPermit")
	}
	if verifyBody["decision_id"] != "dec_alpha" {
		t.Errorf("decision_id not forwarded to verifyPermit: got %v", verifyBody["decision_id"])
	}
}

// ── Guard middleware ──────────────────────────────────────────────────────────

func TestGuard_AllowPassesThrough(t *testing.T) {
	apiSrv := mockSeq(t, []map[string]interface{}{allowWire, verifyOKWire})
	defer apiSrv.Close()
	c := newProtectClient(t, apiSrv)

	handlerCalled := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
		permit := atlasent.PermitFromContext(r.Context())
		if permit == nil {
			t.Error("permit not in context")
		} else if permit.PermitID != "dec_alpha" {
			t.Errorf("PermitID: got %q", permit.PermitID)
		}
		w.WriteHeader(http.StatusOK)
	})

	mw := c.Guard(atlasent.GuardOptions{
		Agent:  "bot",
		Action: "deploy",
	})(handler)

	req := httptest.NewRequest(http.MethodPost, "/deploy", nil)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if !handlerCalled {
		t.Error("inner handler not called on ALLOW")
	}
	if rec.Code != http.StatusOK {
		t.Errorf("status: got %d, want 200", rec.Code)
	}
}

func TestGuard_DenyReturns403(t *testing.T) {
	apiSrv := mockSeq(t, []map[string]interface{}{denyWire})
	defer apiSrv.Close()
	c := newProtectClient(t, apiSrv)

	handlerCalled := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
	})

	mw := c.Guard(atlasent.GuardOptions{Agent: "bot", Action: "deploy"})(handler)

	req := httptest.NewRequest(http.MethodPost, "/deploy", nil)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if handlerCalled {
		t.Error("inner handler must not be called on DENY")
	}
	if rec.Code != http.StatusForbidden {
		t.Errorf("status: got %d, want 403", rec.Code)
	}
}

func TestGuard_GetAgentAndActionOverride(t *testing.T) {
	var capturedBody map[string]interface{}
	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := make([]byte, 4096)
		n, _ := r.Body.Read(raw)
		if capturedBody == nil {
			_ = json.Unmarshal(raw[:n], &capturedBody)
			_ = json.NewEncoder(w).Encode(allowWire)
		} else {
			_ = json.NewEncoder(w).Encode(verifyOKWire)
		}
		w.Header().Set("Content-Type", "application/json")
	}))
	defer apiSrv.Close()
	c := newProtectClient(t, apiSrv)

	mw := c.Guard(atlasent.GuardOptions{
		GetAgent:  func(r *http.Request) string { return r.Header.Get("X-Agent") },
		GetAction: func(r *http.Request) string { return "custom_action" },
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("X-Agent", "request-agent")
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if capturedBody["agent"] != "request-agent" {
		t.Errorf("agent: got %v, want request-agent", capturedBody["agent"])
	}
	if capturedBody["action"] != "custom_action" {
		t.Errorf("action: got %v, want custom_action", capturedBody["action"])
	}
}

func TestGuard_TransportErrorReturns503(t *testing.T) {
	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer apiSrv.Close()
	c := newProtectClient(t, apiSrv)

	handlerCalled := false
	mw := c.Guard(atlasent.GuardOptions{Agent: "bot", Action: "x"})(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handlerCalled = true }),
	)

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	if handlerCalled {
		t.Error("inner handler must not be called on error")
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status: got %d, want 503", rec.Code)
	}
}

func TestPermitFromContext_NilWhenMissing(t *testing.T) {
	permit := atlasent.PermitFromContext(context.Background())
	if permit != nil {
		t.Errorf("expected nil, got %+v", permit)
	}
}

func TestDeniedError_ImplementsAtlaSentError(t *testing.T) {
	srv := mockSeq(t, []map[string]interface{}{denyWire})
	defer srv.Close()
	c := newProtectClient(t, srv)

	_, err := c.Protect(context.Background(), atlasent.ProtectRequest{Agent: "a", Action: "b"})
	var aerr *atlasent.AtlaSentError
	if !errors.As(err, &aerr) {
		t.Error("DeniedError must satisfy errors.As(*AtlaSentError)")
	}
}
