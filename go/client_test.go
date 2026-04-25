package atlasent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ─── Evaluate happy path + error paths ────────────────────────────────

func TestEvaluate_HappyPathAllow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("want POST, got %s", r.Method)
		}
		if r.URL.Path != "/v1/evaluate" {
			t.Errorf("want /v1/evaluate, got %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer k_test" {
			t.Errorf("Authorization header = %q, want Bearer k_test", got)
		}
		body, _ := io.ReadAll(r.Body)
		var req EvaluationRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("server got non-json body: %v (body=%s)", err, body)
		}
		if req.Action.ID != "deploy_to_production" {
			t.Errorf("action.id = %q, want deploy_to_production", req.Action.ID)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"decision": "allow",
			"matched_rule_id": "rule_42",
			"risk": {"level": "low", "score": 5, "reasons": []},
			"permit": {
				"id": "p_1",
				"org_id": "org_123",
				"actor_id": "agent.deploy-bot",
				"action_id": "deploy_to_production",
				"status": "issued",
				"issued_at": "2026-04-25T00:00:00Z",
				"expires_at": "2026-04-25T00:15:00Z",
				"signature": "sig"
			},
			"evaluated_at": "2026-04-25T00:00:00Z",
			"evaluation_id": "ev_1"
		}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "k_test")
	resp, err := c.Evaluate(context.Background(), EvaluationRequest{
		Actor:  EvaluationActor{ID: "agent.deploy-bot", Type: "agent", OrgID: "org_123"},
		Action: EvaluationAction{ID: "deploy_to_production"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Decision != DecisionAllow {
		t.Errorf("decision = %q, want allow", resp.Decision)
	}
	if resp.Permit == nil || resp.Permit.ID != "p_1" {
		t.Errorf("permit not surfaced: %+v", resp.Permit)
	}
	if resp.Risk.Level != RiskLevelLow {
		t.Errorf("risk.level = %q, want low", resp.Risk.Level)
	}
}

func TestEvaluate_DenyWithReason(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"decision": "deny",
			"deny_code": "OUT_OF_WINDOW",
			"deny_reason": "deploys are blocked outside the change window",
			"risk": {"level": "high", "score": 80, "reasons": ["out_of_window"]},
			"evaluated_at": "2026-04-25T00:00:00Z",
			"evaluation_id": "ev_2"
		}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "k")
	resp, err := c.Evaluate(context.Background(), EvaluationRequest{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Decision != DecisionDeny {
		t.Errorf("decision = %q, want deny", resp.Decision)
	}
	if resp.DenyCode != "OUT_OF_WINDOW" {
		t.Errorf("deny_code = %q", resp.DenyCode)
	}
	if resp.Permit != nil {
		t.Errorf("permit should be nil on deny, got %+v", resp.Permit)
	}
}

// ─── Typed error classification ───────────────────────────────────────

func TestEvaluate_HTTPErrors(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		sentinel error
	}{
		{"401 → ErrUnauthorized", 401, ErrUnauthorized},
		{"403 → ErrForbidden", 403, ErrForbidden},
		{"429 → ErrRateLimited", 429, ErrRateLimited},
		{"500 → ErrServer", 500, ErrServer},
		{"502 → ErrServer", 502, ErrServer},
		{"400 → ErrBadRequest", 400, ErrBadRequest},
		{"422 → ErrBadRequest", 422, ErrBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(`{"message": "nope"}`))
			}))
			defer srv.Close()

			c := NewClient(srv.URL, "k")
			_, err := c.Evaluate(context.Background(), EvaluationRequest{})
			if err == nil {
				t.Fatalf("want error, got nil")
			}
			if !errors.Is(err, tc.sentinel) {
				t.Errorf("err = %v; want errors.Is(..., %v)", err, tc.sentinel)
			}
			var herr *HTTPError
			if !errors.As(err, &herr) {
				t.Fatalf("err = %v; want *HTTPError via errors.As", err)
			}
			if herr.Status != tc.status {
				t.Errorf("HTTPError.Status = %d, want %d", herr.Status, tc.status)
			}
		})
	}
}

func TestEvaluate_429ParsesRetryAfterSeconds(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "15")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "k")
	_, err := c.Evaluate(context.Background(), EvaluationRequest{})
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v; want ErrRateLimited", err)
	}
	var herr *HTTPError
	if !errors.As(err, &herr) {
		t.Fatalf("want *HTTPError")
	}
	if herr.RetryAfter != 15*time.Second {
		t.Errorf("RetryAfter = %v, want 15s", herr.RetryAfter)
	}
}

