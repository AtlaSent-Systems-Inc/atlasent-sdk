package atlasent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Sentinel errors returned by Client methods. Callers branch on
// these via errors.Is so wrapped errors keep their cause-chain
// intact:
//
//	switch {
//	case errors.Is(err, ErrUnauthorized):
//	    // …
//	case errors.Is(err, ErrRateLimited):
//	    // …
//	}
//
// ErrTransport surfaces network / timeout / connection failures;
// fail-closed callers should treat it identically to a hard deny.
var (
	ErrUnauthorized = errors.New("atlasent: unauthorized (401)")
	ErrForbidden    = errors.New("atlasent: forbidden (403)")
	ErrRateLimited  = errors.New("atlasent: rate limited (429)")
	ErrServer       = errors.New("atlasent: server error (5xx)")
	ErrBadRequest   = errors.New("atlasent: bad request (4xx)")
	ErrTransport    = errors.New("atlasent: transport error")
)

// HTTPError carries the HTTP status and any server-emitted message
// alongside one of the sentinel errors above. Use errors.Is to
// classify; use errors.As to read the status / body for logging.
//
//	var herr *HTTPError
//	if errors.As(err, &herr) {
//	    log.Printf("atlasent http %d: %s", herr.Status, herr.Body)
//	}
type HTTPError struct {
	Status     int
	Body       string
	Sentinel   error
	RetryAfter time.Duration // populated for 429 when the server emits Retry-After
}

func (e *HTTPError) Error() string {
	if e.Body == "" {
		return e.Sentinel.Error()
	}
	return fmt.Sprintf("%s: %s", e.Sentinel.Error(), truncate(e.Body, 200))
}

func (e *HTTPError) Unwrap() error { return e.Sentinel }

// TransportError wraps a network / timeout / connection failure so
// callers can distinguish "the request never reached AtlaSent" from
// "AtlaSent answered with an error". Mirrors atlasent-action's
// fail-closed discipline: transport errors block; they do not allow.
type TransportError struct {
	Cause error
}

func (e *TransportError) Error() string {
	return fmt.Sprintf("%s: %v", ErrTransport.Error(), e.Cause)
}

func (e *TransportError) Unwrap() error { return e.Cause }

// Is supports `errors.Is(err, ErrTransport)` so callers can branch on
// the family without unwrapping all the way to net.OpError.
func (e *TransportError) Is(target error) bool {
	return target == ErrTransport
}

// Client is the AtlaSent HTTP client. Construct with NewClient; all
// fields are unexported so options can only be set through the
// functional-option helpers below.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
	userAgent  string
}

// ClientOption configures a Client. Use the With* helpers below.
type ClientOption func(*Client)

// WithHTTPClient injects a custom *http.Client (e.g. one with a
// configured Transport for proxies, mTLS, retries, etc.). Default is
// a fresh http.Client with a 10-second total timeout.
func WithHTTPClient(c *http.Client) ClientOption {
	return func(cl *Client) { cl.httpClient = c }
}

// WithUserAgent overrides the default User-Agent header.
func WithUserAgent(ua string) ClientOption {
	return func(cl *Client) { cl.userAgent = ua }
}

// NewClient builds a Client targeting baseURL (e.g.
// "https://api.atlasent.io") authenticated with apiKey. The default
// http.Client has a 10-second total timeout; pass WithHTTPClient to
// override.
//
// baseURL may include or omit a trailing slash; either way the
// resolved URLs hit /v1/<path>.
func NewClient(baseURL, apiKey string, opts ...ClientOption) *Client {
	c := &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiKey:     apiKey,
		httpClient: &http.Client{Timeout: 10 * time.Second},
		userAgent:  "atlasent-go/1.0.0",
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// Evaluate posts to /v1/evaluate and decodes the response.
//
// Errors:
//
//   - context errors (deadline exceeded, canceled) are returned as-is
//     so callers can branch with errors.Is(err, context.Canceled).
//   - network / DNS / timeout errors return *TransportError wrapping
//     the cause; matches errors.Is(err, ErrTransport).
//   - HTTP 4xx / 5xx return *HTTPError carrying the status + body and
//     wrapping one of the sentinel errors (ErrUnauthorized,
//     ErrRateLimited, ErrServer, ErrBadRequest, ErrForbidden).
//   - JSON decode failures return a plain error with the body for
//     diagnostics — these indicate a contract drift and should page
//     the SDK owner.
//
// On success the returned *EvaluationResponse is non-nil.
func (c *Client) Evaluate(ctx context.Context, req EvaluationRequest) (*EvaluationResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("atlasent: marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/v1/evaluate", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("atlasent: build request: %w", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("User-Agent", c.userAgent)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		// Surface ctx cancellation directly so callers can branch on it.
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, &TransportError{Cause: err}
	}
	defer resp.Body.Close()

	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, &TransportError{Cause: readErr}
	}

	if resp.StatusCode >= 400 {
		return nil, classifyStatus(resp, respBody)
	}

	var decoded EvaluationResponse
	if err := json.Unmarshal(respBody, &decoded); err != nil {
		return nil, fmt.Errorf(
			"atlasent: decode /v1/evaluate response (status %d): %w; body=%s",
			resp.StatusCode, err, truncate(string(respBody), 200),
		)
	}
	return &decoded, nil
}

func classifyStatus(resp *http.Response, body []byte) error {
	herr := &HTTPError{
		Status: resp.StatusCode,
		Body:   string(body),
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		herr.Sentinel = ErrUnauthorized
	case resp.StatusCode == http.StatusForbidden:
		herr.Sentinel = ErrForbidden
	case resp.StatusCode == http.StatusTooManyRequests:
		herr.Sentinel = ErrRateLimited
		herr.RetryAfter = parseRetryAfter(resp.Header.Get("Retry-After"))
	case resp.StatusCode >= 500:
		herr.Sentinel = ErrServer
	default:
		herr.Sentinel = ErrBadRequest
	}
	return herr
}

func parseRetryAfter(raw string) time.Duration {
	if raw == "" {
		return 0
	}
	// Try integer-seconds first (the common shape for the AtlaSent
	// edge functions).
	var secs int
	if _, err := fmt.Sscanf(raw, "%d", &secs); err == nil && secs >= 0 {
		return time.Duration(secs) * time.Second
	}
	// Fallback: HTTP-date. time.Parse handles RFC1123.
	if t, err := http.ParseTime(raw); err == nil {
		d := time.Until(t)
		if d < 0 {
			return 0
		}
		return d
	}
	return 0
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
