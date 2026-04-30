package atlasent_test

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	atlasent "github.com/atlasent-systems-inc/atlasent-sdk/go"
)

// repoRoot walks up from the test file to the repository root.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Join(filepath.Dir(file), "..")
}

func readVectors(t *testing.T, name string) []map[string]interface{} {
	t.Helper()
	path := filepath.Join(repoRoot(t), "contract", "vectors", name)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read vectors %s: %v", name, err)
	}
	var doc struct {
		Vectors []map[string]interface{} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse vectors %s: %v", name, err)
	}
	return doc.Vectors
}

func newClientAgainst(t *testing.T, srv *httptest.Server) *atlasent.Client {
	t.Helper()
	c, err := atlasent.New(atlasent.Options{
		APIKey:      "ask_live_test_key",
		BaseURL:     srv.URL,
		HTTPClient:  &http.Client{Timeout: 5 * time.Second},
		RetryPolicy: atlasent.RetryPolicy{MaxAttempts: 1}, // disable retries in contract tests
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

// ── evaluate vectors ──────────────────────────────────────────────────────────

func TestEvaluateContractVectors(t *testing.T) {
	vectors := readVectors(t, "evaluate.json")

	for _, v := range vectors {
		name := v["name"].(string)
		t.Run(name, func(t *testing.T) {
			sdkInput := v["sdk_input"].(map[string]interface{})
			wireReq := v["wire_request"].(map[string]interface{})
			wireResp := v["wire_response"].(map[string]interface{})
			sdkOut, _ := v["sdk_output"].(map[string]interface{})
			sdkErr, _ := v["sdk_error"].(map[string]interface{})

			var capturedBody map[string]interface{}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				_ = json.Unmarshal(raw, &capturedBody)
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(wireResp)
			}))
			defer srv.Close()

			client := newClientAgainst(t, srv)

			req := atlasent.EvaluateRequest{
				Agent:  sdkInput["agent"].(string),
				Action: sdkInput["action"].(string),
			}
			if ctx, ok := sdkInput["context"]; ok {
				req.Context = ctx.(map[string]interface{})
			}

			resp, err := client.Evaluate(context.Background(), req)

			// wire_request assertions (always checked)
			for k, want := range wireReq {
				got := capturedBody[k]
				wantJSON, _ := json.Marshal(want)
				gotJSON, _ := json.Marshal(got)
				if string(wantJSON) != string(gotJSON) {
					t.Errorf("wire_request[%q]: got %s, want %s", k, gotJSON, wantJSON)
				}
			}

			if sdkErr != nil {
				// error vector: expect an error
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				aerr, ok := err.(*atlasent.AtlaSentError)
				if !ok {
					t.Fatalf("expected *AtlaSentError, got %T: %v", err, err)
				}
				wantKind := sdkErr["kind"].(string)
				if string(aerr.Code) != wantKind {
					t.Errorf("Code: got %q, want %q", aerr.Code, wantKind)
				}
				if wantMsg, ok := sdkErr["message_contains"].(string); ok {
					if !strings.Contains(aerr.Message, wantMsg) {
						t.Errorf("Message %q does not contain %q", aerr.Message, wantMsg)
					}
				}
				return
			}

			// success vector
			if err != nil {
				t.Fatalf("Evaluate: %v", err)
			}

			// sdk_output assertions
			wantDecision := sdkOut["decision"].(string)
			if resp.Decision != wantDecision {
				t.Errorf("Decision: got %q, want %q", resp.Decision, wantDecision)
			}
			wantPermitID := sdkOut["permit_id"].(string)
			if resp.PermitID != wantPermitID {
				t.Errorf("PermitID: got %q, want %q", resp.PermitID, wantPermitID)
			}
		})
	}
}

// ── verify vectors ────────────────────────────────────────────────────────────