func TestEvaluate_429ParsesRetryAfterHTTPDate(t *testing.T) {
	when := time.Now().Add(45 * time.Second).UTC().Format(http.TimeFormat)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", when)
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "k")
	_, err := c.Evaluate(context.Background(), EvaluationRequest{})
	var herr *HTTPError
	if !errors.As(err, &herr) {
		t.Fatalf("want *HTTPError, got %v", err)
	}
	// Allow a wide tolerance — clock skew between Now() calls is fine
	// because the parser uses time.Until.
	if herr.RetryAfter < 30*time.Second || herr.RetryAfter > 60*time.Second {
		t.Errorf("RetryAfter = %v, want ~45s", herr.RetryAfter)
	}
}

func TestEvaluate_429ParsesRetryAfterPastDateAsZero(t *testing.T) {
	when := time.Now().Add(-1 * time.Hour).UTC().Format(http.TimeFormat)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", when)
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "k")
	_, err := c.Evaluate(context.Background(), EvaluationRequest{})
	var herr *HTTPError
	if !errors.As(err, &herr) || herr.RetryAfter != 0 {
		t.Errorf("want RetryAfter=0 on past date, got %v / %v", herr, err)
	}
}

func TestEvaluate_429RetryAfterUnparseableIsZero(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "soon-ish")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "k")
	_, err := c.Evaluate(context.Background(), EvaluationRequest{})
	var herr *HTTPError
	if !errors.As(err, &herr) || herr.RetryAfter != 0 {
		t.Errorf("want RetryAfter=0 on unparseable header, got %v", herr)
	}
}

func TestEvaluate_429EmptyRetryAfterIsZero(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "k")
	_, err := c.Evaluate(context.Background(), EvaluationRequest{})
	var herr *HTTPError
	if !errors.As(err, &herr) || herr.RetryAfter != 0 {
		t.Errorf("want RetryAfter=0 when header absent, got %v", herr)
	}
}

func TestHTTPError_Format(t *testing.T) {
	e := &HTTPError{Status: 500, Body: "boom", Sentinel: ErrServer}
	if !strings.Contains(e.Error(), "boom") {
		t.Errorf("Error() = %q; want body suffix", e.Error())
	}
	empty := &HTTPError{Status: 500, Sentinel: ErrServer}
	if empty.Error() != ErrServer.Error() {
		t.Errorf("empty body Error() = %q; want %q", empty.Error(), ErrServer.Error())
	}
	if !errors.Is(e, ErrServer) {
		t.Errorf("Unwrap broken: errors.Is should find ErrServer")
	}
}

// ─── Transport / context ──────────────────────────────────────────────

func TestEvaluate_TransportErrorBlocks(t *testing.T) {
	// Point at a closed listener so the dial fails synchronously. We
	// can't use httptest here because we need a guaranteed-dead address.
	c := NewClient("http://127.0.0.1:1", "k")
	c.httpClient.Timeout = 200 * time.Millisecond

	_, err := c.Evaluate(context.Background(), EvaluationRequest{})
	if err == nil {
		t.Fatal("want transport error, got nil")
	}
	if !errors.Is(err, ErrTransport) {
		t.Errorf("err = %v; want errors.Is(..., ErrTransport)", err)
	}
	var terr *TransportError
	if !errors.As(err, &terr) {
		t.Errorf("want *TransportError, got %T", err)
	}
	// Error() and Unwrap() round-trip the cause for diagnostics.
	if !strings.Contains(terr.Error(), "transport error") {
		t.Errorf("TransportError.Error() = %q", terr.Error())
	}
	if terr.Unwrap() == nil {
		t.Error("TransportError.Unwrap() returned nil")
	}
}

func TestEvaluate_BadBaseURLFailsBuildRequest(t *testing.T) {
	// http.NewRequestWithContext returns an error for control characters
	// in the URL; this exercises the build-request error path.
	c := NewClient("http://example.com\x7f", "k")
	_, err := c.Evaluate(context.Background(), EvaluationRequest{})
	if err == nil || !strings.Contains(err.Error(), "build request") {
		t.Errorf("want build-request error, got %v", err)
	}
}

func TestEvaluate_TruncatesLongDecodeErrorBody(t *testing.T) {
	long := strings.Repeat("x", 500)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{not json " + long))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "k")
	_, err := c.Evaluate(context.Background(), EvaluationRequest{})
	if err == nil {
		t.Fatal("want decode error")
	}
	if !strings.Contains(err.Error(), "…") {
		t.Errorf("expected truncation marker in: %v", err)
	}
}

func TestEvaluate_ContextCancellationSurfacesCtxErr(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		// Server hangs forever; we cancel client-side.
		time.Sleep(5 * time.Second)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "k")
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	_, err := c.Evaluate(ctx, EvaluationRequest{})
	if err == nil {
		t.Fatal("want context error, got nil")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v; want errors.Is(..., context.Canceled)", err)
	}
}

