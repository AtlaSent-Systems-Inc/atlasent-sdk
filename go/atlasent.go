// Package atlasent provides the AtlaSent Go SDK — execution-time
// authorization for AI agents.
//
// # Quick start
//
//	client := atlasent.New(atlasent.Options{
//		APIKey:  os.Getenv("ATLASENT_API_KEY"),
//		BaseURL: "https://api.atlasent.io", // optional
//	})
//
//	permit, err := client.Protect(ctx, atlasent.ProtectRequest{
//		Agent:  "deploy-bot",
//		Action: "production.deploy",
//		Context: map[string]any{
//			"environment": "production",
//			"commit":      commitSHA,
//		},
//	})
//	if err != nil {
//		// fail-closed: do not proceed
//		return err
//	}
//	_ = permit // proceed with the action
//
// # Module path
//
// This is a v2 module. Import as:
//
//	github.com/atlasent-systems-inc/atlasent-sdk/go/v2
//
// # Evidence bundles
//
// Create, retrieve, and download compliance evidence bundles:
//
//	bundle, err := client.EvidenceBundles.Create(ctx, atlasent.EvidenceBundleCreateRequest{
//		IncidentID: "inc_abc123",
//	})
//
// # SCIM provisioning
//
// Manage users via the /scim/v2/* endpoints:
//
//	users, err := client.SCIM.Users.List(ctx, atlasent.SCIMListParams{
//		OrgID: "org_xyz",
//	})
//
// # Multi-IdP token refresh
//
// Refresh tokens for a specific IdP connection:
//
//	tokens, err := client.Auth.RefreshWithIdP(ctx, "idp_okta", refreshToken)
package atlasent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const (
	DefaultBaseURL = "https://api.atlasent.io"
	DefaultTimeout = 10 * time.Second
	SDKVersion     = "2.0.0"
)

// Options configures the AtlaSent client.
type Options struct {
	// APIKey is required. Must match ask_(live|test)_<entropy>.
	APIKey string
	// BaseURL overrides the default https://api.atlasent.io.
	BaseURL string
	// Timeout overrides the default 10-second per-request timeout.
	Timeout time.Duration
	// HTTPClient overrides the underlying HTTP client (useful for tests).
	HTTPClient *http.Client
}

// Client is the AtlaSent SDK client. Create via New().
type Client struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client

	// EvidenceBundles provides evidence bundle create/get/download operations.
	EvidenceBundles *EvidenceBundleClient
	// SCIM provides SCIM 2.0 user and group provisioning.
	SCIM *SCIMClient
	// Auth provides token management including multi-IdP refresh.
	Auth *AuthClient
}

// New creates and returns a configured AtlaSent client.
//
// Panics if Options.APIKey is empty.
func New(opts Options) *Client {
	if opts.APIKey == "" {
		panic("atlasent: APIKey is required")
	}
	baseURL := opts.BaseURL
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	hc := opts.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: timeout}
	}
	c := &Client{
		apiKey:     opts.APIKey,
		baseURL:    baseURL,
		httpClient: hc,
	}
	c.EvidenceBundles = &EvidenceBundleClient{c: c}
	c.SCIM = &SCIMClient{users: &SCIMUsersClient{c: c}, groups: &SCIMGroupsClient{c: c}}
	c.SCIM.Users = c.SCIM.users
	c.SCIM.Groups = c.SCIM.groups
	c.Auth = &AuthClient{c: c}
	return c
}

// ─── Core HTTP helpers ────────────────────────────────────────────────────────

func (c *Client) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	u, err := url.JoinPath(c.baseURL, path)
	if err != nil {
		return nil, fmt.Errorf("atlasent: build URL: %w", err)
	}
	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("atlasent: marshal body: %w", err)
		}
		bodyReader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("atlasent: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "atlasent-go/"+SDKVersion)
	req.Header.Set("X-AtlaSent-Protocol-Version", "1")
	return c.httpClient.Do(req)
}

func (c *Client) post(ctx context.Context, path string, body any, out any) error {
	resp, err := c.do(ctx, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close() //nolint:errcheck
	return decodeResponse(resp, out)
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	resp, err := c.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close() //nolint:errcheck
	return decodeResponse(resp, out)
}

func (c *Client) getBytes(ctx context.Context, path string) ([]byte, error) {
	resp, err := c.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode >= 400 {
		return nil, apiError(resp)
	}
	return io.ReadAll(resp.Body)
}

func decodeResponse(resp *http.Response, out any) error {
	if resp.StatusCode >= 400 {
		return apiError(resp)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// ─── Protect ─────────────────────────────────────────────────────────────────

// ProtectRequest is the input to Protect.
type ProtectRequest struct {
	Agent   string         `json:"actor_id"`
	Action  string         `json:"action_type"`
	Context map[string]any `json:"context,omitempty"`
}

// Permit is returned by Protect when the action is fully authorized.
type Permit struct {
	PermitID   string `json:"permit_id"`
	PermitHash string `json:"permit_hash"`
	AuditHash  string `json:"audit_hash"`
	Reason     string `json:"reason"`
	Timestamp  string `json:"timestamp"`
}

// Protect authorizes an action end-to-end (evaluate + verify). Fail-closed:
// returns a non-nil error if authorization is denied or if any transport or
// server error occurs. The action MUST NOT proceed if err != nil.
func (c *Client) Protect(ctx context.Context, req ProtectRequest) (Permit, error) {
	var evalResp struct {
		Decision    string `json:"decision"`
		PermitToken string `json:"permit_token"`
		AuditHash   string `json:"audit_hash"`
		Reason      string `json:"reason"`
	}
	if err := c.post(ctx, "/v1-evaluate", req, &evalResp); err != nil {
		return Permit{}, fmt.Errorf("atlasent: evaluate: %w", err)
	}
	if evalResp.Decision != "allow" {
		return Permit{}, &DeniedError{
			Decision:    evalResp.Decision,
			EvaluationID: evalResp.PermitToken,
			Reason:      evalResp.Reason,
		}
	}
	var verifyResp struct {
		Valid      bool   `json:"valid"`
		PermitHash string `json:"permit_hash"`
		Timestamp  string `json:"timestamp"`
		Outcome    string `json:"outcome"`
	}
	if err := c.post(ctx, "/v1-verify-permit", map[string]any{
		"permit_token": evalResp.PermitToken,
		"action_type":  req.Action,
		"actor_id":     req.Agent,
	}, &verifyResp); err != nil {
		return Permit{}, fmt.Errorf("atlasent: verify: %w", err)
	}
	if !verifyResp.Valid {
		return Permit{}, &DeniedError{
			Decision: "deny",
			Reason:   fmt.Sprintf("permit failed verification (%s)", verifyResp.Outcome),
		}
	}
	return Permit{
		PermitID:   evalResp.PermitToken,
		PermitHash: verifyResp.PermitHash,
		AuditHash:  evalResp.AuditHash,
		Reason:     evalResp.Reason,
		Timestamp:  verifyResp.Timestamp,
	}, nil
}