func TestVerifyPermitContractVectors(t *testing.T) {
	vectors := readVectors(t, "verify.json")

	for _, v := range vectors {
		name := v["name"].(string)
		t.Run(name, func(t *testing.T) {
			sdkInput := v["sdk_input"].(map[string]interface{})
			wireReq := v["wire_request"].(map[string]interface{})
			wireResp := v["wire_response"].(map[string]interface{})
			sdkOut, _ := v["sdk_output"].(map[string]interface{})
			sdkErr, _ := v["sdk_error"].(map[string]interface{})

			var capturedBody map[string]interface{}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				_ = json.Unmarshal(raw, &capturedBody)
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(wireResp)
			}))
			defer srv.Close()

			client := newClientAgainst(t, srv)

			req := atlasent.VerifyPermitRequest{
				PermitID: sdkInput["permit_id"].(string),
			}
			if a, ok := sdkInput["action"]; ok {
				req.Action = a.(string)
			}
			if ag, ok := sdkInput["agent"]; ok {
				req.Agent = ag.(string)
			}
			if ctx, ok := sdkInput["context"]; ok {
				req.Context = ctx.(map[string]interface{})
			}

			resp, err := client.VerifyPermit(context.Background(), req)

			// wire_request assertions (always checked)
			for k, want := range wireReq {
				got := capturedBody[k]
				wantJSON, _ := json.Marshal(want)
				gotJSON, _ := json.Marshal(got)
				if string(wantJSON) != string(gotJSON) {
					t.Errorf("wire_request[%q]: got %s, want %s", k, gotJSON, wantJSON)
				}
			}

			if sdkErr != nil {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				aerr, ok := err.(*atlasent.AtlaSentError)
				if !ok {
					t.Fatalf("expected *AtlaSentError, got %T: %v", err, err)
				}
				wantKind := sdkErr["kind"].(string)
				if string(aerr.Code) != wantKind {
					t.Errorf("Code: got %q, want %q", aerr.Code, wantKind)
				}
				if wantMsg, ok := sdkErr["message_contains"].(string); ok {
					if !strings.Contains(aerr.Message, wantMsg) {
						t.Errorf("Message %q does not contain %q", aerr.Message, wantMsg)
					}
				}
				return
			}

			if err != nil {
				t.Fatalf("VerifyPermit: %v", err)
			}

			// sdk_output assertions
			wantVerified := sdkOut["verified"].(bool)
			if resp.Verified != wantVerified {
				t.Errorf("Verified: got %v, want %v", resp.Verified, wantVerified)
			}
		})
	}
}

// ── error vectors ─────────────────────────────────────────────────────────────

func TestErrorVectors(t *testing.T) {
	vectors := readVectors(t, "errors.json")

	for _, v := range vectors {
		name := v["name"].(string)
		t.Run(name, func(t *testing.T) {
			sdkErr := v["sdk_error"].(map[string]interface{})
			wantKind := sdkErr["kind"].(string)

			transport, hasTransport := v["transport"].(string)

			var srv *httptest.Server
			var timeoutBaseURL string
			if hasTransport && transport == "timeout" {
				// Raw TCP listener: accepts the connection but never replies.
				// httptest.Server is NOT used so we avoid its drain-wait in Close.
				ln, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatalf("listen: %v", err)
				}
				go func() {
					for {
						conn, err := ln.Accept()
						if err != nil {
							return
						}
						// hold the connection open until the listener closes
						go func(c net.Conn) { defer c.Close(); io.ReadAll(c) }(conn)
					}
				}()
				t.Cleanup(func() { ln.Close() })
				timeoutBaseURL = "http://" + ln.Addr().String()
			} else if hasTransport {
				// Simulate connection-level failure by closing immediately
				srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					hj, ok := w.(http.Hijacker)
					if !ok {
						return
					}
					conn, _, _ := hj.Hijack()
					conn.Close()
				}))
			} else {
				httpStatus := int(v["http_status"].(float64))
				respBody := v["response_body"]
				respHeaders, _ := v["response_headers"].(map[string]interface{})

				srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					for k, val := range respHeaders {
						w.Header().Set(k, val.(string))
					}
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(httpStatus)
					switch rb := respBody.(type) {
					case map[string]interface{}:
						_ = json.NewEncoder(w).Encode(rb)
					case string:
						_, _ = w.Write([]byte(rb))
					}
				}))
			}
			if srv != nil {
				defer srv.Close()
			}

			baseURL := timeoutBaseURL
			if srv != nil {
				baseURL = srv.URL
			}

			c, _ := atlasent.New(atlasent.Options{
				APIKey:      "ask_live_test_key",
				BaseURL:     baseURL,
				HTTPClient:  &http.Client{Timeout: 5 * time.Second},
				RetryPolicy: atlasent.RetryPolicy{MaxAttempts: 1},
			})

			// For timeout vectors, use a short context deadline so ctx.Err() is set.
			evalCtx := context.Background()
			if hasTransport && transport == "timeout" {
				var cancel context.CancelFunc
				evalCtx, cancel = context.WithTimeout(evalCtx, 1*time.Millisecond)
				defer cancel()
			}

			_, err := c.Evaluate(evalCtx, atlasent.EvaluateRequest{
				Agent: "test-agent", Action: "test-action",
			})
			if err == nil {
				t.Fatal("expected error, got nil")
			}

			aerr, ok := err.(*atlasent.AtlaSentError)
			if !ok {
				t.Fatalf("expected *AtlaSentError, got %T: %v", err, err)
			}
			if string(aerr.Code) != wantKind {
				t.Errorf("Code: got %q, want %q", aerr.Code, wantKind)
			}
			if wantStatus, ok := sdkErr["status"].(float64); ok {
				if aerr.Status != int(wantStatus) {
					t.Errorf("Status: got %d, want %d", aerr.Status, int(wantStatus))
				}
			}
			if wantMsg, ok := sdkErr["message_contains"].(string); ok {
				if !strings.Contains(aerr.Message, wantMsg) {
					t.Errorf("Message %q does not contain %q", aerr.Message, wantMsg)
				}
			}
			if wantRetry, ok := sdkErr["retry_after_seconds"].(float64); ok {
				if aerr.RetryAfter == nil {
					t.Error("expected RetryAfter to be set")
				} else {
					gotSecs := aerr.RetryAfter.Seconds()
					if gotSecs != wantRetry {
						t.Errorf("RetryAfter: got %.0fs, want %.0fs", gotSecs, wantRetry)
					}
				}
			}
		})
	}
}

