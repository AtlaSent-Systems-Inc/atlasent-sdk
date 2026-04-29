// Package atlasent provides a Go client for the AtlaSent authorization API.
//
// Quick start:
//
//	client, err := atlasent.New(atlasent.Options{APIKey: os.Getenv("ATLASENT_API_KEY")})
//	if err != nil {
//	    log.Fatal(err)
//	}
//
//	resp, err := client.Evaluate(ctx, atlasent.EvaluateRequest{
//	    Agent:  "user:123",
//	    Action: "read_patient_record",
//	})
//	if err != nil {
//	    // transport / auth / server error
//	    log.Fatal(err)
//	}
//	if !resp.Permitted {
//	    // clean policy DENY — not an error
//	    http.Error(w, "forbidden", http.StatusForbidden)
//	    return
//	}
package atlasent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	defaultBaseURL   = "https://api.atlasent.io"
	defaultTimeoutMs = 10_000
	sdkVersion       = "1.0.0"
)

// HTTPDoer is satisfied by *http.Client and allows injection in tests.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// Options configures a Client.
type Options struct {
	APIKey    string
	BaseURL   string        // defaults to https://api.atlasent.io
	Timeout   time.Duration // defaults to 10s
	HTTPClient HTTPDoer     // defaults to a stock *http.Client
}

// Client is a thread-safe AtlaSent API client.
type Client struct {
	apiKey  string
	baseURL string
	http    HTTPDoer
}

// New creates a Client. Returns an error if APIKey is empty.
func New(opts Options) (*Client, error) {
	if opts.APIKey == "" {
		return nil, &AtlaSentError{Code: CodeInvalidAPIKey, Message: "APIKey is required"}
	}
	baseURL := strings.TrimRight(opts.BaseURL, "/")
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = time.Duration(defaultTimeoutMs) * time.Millisecond
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: timeout}
	}
	return &Client{apiKey: opts.APIKey, baseURL: baseURL, http: httpClient}, nil
}

// Evaluate asks the policy engine whether an agent action is permitted.
// A DENY response is returned as data (resp.Permitted == false), not an error.
func (c *Client) Evaluate(ctx context.Context, req EvaluateRequest) (*EvaluateResponse, error) {
	reqCtx := req.Context
	if reqCtx == nil {
		reqCtx = map[string]interface{}{}
	}
	wireReq := map[string]interface{}{
		"action":  req.Action,
		"agent":   req.Agent,
		"context": reqCtx,
		"api_key": c.apiKey,
	}

	var wire struct {
		Permitted  *bool  `json:"permitted"`
		DecisionID string `json:"decision_id"`
		Reason     string `json:"reason"`
		AuditHash  string `json:"audit_hash"`
		Timestamp  string `json:"timestamp"`
	}
	rl, err := c.post(ctx, "/v1-evaluate", wireReq, &wire)
	if err != nil {
		return nil, err
	}
	if wire.Permitted == nil || wire.DecisionID == "" {
		return nil, &AtlaSentError{
			Code:    CodeBadResponse,
			Message: "malformed response from /v1-evaluate: missing permitted or decision_id",
		}
	}

	decision := "DENY"
	if *wire.Permitted {
		decision = "ALLOW"
	}
	return &EvaluateResponse{
		Decision:  decision,
		Permitted: *wire.Permitted,
		PermitID:  wire.DecisionID,
		Reason:    wire.Reason,
		AuditHash: wire.AuditHash,
		Timestamp: wire.Timestamp,
		RateLimit: rl,
	}, nil
}

// VerifyPermit verifies that a previously-issued permit is still valid.
// A Verified == false response is returned as data, not an error.
func (c *Client) VerifyPermit(ctx context.Context, req VerifyPermitRequest) (*VerifyPermitResponse, error) {
	vctx := req.Context
	if vctx == nil {
		vctx = map[string]interface{}{}
	}
	wireReq := map[string]interface{}{
		"decision_id": req.PermitID,
		"action":      req.Action,
		"agent":       req.Agent,
		"context":     vctx,
		"api_key":     c.apiKey,
	}

	var wire struct {
		Verified   *bool  `json:"verified"`
		Outcome    string `json:"outcome"`
		PermitHash string `json:"permit_hash"`
		Timestamp  string `json:"timestamp"`
	}
	rl, err := c.post(ctx, "/v1-verify-permit", wireReq, &wire)
	if err != nil {
		return nil, err
	}
	if wire.Verified == nil {
		return nil, &AtlaSentError{
			Code:    CodeBadResponse,
			Message: "malformed response from /v1-verify-permit: missing verified field",
		}
	}
	return &VerifyPermitResponse{
		Verified:   *wire.Verified,
		Outcome:    wire.Outcome,
		PermitHash: wire.PermitHash,
		Timestamp:  wire.Timestamp,
		RateLimit:  rl,
	}, nil
}