func TestEvaluate_ContextDeadlineSurfacesCtxErr(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		time.Sleep(5 * time.Second)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "k")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := c.Evaluate(ctx, EvaluationRequest{})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v; want context.DeadlineExceeded", err)
	}
}

// ─── Response decode failures ─────────────────────────────────────────

func TestEvaluate_MalformedJSONSurfacesError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{not json`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "k")
	_, err := c.Evaluate(context.Background(), EvaluationRequest{})
	if err == nil {
		t.Fatal("want decode error, got nil")
	}
	if !strings.Contains(err.Error(), "decode") {
		t.Errorf("err = %v; want 'decode' in message", err)
	}
}

// ─── Constructor + options ────────────────────────────────────────────

func TestNewClient_TrimsTrailingSlash(t *testing.T) {
	c := NewClient("https://api.example.com///", "k")
	if c.baseURL != "https://api.example.com" {
		t.Errorf("baseURL = %q, want trimmed", c.baseURL)
	}
}

func TestWithHTTPClient_Overrides(t *testing.T) {
	custom := &http.Client{Timeout: 99 * time.Second}
	c := NewClient("https://x", "k", WithHTTPClient(custom))
	if c.httpClient != custom {
		t.Error("WithHTTPClient did not install the custom client")
	}
}

func TestWithUserAgent_Overrides(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("User-Agent"); got != "test/9.9" {
			t.Errorf("UA = %q, want test/9.9", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"decision": "deny", "risk": {"level":"low","score":0,"reasons":[]}, "evaluated_at": "", "evaluation_id":""}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "k", WithUserAgent("test/9.9"))
	if _, err := c.Evaluate(context.Background(), EvaluationRequest{}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ─── Wire-shape smoke for SSO + Decision constants ────────────────────

func TestSsoEvent_RoundTrip(t *testing.T) {
	const wire = `{
		"id": "00000000-0000-0000-0000-000000000020",
		"organization_id": "00000000-0000-0000-0000-00000000000a",
		"connection_id": null,
		"event_type": "login_denied",
		"actor_email": null,
		"payload": {"reason": "no JIT rule matched"},
		"occurred_at": "2026-04-24T00:00:00Z"
	}`
	var evt SsoEvent
	if err := json.Unmarshal([]byte(wire), &evt); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if evt.EventType != SsoEventLoginDenied {
		t.Errorf("event_type = %q", evt.EventType)
	}
	if evt.ConnectionID != nil {
		t.Errorf("connection_id should be nil, got %v", *evt.ConnectionID)
	}
	out, err := json.Marshal(&evt)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(out), `"event_type":"login_denied"`) {
		t.Errorf("marshal lost event_type: %s", out)
	}
}

func TestSsoConnection_NullableFields(t *testing.T) {
	const wire = `{
		"id": "c_1",
		"organization_id": "o_1",
		"name": "Acme",
		"protocol": "saml",
		"supabase_provider_id": null,
		"idp_entity_id": "e",
		"metadata_url": "https://example/saml",
		"metadata_xml": null,
		"email_domain": "acme.com",
		"enforce_for_domain": false,
		"is_active": false,
		"created_at": "",
		"updated_at": ""
	}`
	var conn SsoConnection
	if err := json.Unmarshal([]byte(wire), &conn); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if conn.Protocol != SsoProtocolSAML {
		t.Errorf("protocol = %q", conn.Protocol)
	}
	if conn.MetadataURL == nil || *conn.MetadataURL == "" {
		t.Errorf("metadata_url should be set, got %v", conn.MetadataURL)
	}
	if conn.MetadataXML != nil {
		t.Errorf("metadata_xml should be nil, got %v", *conn.MetadataXML)
	}
}

func TestDecisionConstants_MatchWire(t *testing.T) {
	for _, want := range []Decision{
		DecisionAllow, DecisionDeny, DecisionHold, DecisionEscalate,
	} {
		// Round-trip via JSON to confirm the string values match.
		raw, err := json.Marshal(want)
		if err != nil {
			t.Fatalf("marshal %q: %v", want, err)
		}
		// strconv.Unquote handles the surrounding `"` JSON adds.
		got, err := strconv.Unquote(string(raw))
		if err != nil {
			t.Fatalf("unquote %s: %v", raw, err)
		}
		if Decision(got) != want {
			t.Errorf("round-trip lost value: %q → %q", want, got)
		}
	}
}