// ── constructor ───────────────────────────────────────────────────────────────

func TestNewRequiresAPIKey(t *testing.T) {
	_, err := atlasent.New(atlasent.Options{})
	if err == nil {
		t.Fatal("expected error for empty APIKey")
	}
	aerr, ok := err.(*atlasent.AtlaSentError)
	if !ok || aerr.Code != atlasent.CodeInvalidAPIKey {
		t.Errorf("expected CodeInvalidAPIKey, got %v", err)
	}
}

func TestNewStripsTrailingSlashes(t *testing.T) {
	var capturedURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedURL = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"permitted":true,"decision_id":"dec1"}`))
	}))
	defer srv.Close()

	c, _ := atlasent.New(atlasent.Options{
		APIKey:     "ask_test",
		BaseURL:    srv.URL + "///",
		HTTPClient: &http.Client{Timeout: 5 * time.Second},
	})
	_, _ = c.Evaluate(context.Background(), atlasent.EvaluateRequest{Agent: "a", Action: "b"})
	if capturedURL != "/v1-evaluate" {
		t.Errorf("URL path: got %q, want /v1-evaluate", capturedURL)
	}
}

// ── headers ───────────────────────────────────────────────────────────────────

func TestRequestHeaders(t *testing.T) {
	var gotAuth, gotAccept, gotContentType, gotUA, gotRequestID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAccept = r.Header.Get("Accept")
		gotContentType = r.Header.Get("Content-Type")
		gotUA = r.Header.Get("User-Agent")
		gotRequestID = r.Header.Get("X-Request-ID")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"permitted":true,"decision_id":"dec1"}`))
	}))
	defer srv.Close()

	c, _ := atlasent.New(atlasent.Options{
		APIKey:     "ask_test_key",
		BaseURL:    srv.URL,
		HTTPClient: &http.Client{Timeout: 5 * time.Second},
	})
	_, _ = c.Evaluate(context.Background(), atlasent.EvaluateRequest{Agent: "a", Action: "b"})

	if gotAuth != "Bearer ask_test_key" {
		t.Errorf("Authorization: got %q", gotAuth)
	}
	if gotAccept != "application/json" {
		t.Errorf("Accept: got %q", gotAccept)
	}
	if gotContentType != "application/json" {
		t.Errorf("Content-Type: got %q", gotContentType)
	}
	if !strings.HasPrefix(gotUA, "atlasent-go/") {
		t.Errorf("User-Agent: got %q", gotUA)
	}
	if len(gotRequestID) == 0 {
		t.Error("X-Request-ID: missing")
	}
}

func TestRequestIDIsFreshPerRequest(t *testing.T) {
	var ids []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ids = append(ids, r.Header.Get("X-Request-ID"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"permitted":true,"decision_id":"dec1"}`))
	}))
	defer srv.Close()

	c, _ := atlasent.New(atlasent.Options{
		APIKey:     "ask_test",
		BaseURL:    srv.URL,
		HTTPClient: &http.Client{Timeout: 5 * time.Second},
	})
	for range 3 {
		_, _ = c.Evaluate(context.Background(), atlasent.EvaluateRequest{Agent: "a", Action: "b"})
	}
	if ids[0] == ids[1] || ids[1] == ids[2] {
		t.Errorf("X-Request-ID not unique across requests: %v", ids)
	}
}

// ── deny as data ──────────────────────────────────────────────────────────────

func TestEvaluateDenyIsNotAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"permitted":false,"decision_id":"dec_deny_001","reason":"policy deny"}`))
	}))
	defer srv.Close()

	c, _ := atlasent.New(atlasent.Options{
		APIKey:     "ask_test",
		BaseURL:    srv.URL,
		HTTPClient: &http.Client{Timeout: 5 * time.Second},
	})
	resp, err := c.Evaluate(context.Background(), atlasent.EvaluateRequest{Agent: "a", Action: "b"})
	if err != nil {
		t.Fatalf("Evaluate returned error for DENY: %v", err)
	}
	if resp.Permitted {
		t.Error("expected Permitted=false")
	}
	if resp.Decision != "DENY" {
		t.Errorf("Decision: got %q, want DENY", resp.Decision)
	}
}