// ── internal ──────────────────────────────────────────────────────────────────

func (c *Client) post(ctx context.Context, path string, body interface{}, dest interface{}) (*RateLimitState, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, &AtlaSentError{Code: CodeBadRequest, Message: fmt.Sprintf("failed to marshal request: %v", err)}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(b))
	if err != nil {
		return nil, &AtlaSentError{Code: CodeNetwork, Message: fmt.Sprintf("failed to build request: %v", err)}
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", fmt.Sprintf("atlasent-go/%s go/runtime", sdkVersion))
	req.Header.Set("X-Request-ID", uuid.NewString()[:12])

	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, &AtlaSentError{Code: CodeTimeout, Message: "request to AtlaSent API timed out"}
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return nil, &AtlaSentError{Code: CodeTimeout, Message: "request to AtlaSent API timed out"}
		}
		return nil, &AtlaSentError{Code: CodeNetwork, Message: fmt.Sprintf("network error: %v", err)}
	}
	defer resp.Body.Close()

	rl := parseRateLimitHeaders(resp.Header)

	if resp.StatusCode >= 400 {
		return nil, buildHTTPError(resp)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return rl, &AtlaSentError{Code: CodeBadResponse, Message: fmt.Sprintf("failed to read response: %v", err)}
	}
	if err := json.Unmarshal(raw, dest); err != nil {
		return rl, &AtlaSentError{Code: CodeBadResponse, Message: fmt.Sprintf("invalid JSON from AtlaSent API: %v", err)}
	}
	return rl, nil
}

func buildHTTPError(resp *http.Response) *AtlaSentError {
	status := resp.StatusCode
	msg := readServerMessage(resp.Body)

	var code ErrorCode
	switch {
	case status == 401:
		code = CodeInvalidAPIKey
		if msg == "" {
			msg = "Invalid API key"
		}
	case status == 403:
		code = CodeForbidden
		if msg == "" {
			msg = "Access forbidden"
		}
	case status == 429:
		aerr := &AtlaSentError{Code: CodeRateLimited, Status: status, Message: msg}
		if ra := parseRetryAfter(resp.Header.Get("Retry-After")); ra > 0 {
			aerr.RetryAfter = &ra
		}
		return aerr
	case status >= 500:
		code = CodeServerError
		if msg == "" {
			msg = fmt.Sprintf("AtlaSent API returned HTTP %d", status)
		}
	default:
		code = CodeBadRequest
		if msg == "" {
			msg = fmt.Sprintf("AtlaSent API returned HTTP %d", status)
		}
	}
	return &AtlaSentError{Code: code, Status: status, Message: msg}
}

func readServerMessage(body io.Reader) string {
	raw, err := io.ReadAll(body)
	if err != nil || len(raw) == 0 {
		return ""
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(raw, &parsed); err == nil {
		if msg, ok := parsed["message"].(string); ok && msg != "" {
			return msg
		}
		if reason, ok := parsed["reason"].(string); ok && reason != "" {
			return reason
		}
	}
	if len(raw) > 500 {
		return string(raw[:500]) + "…"
	}
	return string(raw)
}

func parseRateLimitHeaders(h http.Header) *RateLimitState {
	limitStr := h.Get("X-RateLimit-Limit")
	remainingStr := h.Get("X-RateLimit-Remaining")
	resetStr := h.Get("X-RateLimit-Reset")
	if limitStr == "" || remainingStr == "" || resetStr == "" {
		return nil
	}
	limit, err1 := strconv.Atoi(limitStr)
	remaining, err2 := strconv.Atoi(remainingStr)
	reset, err3 := strconv.ParseInt(resetStr, 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return nil
	}
	return &RateLimitState{Limit: limit, Remaining: remaining, ResetAt: reset}
}

func parseRetryAfter(raw string) time.Duration {
	if raw == "" {
		return 0
	}
	if secs, err := strconv.ParseFloat(raw, 64); err == nil {
		return time.Duration(secs * float64(time.Second))
	}
	if t, err := http.ParseTime(raw); err == nil {
		d := time.Until(t)
		if d < 0 {
			return 0
		}
		return d
	}
	return 0
}
