// Internal package tests for the retry loop.
// Uses package atlasent (not atlasent_test) so we can override sleep.
package atlasent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// withNoSleep swaps the package-level sleep for a no-op and restores it.
func withNoSleep(t *testing.T) {
	t.Helper()
	prev := sleep
	sleep = func(time.Duration) {}
	t.Cleanup(func() { sleep = prev })
}

func newTestClient(t *testing.T, srv *httptest.Server, policy RetryPolicy) *Client {
	t.Helper()
	c, err := New(Options{
		APIKey:      "ask_test",
		BaseURL:     srv.URL,
		HTTPClient:  &http.Client{Timeout: 5 * time.Second},
		RetryPolicy: policy,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func TestRetry_5xxIsRetried(t *testing.T) {
	withNoSleep(t)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"permitted": true, "decision_id": "dec1",
		})
	}))
	defer srv.Close()

	c := newTestClient(t, srv, RetryPolicy{MaxAttempts: 3, BaseDelay: 1, MaxDelay: 1})
	resp, err := c.Evaluate(context.Background(), EvaluateRequest{Agent: "a", Action: "b"})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if !resp.Permitted {
		t.Error("expected Permitted=true after retries")
	}
	if calls.Load() != 3 {
		t.Errorf("calls: got %d, want 3", calls.Load())
	}
}

func TestRetry_429IsRetried(t *testing.T) {
	withNoSleep(t)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n < 2 {
			w.Header().Set("Retry-After", "0")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"permitted": true, "decision_id": "dec2",
		})
	}))
	defer srv.Close()

	c := newTestClient(t, srv, RetryPolicy{MaxAttempts: 3, BaseDelay: 1, MaxDelay: 1})
	resp, err := c.Evaluate(context.Background(), EvaluateRequest{Agent: "a", Action: "b"})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if !resp.Permitted {
		t.Error("expected Permitted=true after 429 retry")
	}
	if calls.Load() != 2 {
		t.Errorf("calls: got %d, want 2", calls.Load())
	}
}

func TestRetry_401IsNotRetried(t *testing.T) {
	withNoSleep(t)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := newTestClient(t, srv, RetryPolicy{MaxAttempts: 3, BaseDelay: 1, MaxDelay: 1})
	_, err := c.Evaluate(context.Background(), EvaluateRequest{Agent: "a", Action: "b"})
	if err == nil {
		t.Fatal("expected error for 401")
	}
	aerr := err.(*AtlaSentError)
	if aerr.Code != CodeInvalidAPIKey {
		t.Errorf("Code: got %q, want %q", aerr.Code, CodeInvalidAPIKey)
	}
	if calls.Load() != 1 {
		t.Errorf("401 must not be retried — calls: got %d, want 1", calls.Load())
	}
}

func TestRetry_MaxAttemptsExhausted(t *testing.T) {
	withNoSleep(t)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := newTestClient(t, srv, RetryPolicy{MaxAttempts: 3, BaseDelay: 1, MaxDelay: 1})
	_, err := c.Evaluate(context.Background(), EvaluateRequest{Agent: "a", Action: "b"})
	if err == nil {
		t.Fatal("expected error after exhausting retries")
	}
	if calls.Load() != 3 {
		t.Errorf("calls: got %d, want 3", calls.Load())
	}
}

func TestRetry_OnRetryCallbackFired(t *testing.T) {
	withNoSleep(t)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"permitted": true, "decision_id": "dec3",
		})
	}))
	defer srv.Close()

	var retryContexts []OnRetryContext
	c, _ := New(Options{
		APIKey:      "ask_test",
		BaseURL:     srv.URL,
		HTTPClient:  &http.Client{Timeout: 5 * time.Second},
		RetryPolicy: RetryPolicy{MaxAttempts: 3, BaseDelay: 1, MaxDelay: 1},
		OnRetry: func(ctx OnRetryContext) {
			retryContexts = append(retryContexts, ctx)
		},
	})
	_, err := c.Evaluate(context.Background(), EvaluateRequest{Agent: "a", Action: "b"})
	if err != nil {
		t.Fatalf("Evaluate: %v", err)
	}
	if len(retryContexts) != 2 {
		t.Fatalf("OnRetry calls: got %d, want 2", len(retryContexts))
	}
	if retryContexts[0].Attempt != 0 || retryContexts[1].Attempt != 1 {
		t.Errorf("Attempt indices: got %d, %d; want 0, 1",
			retryContexts[0].Attempt, retryContexts[1].Attempt)
	}
	if retryContexts[0].Path != "/v1-evaluate" {
		t.Errorf("Path: got %q, want /v1-evaluate", retryContexts[0].Path)
	}
}

func TestRetry_MaxAttempts1DisablesRetries(t *testing.T) {
	withNoSleep(t)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := newTestClient(t, srv, RetryPolicy{MaxAttempts: 1})
	_, err := c.Evaluate(context.Background(), EvaluateRequest{Agent: "a", Action: "b"})
	if err == nil {
		t.Fatal("expected error")
	}
	if calls.Load() != 1 {
		t.Errorf("MaxAttempts=1 must disable retries — calls: got %d, want 1", calls.Load())
	}
}
